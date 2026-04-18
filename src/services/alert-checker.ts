import { EnvironmentData, ThresholdConfig, ThresholdMap } from '../types';
import { logger, roundTo, resolveHouseName } from '../utils';
import { GoogleSheetsService } from './sheets';
import { LineMessagingService } from './line-messaging';

/**
 * アラートチェック結果
 */
interface AlertResult {
  location: string;
  item: string;
  itemDisplayName: string;
  value: number;
  thresholdMin: number;
  thresholdMax: number;
  type: 'high' | 'low';
}

/**
 * アラートチェッカー
 * 閾値マスターに基づいて異常を検出し、LINE通知を送信
 */
export class AlertChecker {
  private sheetsService: GoogleSheetsService;
  private lineService: LineMessagingService;
  private thresholds: ThresholdMap = {};
  /** Google Sheetsから読み込んだ最終通知時刻（プロセス再起動でも保持） */
  private lastAlertTimes: Map<string, Date> = new Map();

  // 同一アラートの再通知間隔（分）
  private readonly COOLDOWN_MINUTES = 30;
  private readonly ALERT_HISTORY_SHEET = 'アラート履歴';
  private readonly ALERT_HISTORY_HEADERS = ['日時', 'キー', '場所', '項目', '値', '閾値下限', '閾値上限', '種別'];

  constructor() {
    this.sheetsService = new GoogleSheetsService();
    this.lineService = new LineMessagingService();
  }

  /**
   * 環境データをチェックして、異常があればLINE通知を送信
   */
  async checkAndNotify(dataList: EnvironmentData[]): Promise<void> {
    logger.info(`Checking ${dataList.length} records for anomalies...`);

    // アラート履歴シートから最終通知時刻を復元（プロセス再起動対策）
    await this.loadLastAlertTimes();

    // 閾値マスターを取得
    this.thresholds = await this.sheetsService.getThresholds();
    const thresholdCount = Object.keys(this.thresholds).length;
    
    if (thresholdCount === 0) {
      logger.warn('閾値マスターにデータがありません。デフォルト閾値を使用します。');
    } else {
      logger.info(`閾値マスターから ${thresholdCount} 件の設定を読み込みました`);
    }

    const allAlerts: AlertResult[] = [];

    for (const data of dataList) {
      const alerts = this.detectAnomalies(data);
      if (alerts.length > 0) {
        allAlerts.push(...alerts);
        logger.warn(`Anomaly detected at ${data.location}: ${alerts.map(a => `${a.itemDisplayName}=${a.value}`).join(', ')}`);
      }
    }

    // 異常がある場合のみLINE通知
    if (allAlerts.length > 0) {
      await this.sendAlertNotification(allAlerts);
    } else {
      logger.info('異常は検出されませんでした');
    }
  }

  /**
   * 単一のデータから異常を検出
   */
  private detectAnomalies(data: EnvironmentData): AlertResult[] {
    const alerts: AlertResult[] = [];
    const month = data.timestamp.getMonth() + 1; // 1-12
    
    // ハウス名を特定
    const house = resolveHouseName(data);
    if (!house) return alerts;

    // チェック対象の項目とデータキーのマッピング
    const checkItems = [
      { key: 'temperature', name: '気温(℃)', displayName: '気温' },
      { key: 'humidity', name: '湿度(%)', displayName: '湿度' },
      { key: 'co2', name: 'CO2(ppm)', displayName: 'CO2' },
    ];

    for (const item of checkItems) {
      const value = (data as any)[item.key];
      if (value === undefined || value === null) continue;
      
      const numValue = Number(value);
      if (isNaN(numValue)) continue;

      // 閾値を取得（キー形式: "月-ハウス-項目"）
      // sheets.tsのgetThresholds()で生成されるキーにスペースが含まれる問題を修正
      const thresholdKey = `${month}-${house}-${item.name}`;
      // スペースありのキーも試す（既存データ互換性）
      const thresholdKeyWithSpaces = `${month} -${house} -${item.name} `;
      
      const threshold = this.thresholds[thresholdKey] || this.thresholds[thresholdKeyWithSpaces];
      
      if (!threshold) {
        // 閾値が設定されていない場合はデフォルト閾値を使用
        const defaultThreshold = this.getDefaultThreshold(item.key);
        if (defaultThreshold) {
          this.checkAndAddAlert(alerts, data.location, item, numValue, defaultThreshold.min, defaultThreshold.max);
        }
        continue;
      }

      this.checkAndAddAlert(alerts, data.location, item, numValue, threshold.minValue, threshold.maxValue);
    }

    return alerts;
  }

  /**
   * 閾値チェックを行い、異常があればアラートリストに追加
   */
  private checkAndAddAlert(
    alerts: AlertResult[], 
    location: string, 
    item: { key: string; name: string; displayName: string }, 
    value: number, 
    minValue: number, 
    maxValue: number
  ): void {
    if (value > maxValue) {
      alerts.push({
        location,
        item: item.key,
        itemDisplayName: item.displayName,
        value: roundTo(value, 1),
        thresholdMin: minValue,
        thresholdMax: maxValue,
        type: 'high'
      });
    } else if (value < minValue) {
      alerts.push({
        location,
        item: item.key,
        itemDisplayName: item.displayName,
        value: roundTo(value, 1),
        thresholdMin: minValue,
        thresholdMax: maxValue,
        type: 'low'
      });
    }
  }

