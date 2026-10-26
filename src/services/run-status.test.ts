import { describe, it, expect } from 'vitest';
import { RunOutcome, RunStatus, buildRunStatus, sanitizePublicMessage, shouldNotifyEmptyScrape } from './run-status';

const jst = (isoLocal: string) => new Date(`${isoLocal}+09:00`);

const outcome = (over: Partial<RunOutcome> = {}): RunOutcome => ({
    now: jst('2026-10-26T14:10:00'),
    sources: [
        { key: 'profinder', enabled: true, count: 5, error: null },
        { key: 'profarm', enabled: true, count: 1, error: null },
    ],
    sheets: { append: 'ok', read: 'ok' },
    pages: [
        { key: 'index.html', written: true, dataTime: jst('2026-10-26T14:10:00') },
        { key: 'gunma.html', written: true, dataTime: jst('2026-10-26T14:10:00') },
    ],
    emptyScrapeNotified: false,
    failures: [],
    warnings: [],
    ...over,
});

describe('sanitizePublicMessage', () => {
    it('URL・メールアドレス・長いID状の文字列を伏せる', () => {
        const msg = 'request to https://sheets.googleapis.com/v4/spreadsheets/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd/values failed '
            + 'for monitor-bot@example-project.iam.gserviceaccount.com';
        const s = sanitizePublicMessage(msg);
        expect(s).not.toContain('googleapis');
        expect(s).not.toContain('gserviceaccount');
        expect(s).toContain('<url>');
        expect(s).toContain('<email>');
        expect(sanitizePublicMessage('id=1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789')).toBe('id=<redacted>');
    });

    it('通常のエラー文や環境変数名はそのまま残す', () => {
        expect(sanitizePublicMessage('Profarm login HTTP 503')).toBe('Profarm login HTTP 503');
        expect(sanitizePublicMessage('GOOGLE_SERVICE_ACCOUNT_KEY が未設定')).toBe('GOOGLE_SERVICE_ACCOUNT_KEY が未設定');
    });

    it('ホームディレクトリを伏せ、長さを制限する', () => {
        expect(sanitizePublicMessage('ENOENT C:\\Users\\someone\\x.json')).toBe('ENOENT <home>\\x.json');
        expect(sanitizePublicMessage('a'.repeat(500)).length).toBe(200);
    });
});

describe('buildRunStatus', () => {
    it('失敗した回は最終成功時刻を前回値から引き継ぐ', () => {
        const prev = buildRunStatus(null, outcome());
        const next = buildRunStatus(prev, outcome({
            now: jst('2026-10-26T14:20:00'),
            sources: [
                { key: 'profinder', enabled: true, count: 5, error: null },
                { key: 'profarm', enabled: true, count: 0, error: 'HTTP 503' },
            ],
            sheets: { append: 'failed', appendError: 'The caller does not have permission', read: 'ok' },
            failures: ['Sheets追記: The caller does not have permission'],
        }));

        expect(next.ok).toBe(false);
        expect(next.sources.profarm.lastSuccessAt).toBe('2026-10-26T14:10:00+09:00');
        expect(next.sources.profarm.lastAttemptAt).toBe('2026-10-26T14:20:00+09:00');
        expect(next.sources.profinder.lastSuccessAt).toBe('2026-10-26T14:20:00+09:00');
        expect(next.dataUpdatedAt).toBe('2026-10-26T14:20:00+09:00');
        expect(next.sheets.append).toEqual({ ok: false, at: '2026-10-26T14:20:00+09:00', error: 'The caller does not have permission' });
        expect(next.sheets.lastAppendSuccessAt).toBe('2026-10-26T14:10:00+09:00');
        expect(next.sheets.appendFailingSince).toBe('2026-10-26T14:20:00+09:00');
    });

    it('追記の連続失敗では失敗開始時刻を保ち、成功で解除する', () => {
        const failing = (now: Date) => outcome({ now, sheets: { append: 'failed', appendError: 'x', read: 'ok' } });
        const s1 = buildRunStatus(null, failing(jst('2026-10-26T14:10:00')));
        const s2 = buildRunStatus(s1, failing(jst('2026-10-26T14:20:00')));
        expect(s2.sheets.appendFailingSince).toBe('2026-10-26T14:10:00+09:00');
        const s3 = buildRunStatus(s2, outcome({ now: jst('2026-10-26T14:30:00') }));
        expect(s3.sheets.appendFailingSince).toBeNull();
    });

    it('書き換えなかったページは前回の表示データ時刻を引き継ぐ', () => {
        const prev = buildRunStatus(null, outcome());
        const next = buildRunStatus(prev, outcome({
            now: jst('2026-10-26T15:00:00'),
            pages: [{ key: 'index.html', written: false, dataTime: null }],
        }));
        expect(next.pages['index.html']).toEqual({
            written: false,
            dataTime: '2026-10-26T14:10:00+09:00',
            lastWrittenAt: '2026-10-26T14:10:00+09:00',
        });
    });
});

describe('shouldNotifyEmptyScrape', () => {
    const emptyStatus = (notifiedAt: string | null): RunStatus => ({
        ...buildRunStatus(null, outcome({ sources: [{ key: 'profinder', enabled: true, count: 0, error: null }] })),
        notifications: { emptyScrapeNotifiedAt: notifiedAt },
    });

    it('前回が取得成功なら通知する', () => {
        expect(shouldNotifyEmptyScrape(buildRunStatus(null, outcome()), jst('2026-10-26T14:20:00'))).toBe(true);
        expect(shouldNotifyEmptyScrape(null, jst('2026-10-26T14:20:00'))).toBe(true);
    });

    it('障害継続中は一定間隔まで再通知しない', () => {
        const prev = emptyStatus('2026-10-26T14:10:00+09:00');
        expect(shouldNotifyEmptyScrape(prev, jst('2026-10-26T15:10:00'))).toBe(false);
        expect(shouldNotifyEmptyScrape(prev, jst('2026-10-26T20:10:00'))).toBe(true);
    });
});
