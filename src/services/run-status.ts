import fs from 'fs/promises';
import path from 'path';
import { formatIsoJst, logger } from '../utils';

/**
 * public/status.json の内容
 *
 * 公開リポジトリ・公開ページに置くため、URL・ID・認証情報は含めない。
 * エラーメッセージは sanitizePublicMessage() を通してから格納する。
 */
export interface SourceStatus {
    /** 今回の実行で取得対象だったか（PROFARM_URL 未設定などで false） */
    enabled: boolean;
    lastAttemptAt: string | null;
    /** 最後に1件以上取得できた時刻 */
    lastSuccessAt: string | null;
    lastCount: number;
    lastError: string | null;
}

export interface SheetsStatus {
    /** 今回の追記結果（null = 未実施） */
    append: { ok: boolean | null; at: string | null; error: string | null };
    /** 今回の読み直し結果（null = 未実施） */
    read: { ok: boolean | null; error: string | null };
    lastAppendSuccessAt: string | null;
    /** 追記が連続で失敗し始めた時刻（成功で null に戻る） */
    appendFailingSince: string | null;
}

export interface PageStatus {
    /** 今回の実行で書き換えたか */
    written: boolean;
    /** ページに表示しているデータの最新計測時刻 */
    dataTime: string | null;
    lastWrittenAt: string | null;
}

export interface RunStatus {
    schemaVersion: 1;
    /** この status.json を書いた時刻（実行時刻） */
    generatedAt: string;
    /** 今回の実行で失敗が無かったか */
    ok: boolean;
    /** 今回の実行で全ソースが0件だったか */
    allSourcesEmpty: boolean;
    /** いずれかのソースで最後に取得成功した時刻（鮮度監視が参照する） */
    dataUpdatedAt: string | null;
    sources: Record<string, SourceStatus>;
    sheets: SheetsStatus;
    pages: Record<string, PageStatus>;
    notifications: { emptyScrapeNotifiedAt: string | null };
    failures: string[];
    warnings: string[];
}

export type StepState = 'ok' | 'failed' | 'skipped';

/** 1回の実行結果（buildRunStatus の入力） */
export interface RunOutcome {
    now: Date;
    sources: Array<{ key: string; enabled: boolean; count: number; error: string | null }>;
    sheets: {
        append: StepState;
        appendError?: string;
        read: StepState;
        readError?: string;
    };
    pages: Array<{ key: string; written: boolean; dataTime: Date | null }>;
    emptyScrapeNotified: boolean;
    failures: string[];
    warnings: string[];
}

/** 全ソース0件の LINE 通知を再送するまでの間隔 */
export const EMPTY_SCRAPE_NOTIFY_INTERVAL_HOURS = 6;

/**
 * 公開してよい形にエラーメッセージを整える
 * URL・メールアドレス（サービスアカウント等）・長いID/トークン状の文字列・ホームディレクトリを伏せ、長さを制限する
 */
