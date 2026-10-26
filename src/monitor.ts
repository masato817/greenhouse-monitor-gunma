import { EnvironmentData } from './types';
import { logger, Farm, ALL_FARMS, resolveFarm } from './utils';
import { MonitorSheetsPort } from './services/sheets';
import { GenerateOptions, GenerateResult } from './services/dashboard-common';
import {
    RunStatus,
    StepState,
    buildRunStatus,
    readRunStatus,
    writeRunStatus,
    shouldNotifyEmptyScrape,
} from './services/run-status';

/** ダッシュボード用に読み直す履歴の行数（1週間分の目安） */
export const HISTORY_ROWS = 10080;

export interface SourceScrapeResult {
    data: EnvironmentData[];
    /** 取得中のエラー要約（一部失敗を含む）。無ければ null */
    error: string | null;
}

export interface SourceRunner {
    /** status.json のキー */
    key: string;
    /** ログ表示名 */
    label: string;
    /** false なら取得しない（PROFARM_URL 未設定など） */
    enabled: boolean;
    scrape: () => Promise<SourceScrapeResult>;
}

export interface PageGenerator {
    generate(data: EnvironmentData[], history: EnvironmentData[], options: GenerateOptions): Promise<GenerateResult>;
}

export interface PageTarget {
    farm: Farm;
    /** status.json のキー（出力ファイル名） */
    file: string;
    generator: PageGenerator;
}

export interface MonitorDeps {
    sources: SourceRunner[];
    /** Sheets クライアントを作る（設定不足などで例外を投げうる） */
    createSheets: () => MonitorSheetsPort;
    pages: PageTarget[];
    checkAlerts: (data: EnvironmentData[]) => Promise<void>;
    /** LINE 通知。送信できたら true */
    notify: (text: string) => Promise<boolean>;
    statusPath: string;
    now?: () => Date;
}

export interface MonitorResult {
    /** 0 = 失敗なし / 1 = 失敗あり（ページは可能な範囲で生成済み） */
    exitCode: 0 | 1;
    /** 終了コードを非0にする失敗（Sheets 失敗・全ソース0件・生成失敗など） */
    failures: string[];
    /** 公開は続けた一部失敗（一部ソースの取得失敗など） */
    warnings: string[];
    status: RunStatus;
}

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Sheets の秒精度の時刻と取得直後のミリ秒精度の時刻を同一視するため秒で比較する */
const toSec = (d: Date): number => Math.floor(d.getTime() / 1000);

/**
 * 今回取得したデータと Sheets の最新行をハウス（location）単位で合わせ、新しい方を採用する
 * 一部ソースが失敗した回でも、取得できなかったハウスは Sheets の直近値で表示を続ける
 */
export function mergeLatestByLocation(fresh: EnvironmentData[], stored: EnvironmentData[]): EnvironmentData[] {
    const latest = new Map<string, EnvironmentData>();
    for (const d of [...stored, ...fresh]) {
        const cur = latest.get(d.location);
        if (!cur || toSec(d.timestamp) >= toSec(cur.timestamp)) latest.set(d.location, d);
    }
    return Array.from(latest.values());
}

/**
 * Sheets の履歴に、まだ載っていない今回の取得データを足す
 * Sheets 追記が失敗した回でも潅水目安などの当日計算に最新値を含めるため
 */
export function mergeHistory(stored: EnvironmentData[], fresh: EnvironmentData[]): EnvironmentData[] {
    const newestByLocation = new Map<string, number>();
    for (const d of stored) {
        newestByLocation.set(d.location, Math.max(newestByLocation.get(d.location) ?? -Infinity, toSec(d.timestamp)));
    }
    const additions = fresh.filter(d => toSec(d.timestamp) > (newestByLocation.get(d.location) ?? -Infinity));
    return [...stored, ...additions];
}

