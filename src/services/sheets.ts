import { google, sheets_v4 } from 'googleapis';
import { GoogleAuth } from 'google-auth-library';
import { EnvironmentData, WateringGuideMark, WateringGuideHistory, ThresholdConfig, ThresholdMap } from '../types';
import { logger, getEnvOrThrow, getEnv, formatJapanese, Farm, ALL_FARMS, resolveFarm } from '../utils';

/**
 * シートのプロパティ型（簡易定義）
 */
interface SheetProperties {
  sheetId?: number;
  title?: string;
}

export class GoogleSheetsService {
  private auth: GoogleAuth;
  private spreadsheetId: string;
  private sheets: sheets_v4.Sheets;

  // 農場別シート: 『{農場}_環境データ』『{農場}_潅水目安履歴』
  // 旧実装の互換用として SHEET_NAME / WATERING_GUIDE_SHEET 相当は廃止し、
  // dataSheetName(farm) / wateringSheetName(farm) で都度解決する。
  private readonly DATA_SHEET_SUFFIX = '環境データ';
  private readonly WATERING_SHEET_SUFFIX = '潅水目安履歴';
  private readonly THRESHOLD_SHEET = '閾値マスター';

  private dataSheetName(farm: Farm): string {
    return `${farm}_${this.DATA_SHEET_SUFFIX}`;
  }
  private wateringSheetName(farm: Farm): string {
    return `${farm}_${this.WATERING_SHEET_SUFFIX}`;
  }
  private readonly HEADERS = [
    '日時', 'ソース', '場所',
    '温度', '湿度', 'CO2', '日射量', '積算日射量', '飽差',
    '最高気温', '最低気温', '24h平均気温', '昼平均', '夜平均', '前日昼', '前日夜', '昼夜差',
    '風速', '前日積算日射', '48h平均', '72h平均', '外気温度', '風向', '日の出', '日の入',
    '点灯開始時間', '点灯終了時間'
  ];
  private readonly WATERING_GUIDE_HEADERS = [
    '日付', 'マーク番号', '時刻', '積算日射量(MJ)', 'ターゲットMJ', '差分(MJ)', '本日総日射量(MJ)'
  ];
  private readonly THRESHOLD_HEADERS = [
    '月', 'ハウス', '項目', '最小値', '最大値', '備考'
  ];
  private readonly HOUSE_CONFIG_SHEET = 'ハウス設定';
  private readonly HOUSE_CONFIG_HEADERS = [
    'ハウス名', '面積(m2)', '点灯開始時間', '点灯終了時間'
  ];
  private readonly ALERT_HISTORY_SHEET = 'アラート履歴';
  private readonly ALERT_HISTORY_HEADERS = [
    '日時', 'キー', '場所', '項目', '値', '閾値下限', '閾値上限', '種別'
  ];