export function sanitizePublicMessage(message: string, maxLength: number = 200): string {
    let s = message
        .replace(/https?:\/\/[^\s'"<>()]+/gi, '<url>')
        .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '<email>')
        .replace(/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{25,}\b/g, '<redacted>')
        .replace(/[A-Za-z]:\\Users\\[^\\\s]+/gi, '<home>')
        .replace(/\/(?:home|Users)\/[^/\s]+/g, '<home>')
        .replace(/\s+/g, ' ')
        .trim();
    if (s.length > maxLength) s = s.slice(0, maxLength - 1) + '…';
    return s;
}

/**
 * 全ソース0件のとき LINE 通知するか
 * 直前の実行で取得できていた（状態が変わった）場合と、前回通知から一定時間経った場合だけ通知する。
 * 10分毎の実行で障害中に通知が連発し、送信上限を使い切るのを防ぐ
 */
export function shouldNotifyEmptyScrape(
    prev: RunStatus | null,
    now: Date,
    intervalHours: number = EMPTY_SCRAPE_NOTIFY_INTERVAL_HOURS
): boolean {
    if (!prev || !prev.allSourcesEmpty) return true;
    const last = prev.notifications?.emptyScrapeNotifiedAt;
    if (!last) return true;
    const lastMs = Date.parse(last);
    if (isNaN(lastMs)) return true;
    return now.getTime() - lastMs >= intervalHours * 3600 * 1000;
}

function newestIso(values: Array<string | null | undefined>): string | null {
    let best: string | null = null;
    let bestMs = -Infinity;
    for (const v of values) {
        if (!v) continue;
        const ms = Date.parse(v);
        if (!isNaN(ms) && ms > bestMs) {
            bestMs = ms;
            best = v;
        }
    }
    return best;
}

/**
 * 前回の status.json と今回の実行結果から新しい status.json を作る
 * 最終成功時刻などは今回失敗しても前回値を引き継ぐ
 */
export function buildRunStatus(prev: RunStatus | null, outcome: RunOutcome): RunStatus {
    const nowIso = formatIsoJst(outcome.now);

    const sources: Record<string, SourceStatus> = {};
    for (const s of outcome.sources) {
        const p = prev?.sources?.[s.key];
        const success = s.enabled && s.count > 0;
        sources[s.key] = {
            enabled: s.enabled,
            lastAttemptAt: s.enabled ? nowIso : p?.lastAttemptAt ?? null,
            lastSuccessAt: success ? nowIso : p?.lastSuccessAt ?? null,
            lastCount: s.count,
            lastError: s.error ? sanitizePublicMessage(s.error) : null,
        };
    }

    const prevSheets = prev?.sheets;
    const sheets: SheetsStatus = {
        append: { ok: null, at: null, error: null },
        read: { ok: null, error: null },
        lastAppendSuccessAt: prevSheets?.lastAppendSuccessAt ?? null,
        appendFailingSince: prevSheets?.appendFailingSince ?? null,
    };
    if (outcome.sheets.append === 'ok') {
        sheets.append = { ok: true, at: nowIso, error: null };
        sheets.lastAppendSuccessAt = nowIso;
        sheets.appendFailingSince = null;
    } else if (outcome.sheets.append === 'failed') {
        sheets.append = {
            ok: false,
            at: nowIso,
            error: sanitizePublicMessage(outcome.sheets.appendError ?? '不明なエラー'),
        };
        sheets.appendFailingSince = prevSheets?.appendFailingSince ?? nowIso;
    }
    if (outcome.sheets.read === 'ok') {
        sheets.read = { ok: true, error: null };
    } else if (outcome.sheets.read === 'failed') {
        sheets.read = { ok: false, error: sanitizePublicMessage(outcome.sheets.readError ?? '不明なエラー') };
    }

    const pages: Record<string, PageStatus> = {};
    for (const pg of outcome.pages) {
        const p = prev?.pages?.[pg.key];
        pages[pg.key] = pg.written
            ? { written: true, dataTime: pg.dataTime ? formatIsoJst(pg.dataTime) : null, lastWrittenAt: nowIso }
            : { written: false, dataTime: p?.dataTime ?? null, lastWrittenAt: p?.lastWrittenAt ?? null };
    }

    return {
        schemaVersion: 1,
        generatedAt: nowIso,
        ok: outcome.failures.length === 0,
        allSourcesEmpty: outcome.sources.every(s => s.count === 0),
        dataUpdatedAt: newestIso(Object.values(sources).map(s => s.lastSuccessAt)),
        sources,
        sheets,
        pages,
        notifications: {
            emptyScrapeNotifiedAt: outcome.emptyScrapeNotified
                ? nowIso
                : prev?.notifications?.emptyScrapeNotifiedAt ?? null,
        },
        failures: outcome.failures.map(f => sanitizePublicMessage(f)),
        warnings: outcome.warnings.map(w => sanitizePublicMessage(w)),
    };
}

/** 前回の status.json を読む。無い・壊れている・版が違う場合は null */
export async function readRunStatus(filePath: string): Promise<RunStatus | null> {
    try {
        const parsed = JSON.parse(await fs.readFile(filePath, 'utf-8'));
        return parsed && parsed.schemaVersion === 1 ? (parsed as RunStatus) : null;
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') {
            logger.warn(`status.json を読めないため前回値なしで扱う: ${error}`);
        }
        return null;
    }
}

export async function writeRunStatus(filePath: string, status: RunStatus): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(status, null, 2) + '\n', 'utf-8');
}