/**
 * 1回分の監視処理: 取得 → Sheets 追記 → Sheets 読み直し → ページ生成 → 異常値チェック → status.json
 *
 * - 追記と読み直しは別々に失敗を扱い、Sheets が使えなくても取得データでページを作る
 * - Sheets の失敗・全ソース0件・ページ生成失敗は exitCode=1 にする（黙って成功扱いにしない）
 * - 全ソース0件の回はページを書き換えない（古い値に新しい時刻を付けて公開しないため）
 * - 一部ソースだけの失敗は警告に留め、取れたデータで公開を続ける
 */
export async function runMonitoring(deps: MonitorDeps): Promise<MonitorResult> {
    const now = (deps.now ?? (() => new Date()))();
    const failures: string[] = [];
    const warnings: string[] = [];
    const prevStatus = await readRunStatus(deps.statusPath);

    logger.info('=== 環境モニタリング開始 ===');

    // 1. 取得（ソースごとに独立。失敗は警告として記録）
    const sourceOutcomes: Array<{ key: string; enabled: boolean; count: number; error: string | null }> = [];
    const allData: EnvironmentData[] = [];
    for (const source of deps.sources) {
        if (!source.enabled) {
            logger.info(`${source.label}: 未設定のためスキップ`);
            sourceOutcomes.push({ key: source.key, enabled: false, count: 0, error: null });
            continue;
        }

        let result: SourceScrapeResult;
        try {
            logger.info(`${source.label}からデータ取得中...`);
            result = await source.scrape();
        } catch (error) {
            result = { data: [], error: errorMessage(error) };
        }

        if (result.data.length > 0) {
            logger.info(`${source.label}: ${result.data.length}件取得`);
            if (result.error) warnings.push(`${source.label}: 一部取得失敗 (${result.error})`);
        } else {
            const reason = result.error ?? '取得0件';
            logger.warn(`${source.label}: データ取得できず (${reason})`);
            warnings.push(`${source.label}: 取得できず (${reason})`);
        }
        allData.push(...result.data);
        sourceOutcomes.push({ key: source.key, enabled: true, count: result.data.length, error: result.error });
    }

    const pageOutcomes: Array<{ key: string; written: boolean; dataTime: Date | null }> = [];
    let appendState: StepState = 'skipped';
    let appendError: string | undefined;
    let readState: StepState = 'skipped';
    let readError: string | undefined;
    let emptyScrapeNotified = false;

    if (allData.length === 0) {
        // 2. 全ソース0件: ページは作り直さない（Sheets の古い行から作ると古い値が新しい時刻付きで公開される）
        failures.push('全ソースで取得0件のためダッシュボードを更新しない');
        for (const page of deps.pages) pageOutcomes.push({ key: page.file, written: false, dataTime: null });

        if (shouldNotifyEmptyScrape(prevStatus, now)) {
            const reasons = warnings.join('\n');
            emptyScrapeNotified = await deps
                .notify(`\n⚠️ データ取得エラー\n全ソースでデータを取得できなかった。ダッシュボードは前回のデータのまま。\n${reasons}`)
                .catch(error => {
                    logger.error(`LINE通知エラー: ${errorMessage(error)}`);
                    return false;
                });
        } else {
            logger.info('全ソース0件の通知は直近に送信済みのため省略');
        }
    } else {
        // 3. Sheets 追記（失敗しても後続へ進む）
        let sheets: MonitorSheetsPort | null = null;
        try {
            sheets = deps.createSheets();
        } catch (error) {
            appendState = 'failed';
            appendError = `初期化失敗: ${errorMessage(error)}`;
            failures.push(`Sheets初期化: ${errorMessage(error)}`);
            logger.error(`Sheets初期化エラー: ${errorMessage(error)}`);
        }

        if (sheets) {
            try {
                await sheets.saveEnvironmentData(allData);
                appendState = 'ok';
            } catch (error) {
                appendState = 'failed';
                appendError = errorMessage(error);
                failures.push(`Sheets追記: ${appendError}`);
                logger.error(`Sheets追記エラー（ページ生成は続行）: ${appendError}`);
            }
        }

        // 4. Sheets 読み直し（追記とは別に扱う。失敗時は今回の取得データだけで表示する）
        const stored = new Map<Farm, { latest: EnvironmentData[]; history: EnvironmentData[] }>();
        for (const farm of ALL_FARMS) stored.set(farm, { latest: [], history: [] });

        if (sheets) {
            readState = 'ok';
            const s = sheets;
            const read = async (label: string, fn: () => Promise<EnvironmentData[]>): Promise<EnvironmentData[]> => {
                try {
                    return await fn();
                } catch (error) {
                    readState = 'failed';
                    readError = readError ?? `${label}: ${errorMessage(error)}`;
                    failures.push(`Sheets読込(${label}): ${errorMessage(error)}`);
                    logger.error(`Sheets読込エラー(${label})（取得データで続行）: ${errorMessage(error)}`);
                    return [];
                }
            };
            for (const farm of ALL_FARMS) {
                const entry = stored.get(farm)!;
                entry.latest = await read(`${farm}最新`, () => s.getLatestData(farm));
                entry.history = await read(`${farm}履歴`, () => s.getRawHistoryData(HISTORY_ROWS, farm));
                logger.info(`${farm}: Sheets 最新 ${entry.latest.length}件 / 履歴 ${entry.history.length}件`);
            }
        }

        // 5. ページ生成（今回の取得データが無い農場は作り直さない）
        for (const page of deps.pages) {
            const fresh = allData.filter(d => resolveFarm(d) === page.farm);
            if (fresh.length === 0) {
                warnings.push(`${page.farm}: 今回の取得データが無いため ${page.file} を更新しない`);
                logger.warn(`${page.farm}: 今回の取得データが無いため ${page.file} の生成をスキップ`);
                pageOutcomes.push({ key: page.file, written: false, dataTime: null });
                continue;
            }

            const entry = stored.get(page.farm)!;
            const display = mergeLatestByLocation(fresh, entry.latest);
            const history = mergeHistory(entry.history, fresh);
            try {
                const result = await page.generator.generate(display, history, { sheets, now });
                for (const e of result.sheetsErrors) failures.push(`${page.farm}ダッシュボードのSheets処理: ${e}`);
                pageOutcomes.push({ key: page.file, written: true, dataTime: result.dataTime });
            } catch (error) {
                failures.push(`${page.farm}ダッシュボード生成: ${errorMessage(error)}`);
                pageOutcomes.push({ key: page.file, written: false, dataTime: null });
            }
        }

        // 6. 異常値チェック（注: 定期レポートは廃止。異常時のみ LINE 通知）
        try {
            await deps.checkAlerts(allData);
        } catch (error) {
            failures.push(`異常値チェック: ${errorMessage(error)}`);
            logger.error(`異常値チェックエラー: ${errorMessage(error)}`);
        }
    }

    // 7. status.json（ソース別の最終成功時刻・Sheets 追記の成否・生成時刻）
    const status = buildRunStatus(prevStatus, {
        now,
        sources: sourceOutcomes,
        sheets: { append: appendState, appendError, read: readState, readError },
        pages: pageOutcomes,
        emptyScrapeNotified,
        failures,
        warnings,
    });
    try {
        await writeRunStatus(deps.statusPath, status);
    } catch (error) {
        failures.push(`status.json書込: ${errorMessage(error)}`);
        logger.error(`status.json書込エラー: ${errorMessage(error)}`);
    }

    for (const w of warnings) logger.warn(`警告: ${w}`);
    if (failures.length > 0) {
        logger.error(`=== 環境モニタリング完了（失敗 ${failures.length} 件: ${failures.join(' / ')}） ===\n`);
    } else {
        logger.info('=== 環境モニタリング完了 ===\n');
    }

    return { exitCode: failures.length > 0 ? 1 : 0, failures, warnings, status };
}
