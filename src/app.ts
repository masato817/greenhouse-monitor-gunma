import cron from 'node-cron';
import { ProfinderScraper } from './scrapers/profinder';
import { ProfarmScraper } from './scrapers/profarm';
import { GoogleSheetsService } from './services/sheets';
import { LineMessagingService } from './services/line-messaging';
import { AlertChecker } from './services/alert-checker';
import { DashboardGenerator } from './services/dashboard-generator';
import { GunmaDashboardGenerator } from './services/gunma-dashboard';
import { EnvironmentData } from './types';
import { logger, getEnv } from './utils';
import dotenv from 'dotenv';

dotenv.config();

/**
 * スクレイピング: プロファインダー + プロファーム からデータ取得
 * 失敗はログと failures への集約に留め、取得できた分のみ返す
 */
async function scrapeAllSources(failures: string[]): Promise<EnvironmentData[]> {
  const allData: EnvironmentData[] = [];

  // プロファインダーからデータ取得
  try {
    logger.info('プロファインダーからデータ取得中...');
    const profinderConfig = {
      url: getEnv('PROFINDER_URL', ''),
      username: getEnv('PROFINDER_USER', ''),
      password: getEnv('PROFINDER_PASS', ''),
    };
    const profinderScraper = new ProfinderScraper(profinderConfig, logger);
    const data = await profinderScraper.scrape();

    if (data.length > 0) {
      allData.push(...data);
      logger.info(`プロファインダー: ${data.length}件取得`);
    } else {
      logger.warn('プロファインダー: データ取得件数0');
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`プロファインダーエラー: ${errorMessage}`);
    failures.push(`プロファインダー: ${errorMessage}`);
  }

  // プロファームからデータ取得（1号棟=静岡サングレイス, env 未設定時スキップ）
  const profarmUrl = getEnv('PROFARM_URL', '');
  if (!profarmUrl) {
    logger.info('PROFARM_URL 未設定のためプロファームスクレイピングをスキップします（1号棟取得せず）');
  } else {
    try {
      logger.info('プロファームからデータ取得中...');
      const profarmConfig = {
        url: profarmUrl,
        username: getEnv('PROFARM_USER', ''),
        password: getEnv('PROFARM_PASS', ''),
      };
      const profarmScraper = new ProfarmScraper(profarmConfig, logger);
      const data = await profarmScraper.scrape();

      if (data.length > 0) {
        allData.push(...data);
        logger.info(`プロファーム: ${data.length}件取得`);
      } else {
        logger.warn('プロファーム: データ取得件数0');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`プロファームエラー: ${errorMessage}`);
      failures.push(`プロファーム: ${errorMessage}`);
    }
  }

  return allData;
}

/**
 * スクレイプ結果0件の通知（処理は継続し、Sheetsからの補完を試みる）
 */
async function notifyEmptyScrape(failures: string[]): Promise<void> {
  logger.error('データが取得できませんでした');
  failures.push('スクレイピング: 全ソースで取得0件');

  const lineService = new LineMessagingService();
  try {
    await lineService.send('\n⚠️ データ取得エラー\nスクレイピングでデータを取得できませんでした。スプレッドシートからの補完を試みます。');
  } catch (e) {
    logger.error(`LINE通知エラー: ${e}`);
  }
}

interface FarmSheetData {
  shizuokaData: EnvironmentData[];
  gunmaData: EnvironmentData[];
  shizuokaHistory: EnvironmentData[];
  gunmaHistory: EnvironmentData[];
}

/**
 * Google Sheetsに保存し、ダッシュボード用の最新データ・履歴を農場別に取得する
 */
