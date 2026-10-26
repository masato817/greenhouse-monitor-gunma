import cron from 'node-cron';
import path from 'path';
import { ProfinderScraper } from './scrapers/profinder';
import { ProfarmScraper } from './scrapers/profarm';
import { BaseScraper } from './scrapers/base';
import { GoogleSheetsService } from './services/sheets';
import { LineMessagingService } from './services/line-messaging';
import { AlertChecker } from './services/alert-checker';
import { DashboardGenerator } from './services/dashboard-generator';
import { GunmaDashboardGenerator } from './services/gunma-dashboard';
import { MonitorDeps, MonitorResult, SourceScrapeResult, runMonitoring } from './monitor';
import { logger, getEnv } from './utils';
import dotenv from 'dotenv';

dotenv.config();

/**
 * スクレイパーを実行し、取得データとエラー要約を返す
 * scrape() は失敗しても空配列を返すため、原因は lastError から拾う
 */
async function runScraper(scraper: BaseScraper): Promise<SourceScrapeResult> {
  const data = await scraper.scrape();
  return { data, error: scraper.lastError };
}

/**
 * 本番用の依存関係（スクレイパー・Sheets・ダッシュボード・通知）を組み立てる
 */
function createDefaultDeps(): MonitorDeps {
  const profinderUrl = getEnv('PROFINDER_URL', '');
  const profarmUrl = getEnv('PROFARM_URL', '');

  return {
    sources: [
      {
        // 静岡2〜4号 + 群馬8号/9号。必須ソースのため URL 未設定もエラーとして記録する
        key: 'profinder',
        label: 'プロファインダー',
        enabled: true,
        scrape: async () => {
          if (!profinderUrl) return { data: [], error: 'PROFINDER_URL が未設定' };
          return runScraper(new ProfinderScraper({
            url: profinderUrl,
            username: getEnv('PROFINDER_USER', ''),
            password: getEnv('PROFINDER_PASS', ''),
          }, logger));
        },
      },
      {
        // 静岡1号棟。PROFARM_URL 未設定時は取得しない
        key: 'profarm',
        label: 'プロファーム',
        enabled: profarmUrl !== '',
        scrape: () => runScraper(new ProfarmScraper({
          url: profarmUrl,
          username: getEnv('PROFARM_USER', ''),
          password: getEnv('PROFARM_PASS', ''),
        }, logger)),
      },
    ],
    createSheets: () => new GoogleSheetsService(),
    pages: [
      { farm: '静岡', file: 'index.html', generator: new DashboardGenerator() },
      { farm: '群馬', file: 'gunma.html', generator: new GunmaDashboardGenerator() },
    ],
    checkAlerts: data => new AlertChecker().checkAndNotify(data),
    notify: text => new LineMessagingService().send(text),
    statusPath: path.join(process.cwd(), 'public', 'status.json'),
  };
}

/**
 * メイン処理: データ取得 → 保存 → ダッシュボード生成 → 異常チェック → status.json
 * 失敗は戻り値に集約し、単発実行（--scrape）では終了コードに反映する
 */
async function main(): Promise<MonitorResult> {
  return runMonitoring(createDefaultDeps());
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
    .then(result => process.exit(result.exitCode))
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