  constructor() {
    this.spreadsheetId = getEnvOrThrow('SPREADSHEET_ID');
    const keyFile = getEnv('GOOGLE_SERVICE_ACCOUNT_KEY', './credentials/service-account.json');

    this.auth = new google.auth.GoogleAuth({
      keyFile: keyFile,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    this.sheets = google.sheets({ version: 'v4', auth: this.auth });
  }

  /** Sheets APIクライアントを外部から参照する（AlertChecker等で使用） */
  getSheetsClient(): sheets_v4.Sheets {
    return this.sheets;
  }

  /** スプレッドシートIDを外部から参照する */
  getSpreadsheetId(): string {
    return this.spreadsheetId;
  }

  async initializeSheets(): Promise<void> {
    try {
      logger.info('Initializing Google Sheets (farm-split mode)...');

      const metadata = await this.sheets.spreadsheets.get({
        spreadsheetId: this.spreadsheetId,
      });

      const existingTitles = new Set<string>(
        (metadata.data.sheets || [])
          .map((s: sheets_v4.Schema$Sheet) => s.properties?.title || '')
          .filter(Boolean)
      );

      // 農場別 『環境データ』シート
      for (const farm of ALL_FARMS) {
        const sheetName = this.dataSheetName(farm);
        if (!existingTitles.has(sheetName)) {
          logger.info(`Sheet "${sheetName}" not found. Creating...`);
          await this.sheets.spreadsheets.batchUpdate({
            spreadsheetId: this.spreadsheetId,
            requestBody: {
              requests: [{ addSheet: { properties: { title: sheetName } } }],
            },
          });
          await this.sheets.spreadsheets.values.update({
            spreadsheetId: this.spreadsheetId,
            range: `${sheetName}!A1`,
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: [this.HEADERS] },
          });
          logger.info(`Sheet "${sheetName}" created with headers.`);
        } else {
          logger.info(`Sheet "${sheetName}" already exists.`);
        }
      }

      await this.initializeWateringGuideSheet();
      await this.initializeThresholdSheet();
      await this.initializeHouseConfigSheet();
      await this.initializeAlertHistorySheet();

    } catch (error) {
      logger.error(`Failed to initialize sheets: ${error}`);
      throw error;
    }
  }

  async saveEnvironmentData(data: EnvironmentData[]): Promise<void> {
    if (data.length === 0) return;

    // 農場別にグルーピング
    const byFarm = new Map<Farm, EnvironmentData[]>();
    for (const d of data) {
      const farm = resolveFarm(d);
      if (!byFarm.has(farm)) byFarm.set(farm, []);
      byFarm.get(farm)!.push(d);
    }

    for (const [farm, items] of byFarm) {
      await this.appendDataToFarmSheet(farm, items);
    }
  }

  /**
   * 指定農場の 環境データ シートに行を追記する (内部実装)
   */
  private async appendDataToFarmSheet(farm: Farm, data: EnvironmentData[]): Promise<void> {
    const sheetName = this.dataSheetName(farm);
    logger.info(`Saving ${data.length} records to "${sheetName}"...`);

    const rows = data.map(d => [
      formatJapanese(d.timestamp, 'yyyy/MM/dd HH:mm:ss'),
      d.source,
      d.location,
      d.temperature ?? '',
      d.humidity ?? '',
      d.co2 ?? '',
      d.solarRadiation ?? '',
      d.accumulatedSolarRadiation ?? '',
      d.vpd ?? '',
      d.todayMaxTemp ?? d.maxTemp ?? '',
      d.todayMinTemp ?? d.minTemp ?? '',
      d.avgTemp24h ?? '',
      d.dayAvgTemp ?? '',
      d.nightAvgTemp ?? '',
      d.prevDayAvgTemp ?? '',
      d.prevNightAvgTemp ?? '',
      d.diffDayNight ?? '',
      d.windSpeed ?? '',
      d.yesterdayAccumulatedSolar ?? '',
      d.avgTemp48h ?? '',
      d.avgTemp72h ?? '',
      d.outsideTemperature ?? '',
      d.windDirection ?? '',
      d.sunrise ?? '',
      d.sunset ?? '',
      d.lightingStartTime ?? '',
      d.lightingEndTime ?? ''
    ]);

    try {
      await this.sheets.spreadsheets.values.append({
        spreadsheetId: this.spreadsheetId,
        range: `${sheetName}!A1`,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: {
          values: rows,
        },
      });
      logger.info(`Success: ${data.length} records appended to "${sheetName}".`);
    } catch (error) {
      logger.error(`Failed to save data to "${sheetName}": ${error}`);
      throw error;
    }
  }

  async getLatestData(farm?: Farm): Promise<EnvironmentData[]> {
    // farm指定なしの場合は両農場をマージ
    const targets: Farm[] = farm ? [farm] : ALL_FARMS;
    const merged: EnvironmentData[] = [];
    for (const f of targets) {
      merged.push(...await this.getLatestDataForFarm(f));
    }
    return merged;
  }

  private async getLatestDataForFarm(farm: Farm): Promise<EnvironmentData[]> {
    const sheetName = this.dataSheetName(farm);
    try {
      logger.info(`Fetching latest data from "${sheetName}"...`);

      const timestampResponse = await this.sheets.spreadsheets.values.get({
        spreadsheetId: this.spreadsheetId,
        range: `${sheetName}!A2:A`,
      });

      const timestampRows = timestampResponse.data.values;
      const totalDataRows = timestampRows ? timestampRows.length : 0;

      if (totalDataRows === 0) {
        logger.warn(`No data found in "${sheetName}".`);
        return [];
      }

      const limit = 150;
      let startRow = 2 + totalDataRows - limit;
      if (startRow < 2) startRow = 2;

      const range = `${sheetName}!A${startRow}:AA`;
      logger.info(`Fetching latest data optimized range: ${range}`);

      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId: this.spreadsheetId,
        range: range,
      });

      const rows = response.data.values;
      if (!rows || rows.length === 0) {
        return [];
      }

      // 取得データは既に最近のデータ (最大150件) なので、location別に最新を選ぶ
      const latestMap = new Map<string, EnvironmentData>();
      for (const row of rows) {
        const data = this.parseRow(row);
        if (!data) continue;
        latestMap.set(data.location, data);
      }

      const results = Array.from(latestMap.values());
      logger.info(`Retrieved latest data for ${results.length} locations from "${sheetName}".`);
      return results;

    } catch (error) {
      logger.error(`Failed to get latest data from "${sheetName}": ${error} `);
      return [];
    }
  }

  async getRawHistoryData(limit: number = 150, farm?: Farm): Promise<EnvironmentData[]> {
    const targets: Farm[] = farm ? [farm] : ALL_FARMS;
    const merged: EnvironmentData[] = [];
    for (const f of targets) {
      merged.push(...await this.getRawHistoryDataForFarm(f, limit));
    }
    return merged;
  }

  private async getRawHistoryDataForFarm(farm: Farm, limit: number): Promise<EnvironmentData[]> {
    const sheetName = this.dataSheetName(farm);
    try {
      logger.info(`Fetching last ${limit} rows of history from "${sheetName}"...`);

      const timestampResponse = await this.sheets.spreadsheets.values.get({
        spreadsheetId: this.spreadsheetId,
        range: `${sheetName}!A2:A`,
      });

      const timestampRows = timestampResponse.data.values;
      const totalDataRows = timestampRows ? timestampRows.length : 0;

      if (totalDataRows === 0) {
        return [];
      }

      let startRow = 2 + totalDataRows - limit;
      if (startRow < 2) startRow = 2;

      const range = `${sheetName}!A${startRow}:AA`;
      logger.info(`Fetching optimized range: ${range}`);

      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId: this.spreadsheetId,
        range: range,
      });

      const rows = response.data.values;
      if (!rows || rows.length === 0) {
        return [];
      }

      const results: EnvironmentData[] = [];
      for (const row of rows) {
        const data = this.parseRow(row);
        if (data) results.push(data);
      }
      return results;

    } catch (error) {
      logger.error(`Failed to get history data from "${sheetName}": ${error} `);
      return [];
    }
  }

  private parseNum(val: string | undefined): number | undefined {
    if (!val || val === '') return undefined;
    const num = parseFloat(val);
    return isNaN(num) ? undefined : num;
  }

  /**
   * スプレッドシートの1行をEnvironmentDataに変換する共通メソッド
   * getLatestData / getRawHistoryData で共通利用
   */
  private parseRow(row: string[]): EnvironmentData | null {
    const timestampStr = row[0];
    const location = row[2];
    if (!timestampStr || !location) return null;

    const timestamp = new Date(timestampStr);
    if (isNaN(timestamp.getTime())) return null;

    return {
      timestamp,
      source: row[1] as 'profarm' | 'profinder',
      location,
      temperature: this.parseNum(row[3]),
      humidity: this.parseNum(row[4]),
      co2: this.parseNum(row[5]),
      solarRadiation: this.parseNum(row[6]),
      accumulatedSolarRadiation: this.parseNum(row[7]),
      vpd: this.parseNum(row[8]),
      todayMaxTemp: this.parseNum(row[9]),
      todayMinTemp: this.parseNum(row[10]),
      avgTemp24h: this.parseNum(row[11]),
      dayAvgTemp: this.parseNum(row[12]),
      nightAvgTemp: this.parseNum(row[13]),
      prevDayAvgTemp: this.parseNum(row[14]),
      prevNightAvgTemp: this.parseNum(row[15]),
      diffDayNight: this.parseNum(row[16]),
      windSpeed: this.parseNum(row[17]),
      yesterdayAccumulatedSolar: this.parseNum(row[18]),
      avgTemp48h: this.parseNum(row[19]),
      avgTemp72h: this.parseNum(row[20]),
      outsideTemperature: this.parseNum(row[21]),
      windDirection: row[22],
      sunrise: row[23],
      sunset: row[24],
      lightingStartTime: row[25],
      lightingEndTime: row[26],
    };
  }

  // ========== 潅水目安履歴関連のメソッド ==========

  async initializeWateringGuideSheet(): Promise<void> {
    try {
      logger.info('Initializing Watering Guide History Sheets (farm-split)...');

      const metadata = await this.sheets.spreadsheets.get({
        spreadsheetId: this.spreadsheetId,
      });

      const existingTitles = new Set<string>(
        (metadata.data.sheets || [])
          .map((s: sheets_v4.Schema$Sheet) => s.properties?.title || '')
          .filter(Boolean)
      );

      for (const farm of ALL_FARMS) {
        const sheetName = this.wateringSheetName(farm);
        if (!existingTitles.has(sheetName)) {
          logger.info(`Sheet "${sheetName}" not found. Creating...`);
          await this.sheets.spreadsheets.batchUpdate({
            spreadsheetId: this.spreadsheetId,
            requestBody: {
              requests: [{ addSheet: { properties: { title: sheetName } } }],
            },
          });
          await this.sheets.spreadsheets.values.update({
            spreadsheetId: this.spreadsheetId,
            range: `${sheetName}!A1`,
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: [this.WATERING_GUIDE_HEADERS] },
          });
          logger.info(`Sheet "${sheetName}" created with headers.`);
        } else {
          logger.info(`Sheet "${sheetName}" already exists.`);
        }
      }
    } catch (error) {
      logger.error(`Failed to initialize watering guide sheet: ${error} `);
      throw error;
    }
  }

  async saveWateringGuide(farm: Farm, date: string, marks: WateringGuideMark[], dailyTotalSolar?: number): Promise<void> {
    const sheetName = this.wateringSheetName(farm);
    try {
      if (marks.length === 0) {
        logger.info('No watering guide marks to save.');
        return;
      }

      logger.info(`Saving ${marks.length} watering guide marks for ${date} to "${sheetName}"...`);

      // まず、今日のデータがあれば削除
      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId: this.spreadsheetId,
        range: `${sheetName}!A2:F`,
      });

      const rows = response.data.values || [];
      const todayRows: number[] = [];

      rows.forEach((row: string[], index: number) => {
        if (row[0] === date) {
          todayRows.push(index + 2); // +2: row1=header, index=0-based
        }
      });

      // 今日のデータを削除
      if (todayRows.length > 0) {
        logger.info(`Deleting ${todayRows.length} existing rows for ${date} in "${sheetName}"...`);
        const sheetId = await this.getSheetId(sheetName);
        const requests = todayRows.reverse().map(rowIndex => ({
          deleteDimension: {
            range: {
              sheetId: sheetId,
              dimension: 'ROWS',
              startIndex: rowIndex - 1,
              endIndex: rowIndex,
            },
          },
        }));

        await this.sheets.spreadsheets.batchUpdate({
          spreadsheetId: this.spreadsheetId,
          requestBody: { requests },
        });
      }

      const newRows = marks.map(mark => [
        date,
        mark.number,
        mark.time,
        mark.mj,
        mark.targetMJ,
        mark.diff ?? '',
        dailyTotalSolar ?? '',
      ]);

      await this.sheets.spreadsheets.values.append({
        spreadsheetId: this.spreadsheetId,
        range: `${sheetName}!A1`,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: {
          values: newRows,
        },
      });

      logger.info(`Successfully saved ${marks.length} marks for ${date} to "${sheetName}".`);
    } catch (error) {
      logger.error(`Failed to save watering guide to "${sheetName}": ${error} `);
      throw error;
    }
  }

  async getWateringGuideHistory(farm: Farm, days: number = 7): Promise<WateringGuideHistory[]> {
    const sheetName = this.wateringSheetName(farm);
    try {
      logger.info(`Fetching watering guide history (${days} days) from "${sheetName}"...`);

      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId: this.spreadsheetId,
        range: `${sheetName}!A2:G`,
      });

      const rows = response.data.values;
      if (!rows || rows.length === 0) {
        logger.info('No watering guide history found.');
        return [];
      }

      // 日付でグループ化
      const historyMap = new Map<string, WateringGuideMark[]>();

      for (const row of rows) {
        const date = row[0];
        const mark: WateringGuideMark = {
          number: parseInt(row[1]) || 0,
          time: row[2] || '',
          mj: parseFloat(row[3]) || 0,
          targetMJ: row[4] || '',
          diff: row[5] ? parseFloat(row[5]) : null,
        };

        if (!historyMap.has(date)) {
          historyMap.set(date, []);
        }
        historyMap.get(date)!.push(mark);
      }

      // Daily summaries map (date -> {total, postSunset})
      const dailySummaries = new Map<string, { dailyTotalSolar?: number, postSunsetSolar?: number }>();
      for (const row of rows) {
        const date = row[0];
        if (!dailySummaries.has(date)) {
          dailySummaries.set(date, {
            dailyTotalSolar: row[6] ? parseFloat(row[6]) : undefined
          });
        }
      }

      // 過去N日分のデータのみ取得 (昨日から過去N日分)
      // JST midnight logic
      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()); // Today 00:00:00

      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1); // Yesterday 00:00:00

      const cutoffDate = new Date(yesterday);
      cutoffDate.setDate(cutoffDate.getDate() - (days - 1)); // 7 days inclusive: Yesterday - 6 days

      logger.info(`History Filter: Today=${today.toLocaleDateString()}, Yesterday=${yesterday.toLocaleDateString()}, Cutoff=${cutoffDate.toLocaleDateString()}`);

      const results: WateringGuideHistory[] = [];

      historyMap.forEach((marks, dateStr) => {
        // dateStr is likely "YYYY-MM-DD" or similar from the sheet.
        // Parse it safely.
        const d = new Date(dateStr);
        // Reset time to midnight for comparison
        const checkDate = new Date(d.getFullYear(), d.getMonth(), d.getDate());

        // Logic: Cutoff <= CheckDate <= Yesterday
        if (checkDate >= cutoffDate && checkDate <= yesterday) {
          results.push({
            date: dateStr,
            marks: marks.sort((a, b) => a.number - b.number),
            dailyTotalSolar: dailySummaries.get(dateStr)?.dailyTotalSolar
          });
        }
      });

      // 日付降順でソート
      results.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

      logger.info(`Retrieved ${results.length} days of watering guide history.`);
      return results;
    } catch (error) {
      logger.error(`Failed to get watering guide history: ${error} `);
      return [];
    }
  }

  private async getSheetId(sheetName: string): Promise<number> {
    const metadata = await this.sheets.spreadsheets.get({
      spreadsheetId: this.spreadsheetId,
    });

    const sheet = metadata.data.sheets?.find(
      (s: sheets_v4.Schema$Sheet) => s.properties?.title === sheetName
    );

    return sheet?.properties?.sheetId ?? 0;
  }

  // ========== 閾値マスター関連のメソッド ==========

  /**
   * 閾値マスターシートを初期化
   */
  async initializeThresholdSheet(): Promise<void> {
    try {
      logger.info('Initializing Threshold Master Sheet...');

      const metadata = await this.sheets.spreadsheets.get({
        spreadsheetId: this.spreadsheetId,
      });

      const sheetExists = metadata.data.sheets?.some(
        (s: sheets_v4.Schema$Sheet) => s.properties?.title === this.THRESHOLD_SHEET
      );

      if (!sheetExists) {
        logger.info(`Sheet "${this.THRESHOLD_SHEET}" not found.Creating...`);
        await this.sheets.spreadsheets.batchUpdate({
          spreadsheetId: this.spreadsheetId,
          requestBody: {
            requests: [
              {
                addSheet: {
                  properties: { title: this.THRESHOLD_SHEET },
                },
              },
            ],
          },
        });

        // Add headers
        await this.sheets.spreadsheets.values.update({
          spreadsheetId: this.spreadsheetId,
          range: `${this.THRESHOLD_SHEET}!A1`,
          valueInputOption: 'USER_ENTERED',
          requestBody: {
            values: [this.THRESHOLD_HEADERS],
          },
        });
        logger.info('Threshold Master sheet created and headers added.');
      } else {
        logger.info(`Sheet "${this.THRESHOLD_SHEET}" already exists.`);
      }
    } catch (error) {
      logger.error(`Failed to initialize threshold sheet: ${error} `);
      throw error;
    }
  }

  /**
   * 閾値データを取得してマップ形式で返す
   * @returns ThresholdMap - キー形式: "月-ハウス-項目"
   */
  async getThresholds(): Promise<ThresholdMap> {
    try {
      logger.info('Fetching thresholds from Google Sheets...');

      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId: this.spreadsheetId,
        range: `${this.THRESHOLD_SHEET}!A2:F`,
      });

      const rows = response.data.values;
      if (!rows || rows.length === 0) {
        logger.info('No threshold data found in sheet.');
        return {};
      }

      const thresholdMap: ThresholdMap = {};

      for (const row of rows) {
        const month = parseInt(row[0]);
        const house = row[1];
        const item = row[2];
        const minValue = parseFloat(row[3]);
        const maxValue = parseFloat(row[4]);
        const note = row[5];

        // データ検証
        if (isNaN(month) || !house || !item || isNaN(minValue) || isNaN(maxValue)) {
          logger.warn(`Invalid threshold data: ${JSON.stringify(row)} `);
          continue;
        }

        // キー生成: "月-ハウス-項目"
        const key = `${month}-${house}-${item}`;

        thresholdMap[key] = {
          month,
          house,
          item,
          minValue,
          maxValue,
          note,
        };
      }

      logger.info(`Retrieved ${Object.keys(thresholdMap).length} threshold configurations.`);
      return thresholdMap;
    } catch (error) {
      logger.error(`Failed to get thresholds: ${error} `);
      return {};
    }
  }

  // ========== 閾値マスター関連のメソッド ==========

  /**
   * 指定した日数より古いデータを削除します
   * @param retentionDays 保持する日数（これより古いデータを削除）
   */
  async deleteOldData(retentionDays: number): Promise<void> {
    try {
      logger.info(`Checking for data older than ${retentionDays} days to delete...`);

      // 基準日を計算
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
      cutoffDate.setHours(0, 0, 0, 0);

      logger.info(`Deletion cutoff date: ${cutoffDate.toLocaleString()}`);

      // 農場別に個別処理
      for (const farm of ALL_FARMS) {
        await this.deleteOldDataForFarm(farm, cutoffDate, retentionDays);
      }
    } catch (error) {
      logger.error(`Failed to delete old data: ${error}`);
    }
  }

  private async deleteOldDataForFarm(farm: Farm, cutoffDate: Date, retentionDays: number): Promise<void> {
    const sheetName = this.dataSheetName(farm);
    try {
      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId: this.spreadsheetId,
        range: `${sheetName}!A2:A`,
      });

      const rows = response.data.values;
      if (!rows || rows.length === 0) {
        logger.info(`No data found to clean up in "${sheetName}".`);
        return;
      }

      let deleteCount = 0;
      for (let i = 0; i < rows.length; i++) {
        const timestampStr = rows[i][0];
        if (!timestampStr) continue;
        const date = new Date(timestampStr);
        if (!isNaN(date.getTime()) && date < cutoffDate) {
          deleteCount++;
        } else {
          break; // 古い順なので終了
        }
      }

      if (deleteCount > 0) {
        logger.info(`"${sheetName}": ${deleteCount} rows older than ${retentionDays} days. Deleting...`);
        await this.sheets.spreadsheets.batchUpdate({
          spreadsheetId: this.spreadsheetId,
          requestBody: {
            requests: [{
              deleteDimension: {
                range: {
                  sheetId: await this.getSheetId(sheetName),
                  dimension: 'ROWS',
                  startIndex: 1,
                  endIndex: 1 + deleteCount
                }
              }
            }]
          }
        });
        logger.info(`"${sheetName}": Deleted ${deleteCount} rows.`);
      } else {
        logger.info(`"${sheetName}": no data needs deletion.`);
      }
    } catch (e) {
      logger.error(`Failed to delete old data in "${sheetName}": ${e}`);
    }
  }

  // ========== ハウス設定関連のメソッド ==========

  async initializeHouseConfigSheet(): Promise<void> {
    try {
      logger.info('Initializing House Config Sheet...');

      const metadata = await this.sheets.spreadsheets.get({
        spreadsheetId: this.spreadsheetId,
      });

      const sheetExists = metadata.data.sheets?.some(
        (s: sheets_v4.Schema$Sheet) => s.properties?.title === this.HOUSE_CONFIG_SHEET
      );

      if (!sheetExists) {
        logger.info(`Sheet "${this.HOUSE_CONFIG_SHEET}" not found.Creating...`);
        await this.sheets.spreadsheets.batchUpdate({
          spreadsheetId: this.spreadsheetId,
          requestBody: {
            requests: [
              {
                addSheet: {
                  properties: { title: this.HOUSE_CONFIG_SHEET },
                },
              },
            ],
          },
        });

        // Add headers
        await this.sheets.spreadsheets.values.update({
          spreadsheetId: this.spreadsheetId,
          range: `${this.HOUSE_CONFIG_SHEET}!A1`,
          valueInputOption: 'USER_ENTERED',
          requestBody: {
            values: [this.HOUSE_CONFIG_HEADERS],
          },
        });

        // 静岡(1号〜4号) + 群馬(8号・9号) の統合デフォルト
        const defaults = [
          ['1号', '10', '', ''],
          ['2号', '10', '', ''],
          ['3号', '10', '', ''],
          ['4号', '10', '', ''],
          ['8号', '10', '', ''],
          ['9号', '10', '', '']
        ];
        await this.sheets.spreadsheets.values.append({
          spreadsheetId: this.spreadsheetId,
          range: `${this.HOUSE_CONFIG_SHEET}!A2`,
          valueInputOption: 'USER_ENTERED',
          insertDataOption: 'INSERT_ROWS',
          requestBody: { values: defaults }
        });

        logger.info('House Config sheet created with defaults.');
      } else {
        logger.info(`Sheet "${this.HOUSE_CONFIG_SHEET}" already exists.`);
      }
    } catch (error) {
      logger.error(`Failed to initialize House Config sheet: ${error} `);
      throw error;
    }
  }

  // ========== アラート履歴関連のメソッド ==========

  /**
   * アラート履歴シートを初期化
   * alert-checker.ts がクールダウン永続化のために使用するシート。
   * 未作成だと毎回 warn が出るため、初期化で自動作成する。
   */
  async initializeAlertHistorySheet(): Promise<void> {
    try {
      logger.info('Initializing Alert History Sheet...');

      const metadata = await this.sheets.spreadsheets.get({
        spreadsheetId: this.spreadsheetId,
      });

      const sheetExists = metadata.data.sheets?.some(
        (s: sheets_v4.Schema$Sheet) => s.properties?.title === this.ALERT_HISTORY_SHEET
      );

      if (!sheetExists) {
        logger.info(`Sheet "${this.ALERT_HISTORY_SHEET}" not found. Creating...`);
        await this.sheets.spreadsheets.batchUpdate({
          spreadsheetId: this.spreadsheetId,
          requestBody: {
            requests: [
              {
                addSheet: {
                  properties: { title: this.ALERT_HISTORY_SHEET },
                },
              },
            ],
          },
        });

        await this.sheets.spreadsheets.values.update({
          spreadsheetId: this.spreadsheetId,
          range: `${this.ALERT_HISTORY_SHEET}!A1`,
          valueInputOption: 'USER_ENTERED',
          requestBody: {
            values: [this.ALERT_HISTORY_HEADERS],
          },
        });
        logger.info('Alert History sheet created and headers added.');
      } else {
        logger.info(`Sheet "${this.ALERT_HISTORY_SHEET}" already exists.`);
      }
    } catch (error) {
      logger.error(`Failed to initialize alert history sheet: ${error}`);
      throw error;
    }
  }

  async getHouseConfigs(): Promise<Map<string, import('../types').HouseConfig>> {
    try {
      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId: this.spreadsheetId,
        range: `${this.HOUSE_CONFIG_SHEET}!A2:D`,
      });

      const rows = response.data.values || [];
      const configs = new Map<string, import('../types').HouseConfig>();

      for (const row of rows) {
        const name = row[0];
        if (!name) continue;

        configs.set(name, {
          houseName: name,
          area: parseFloat(row[1]) || 10,
          lightingStartTime: row[2] || undefined,
          lightingEndTime: row[3] || undefined
        });
      }
      return configs;
    } catch (error) {
      logger.error(`Error getting house configs: ${error} `);
      return new Map();
    }
  }
}