async function saveAndFetchSheetData(allData: EnvironmentData[], failures: string[]): Promise<FarmSheetData> {
  let shizuokaData: EnvironmentData[] = [];
  let gunmaData: EnvironmentData[] = [];
  let shizuokaHistory: EnvironmentData[] = [];
  let gunmaHistory: EnvironmentData[] = [];

  try {
    const sheetsService = new GoogleSheetsService();
    await sheetsService.saveEnvironmentData(allData);

    // 農場別に最新データを取得（ダッシュボード表示用）
    shizuokaData = await sheetsService.getLatestData('静岡');
    gunmaData = await sheetsService.getLatestData('群馬');
    logger.info(`ダッシュボード生成用データ: 静岡 ${shizuokaData.length}件, 群馬 ${gunmaData.length}件`);

    // 静岡用: 1週間分の履歴を取得（異常期間分析・潅水目安で利用）
    try {
      shizuokaHistory = await sheetsService.getRawHistoryData(10080, '静岡');
      logger.info(`静岡: ${shizuokaHistory.length}件の履歴を取得しました`);
    } catch (e) {
      logger.warn(`静岡履歴取得失敗（継続）: ${e}`);
    }

    // 群馬用: 1週間分の履歴を取得（異常期間分析・潅水目安で利用）
    try {
      gunmaHistory = await sheetsService.getRawHistoryData(10080, '群馬');
      logger.info(`群馬: ${gunmaHistory.length}件の履歴を取得しました`);
    } catch (e) {
      logger.warn(`群馬履歴取得失敗（継続）: ${e}`);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Sheets処理エラー: ${errorMessage}`);
    failures.push(`Sheets処理: ${errorMessage}`);
  }

  return { shizuokaData, gunmaData, shizuokaHistory, gunmaHistory };
}

/**
 * 静岡・群馬のダッシュボード HTML を生成する
 */
async function generateDashboards(sheetData: FarmSheetData, failures: string[]): Promise<void> {
  const { shizuokaData, gunmaData, shizuokaHistory, gunmaHistory } = sheetData;

  // 静岡ダッシュボード生成 (index.html): 既存のリッチ版
  try {
    if (shizuokaData.length > 0) {
      const shizuokaGen = new DashboardGenerator();
      await shizuokaGen.generate(shizuokaData, shizuokaHistory);
    } else {
      logger.warn('静岡データが0件のためindex.html生成をスキップ');
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`静岡ダッシュボード生成エラー: ${errorMessage}`);
    failures.push(`静岡ダッシュボード生成: ${errorMessage}`);
  }

  // 群馬ダッシュボード生成 (gunma.html): 静岡と同等のリッチ版
  try {
    if (gunmaData.length > 0) {
      const gunmaGen = new GunmaDashboardGenerator();
      await gunmaGen.generate(gunmaData, gunmaHistory);
    } else {
      logger.warn('群馬データが0件のためgunma.html生成をスキップ');
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`群馬ダッシュボード生成エラー: ${errorMessage}`);
    failures.push(`群馬ダッシュボード生成: ${errorMessage}`);
  }
}

/**
 * 異常値チェックと通知
 * 注: 定期レポートは廃止。異常時のみAlertCheckerからLINE通知を送信。
 * 詳細はダッシュボード（GitHub Pages）で確認可能。
 */
async function checkAlerts(allData: EnvironmentData[], failures: string[]): Promise<void> {
  try {
    const alertChecker = new AlertChecker();
    await alertChecker.checkAndNotify(allData);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`異常値チェックエラー: ${errorMessage}`);
    failures.push(`異常値チェック: ${errorMessage}`);
  }
}

/**
 * メイン処理: データ取得 → 保存 → ダッシュボード生成 → 異常チェック
 * 各工程の失敗はログと戻り値に集約する。フォールバックのため処理は継続するが、
 * 単発実行（--scrape）では戻り値を exit code に反映して障害検知可能にする
 */
async function main(): Promise<string[]> {
  logger.info('=== 環境モニタリング開始 ===');
  const failures: string[] = [];

  const allData = await scrapeAllSources(failures);
  if (allData.length === 0) {
    await notifyEmptyScrape(failures);
  }

  const sheetData = await saveAndFetchSheetData(allData, failures);
  await generateDashboards(sheetData, failures);
  await checkAlerts(allData, failures);

  if (failures.length > 0) {
    logger.error(`=== 環境モニタリング完了（失敗 ${failures.length} 件: ${failures.join(' / ')}） ===\n`);
  } else {
    logger.info('=== 環境モニタリング完了 ===\n');
  }
  return failures;
}

// 多重実行ガード: スクレイピングが実行間隔を超えて長引いた場合に、
// Puppeteer 起動・Sheets 書込・HTML 生成が並行しないよう実行中はスキップする
let isMainRunning = false;

async function runMainExclusive(trigger: string): Promise<void> {
  if (isMainRunning) {
    logger.warn(`前回の処理が実行中のため今回はスキップします (${trigger})`);
    return;
  }
  isMainRunning = true;
  try {
    await main();
  } catch (err) {
    logger.error(`${trigger}エラー: ${err}`);
  } finally {
    isMainRunning = false;
  }
}

/**
 * 定期実行モード
 */
function startScheduler(): void {
  const intervalMinutes = parseInt(getEnv('SCRAPE_INTERVAL_MINUTES', '30'), 10);

  // cron式を生成（例: 30分間隔 → "*/30 * * * *"）
  const cronExpression = `*/${intervalMinutes} * * * *`;

  logger.info(`スケジューラー開始: ${intervalMinutes}分間隔で実行`);
  logger.info(`cron式: ${cronExpression}`);

  // 起動時に1回実行
  void runMainExclusive('初回実行');

  // 定期実行
  cron.schedule(cronExpression, () => {
    void runMainExclusive('定期実行');
  });

  // 日次クリーンアップ（毎日 0:00）
  cron.schedule('0 0 * * *', async () => {
    logger.info('=== 日次クリーンアップ開始 ===');
    try {
      const sheetsService = new GoogleSheetsService();
      // 環境変数で保持日数を設定可能（デフォルト: 365日）
      const retentionDays = parseInt(getEnv('DATA_RETENTION_DAYS', '365'), 10);
      await sheetsService.deleteOldData(retentionDays);
    } catch (err) {
      logger.error(`日次クリーンアップエラー: ${err}`);
    }
    logger.info('=== 日次クリーンアップ完了 ===');
  });

  logger.info('定期実行を待機中...');
}

/**
 * コマンドライン引数の処理
 */
const args = process.argv.slice(2);

if (args.includes('--scrape')) {
  // 単発実行モード
  main()
    .then(failures => process.exit(failures.length > 0 ? 1 : 0))
    .catch(err => {
      logger.error(`実行エラー: ${err}`);
      process.exit(1);
    });
} else if (args.includes('--init')) {
  // シート初期化モード
  const sheetsService = new GoogleSheetsService();
  sheetsService
    .initializeSheets()
    .then(() => {
      logger.info('シート初期化完了');
      process.exit(0);
    })
    .catch(err => {
      logger.error(`初期化エラー: ${err}`);
      process.exit(1);
    });
} else {
  // デフォルト: スケジューラーモード
  startScheduler();
}