  /**
   * デフォルト閾値を取得
   */
  private getDefaultThreshold(itemKey: string): { min: number; max: number } | null {
    const now = new Date();
    const hour = now.getHours();
    const isDaytime = hour >= 6 && hour < 17;

    switch (itemKey) {
      case 'temperature':
        return isDaytime ? { min: 18, max: 32 } : { min: 12, max: 25 };
      case 'humidity':
        return { min: 50, max: 85 };
      case 'co2':
        return isDaytime ? { min: 400, max: 1500 } : null; // 夜間はCO2チェックしない
      default:
        return null;
    }
  }

  /**
   * LINE通知を送信（クールダウン機能付き）
   */
  private async sendAlertNotification(alerts: AlertResult[]): Promise<void> {
    const now = new Date();
    const alertsToSend: AlertResult[] = [];

    for (const alert of alerts) {
      // クールダウンキー（場所+項目の組み合わせ）
      const cooldownKey = `${alert.location}-${alert.item}`;
      const lastAlertTime = this.lastAlertTimes.get(cooldownKey);

      if (lastAlertTime) {
        const diffMinutes = (now.getTime() - lastAlertTime.getTime()) / (1000 * 60);
        if (diffMinutes < this.COOLDOWN_MINUTES) {
          logger.info(`Alert for ${cooldownKey} is in cooldown (${Math.round(diffMinutes)}min since last alert)`);
          continue;
        }
      }

      alertsToSend.push(alert);
      this.lastAlertTimes.set(cooldownKey, now);
    }

    if (alertsToSend.length === 0) {
      logger.info('全てのアラートがクールダウン中のため、通知をスキップしました');
      return;
    }

    // メッセージを構築
    const message = this.buildAlertMessage(alertsToSend);
    
    try {
      await this.lineService.send(message);
      logger.info(`${alertsToSend.length}件の異常をLINE通知しました`);

      // 通知履歴をGoogle Sheetsに記録（クールダウン永続化）
      await this.saveAlertHistory(alertsToSend, now);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(`LINE通知の送信に失敗しました: ${errorMsg}`);
    }
  }

  /**
   * Google Sheetsのアラート履歴から最終通知時刻を復元
   * --scrapeモード（毎回プロセス終了）でもクールダウンが機能する
   */
  private async loadLastAlertTimes(): Promise<void> {
    try {
      const sheets = this.sheetsService.getSheetsClient();
      const spreadsheetId = this.sheetsService.getSpreadsheetId();

      const response = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${this.ALERT_HISTORY_SHEET}!A2:B`,
      });

      const rows = response.data.values;
      if (!rows || rows.length === 0) return;

      // 各キーの最新の通知時刻のみ保持
      for (const row of rows) {
        const timestampStr = row[0];
        const key = row[1];
        if (!timestampStr || !key) continue;

        const ts = new Date(timestampStr);
        if (isNaN(ts.getTime())) continue;

        const existing = this.lastAlertTimes.get(key);
        if (!existing || ts > existing) {
          this.lastAlertTimes.set(key, ts);
        }
      }

      logger.info(`アラート履歴から ${this.lastAlertTimes.size} 件のクールダウン情報を復元`);
    } catch (error) {
      // シートが存在しない場合はスキップ（初回実行時など）
      logger.warn(`アラート履歴の読み込みをスキップ: ${error}`);
    }
  }

  /**
   * 通知したアラートをGoogle Sheetsに記録
   */
  private async saveAlertHistory(alerts: AlertResult[], timestamp: Date): Promise<void> {
    try {
      const sheets = this.sheetsService.getSheetsClient();
      const spreadsheetId = this.sheetsService.getSpreadsheetId();

      const rows = alerts.map(a => [
        timestamp.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }),
        `${a.location}-${a.item}`,
        a.location,
        a.itemDisplayName,
        a.value,
        a.thresholdMin,
        a.thresholdMax,
        a.type === 'high' ? '上限超過' : '下限未満',
      ]);

      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${this.ALERT_HISTORY_SHEET}!A1`,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: rows },
      });

      logger.info(`アラート履歴に ${rows.length} 件記録`);
    } catch (error) {
      logger.error(`アラート履歴の保存に失敗: ${error}`);
    }
  }

  /**
   * アラートメッセージを構築
   */
  private buildAlertMessage(alerts: AlertResult[]): string {
    const lines: string[] = [
      '🚨 環境異常アラート',
      ''
    ];

    for (const alert of alerts) {
      const icon = alert.type === 'high' ? '🔺' : '🔻';
      const typeText = alert.type === 'high' ? '上限超過' : '下限未満';
      
      lines.push(`${icon}【${alert.location}】${alert.itemDisplayName} ${typeText}`);
      lines.push(`　現在値: ${alert.value}`);
      lines.push(`　基準値: ${alert.thresholdMin}〜${alert.thresholdMax}`);
      lines.push('');
    }

    lines.push('📊 詳細はダッシュボードで確認');
    lines.push('https://sangrace.github.io/greenhouse-monitor/');

    return lines.join('\n');
  }
}
