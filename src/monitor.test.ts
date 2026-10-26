import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { EnvironmentData } from './types';
import { MonitorSheetsPort } from './services/sheets';
import { DashboardGenerator } from './services/dashboard-generator';
import { GunmaDashboardGenerator } from './services/gunma-dashboard';
import { RunStatus } from './services/run-status';
import { MonitorDeps, SourceRunner, runMonitoring, mergeLatestByLocation, mergeHistory } from './monitor';

// JST の壁時計時刻で Date を作る（実行環境のTZに依存しない）
const jst = (isoLocal: string) => new Date(`${isoLocal}+09:00`);
const NOW = jst('2026-10-26T14:10:00');

const record = (location: string, timestamp: Date, over: Partial<EnvironmentData> = {}): EnvironmentData => ({
    timestamp,
    source: location === '1号棟' ? 'profarm' : 'profinder',
    location,
    temperature: 24.5,
    humidity: 70,
    co2: 450,
    accumulatedSolarRadiation: 3.2,
    ...over,
});

const profinderData = (ts: Date) => ['2号棟', '3号棟', '4号棟', '9号棟', '8号棟'].map(l => record(l, ts));

function fakeSheets(overrides: Partial<MonitorSheetsPort> = {}): MonitorSheetsPort & { saved: EnvironmentData[][] } {
    const saved: EnvironmentData[][] = [];
    return {
        saved,
        saveEnvironmentData: async (data: EnvironmentData[]) => {
            saved.push(data);
        },
        getLatestData: async () => [],
        getRawHistoryData: async () => [],
        getHouseConfigs: async () => new Map(),
        saveWateringGuide: async () => undefined,
        getWateringGuideHistory: async () => [],
        getThresholds: async () => ({}),
        ...overrides,
    };
}

const source = (key: string, label: string, data: EnvironmentData[], error: string | null = null, enabled = true): SourceRunner => ({
    key,
    label,
    enabled,
    scrape: async () => ({ data, error }),
});

let dir: string;
let notifications: string[];

const paths = () => ({
    index: path.join(dir, 'index.html'),
    gunma: path.join(dir, 'gunma.html'),
    status: path.join(dir, 'status.json'),
});

function deps(over: Partial<MonitorDeps> = {}): MonitorDeps {
    const p = paths();
    return {
        sources: [
            source('profinder', 'プロファインダー', profinderData(NOW)),
            source('profarm', 'プロファーム', [record('1号棟', NOW)]),
        ],
        createSheets: () => fakeSheets(),
        pages: [
            { farm: '静岡', file: 'index.html', generator: new DashboardGenerator({ outputPath: p.index }) },
            { farm: '群馬', file: 'gunma.html', generator: new GunmaDashboardGenerator({ outputPath: p.gunma }) },
        ],
        checkAlerts: async () => undefined,
        notify: async text => {
            notifications.push(text);
            return true;
        },
        statusPath: p.status,
        now: () => NOW,
        ...over,
    };
}

const readStatus = async (): Promise<RunStatus> => JSON.parse(await fs.readFile(paths().status, 'utf-8'));
const exists = (f: string) => fs.access(f).then(() => true, () => false);

beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'monitor-test-'));
    notifications = [];
});

afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
});

describe('runMonitoring: Sheets 追記の失敗', () => {
    it('追記が失敗しても両ページを生成し、終了コードを非0にする', async () => {
        const sheets = fakeSheets({
            saveEnvironmentData: async () => {
                throw new Error('The caller does not have permission');
            },
        });

        const result = await runMonitoring(deps({ createSheets: () => sheets }));

        expect(result.exitCode).toBe(1);
        expect(result.failures.some(f => f.startsWith('Sheets追記'))).toBe(true);
        expect(await exists(paths().index)).toBe(true);
        expect(await exists(paths().gunma)).toBe(true);

        const status = await readStatus();
        expect(status.ok).toBe(false);
        expect(status.sheets.append.ok).toBe(false);
        expect(status.sheets.appendFailingSince).toBe('2026-10-26T14:10:00+09:00');
        expect(status.pages['index.html'].written).toBe(true);
        expect(status.sources.profinder.lastSuccessAt).toBe('2026-10-26T14:10:00+09:00');
    });

    it('Sheets の初期化自体が失敗しても取得データでページを生成し、終了コードを非0にする', async () => {
        const result = await runMonitoring(deps({
            createSheets: () => {
                throw new Error('環境変数 SPREADSHEET_ID が設定されていません');
            },
        }));

        expect(result.exitCode).toBe(1);
        expect(await exists(paths().index)).toBe(true);
        expect(await exists(paths().gunma)).toBe(true);
        expect((await readStatus()).sheets.append.ok).toBe(false);
    });

    it('ダッシュボード生成中の Sheets 読込失敗もページは生成し、終了コードを非0にする', async () => {
        const sheets = fakeSheets({
            getHouseConfigs: async () => {
                throw new Error('quota exceeded');
            },
        });

        const result = await runMonitoring(deps({ createSheets: () => sheets }));

        expect(result.exitCode).toBe(1);
        expect(result.failures.some(f => f.includes('ハウス設定読込'))).toBe(true);
        expect(await exists(paths().index)).toBe(true);
    });

    it('Sheets が正常なら終了コード0で追記も1回だけ行う', async () => {
        const sheets = fakeSheets();
        const result = await runMonitoring(deps({ createSheets: () => sheets }));

        expect(result.exitCode).toBe(0);
        expect(sheets.saved).toHaveLength(1);
        expect(sheets.saved[0]).toHaveLength(6);
        expect((await readStatus()).sheets.lastAppendSuccessAt).toBe('2026-10-26T14:10:00+09:00');
    });
});

describe('runMonitoring: 全ソース0件', () => {
    it('ページを書き換えず、追記もせず、終了コードを非0にする', async () => {
        await fs.writeFile(paths().index, 'OLD-INDEX', 'utf-8');
        await fs.writeFile(paths().gunma, 'OLD-GUNMA', 'utf-8');
        const sheets = fakeSheets({
            // Sheets には古い行が残っている（これを使って作り直してはいけない）
            getLatestData: async () => [record('2号棟', jst('2026-05-02T13:21:00'))],
        });

        const result = await runMonitoring(deps({
            sources: [
                source('profinder', 'プロファインダー', [], 'Profinder login HTTP 503'),
                source('profarm', 'プロファーム', [], 'Profarm login HTTP 503'),
            ],
            createSheets: () => sheets,
        }));

        expect(result.exitCode).toBe(1);
        expect(await fs.readFile(paths().index, 'utf-8')).toBe('OLD-INDEX');
        expect(await fs.readFile(paths().gunma, 'utf-8')).toBe('OLD-GUNMA');
        expect(sheets.saved).toHaveLength(0);

        const status = await readStatus();
        expect(status.allSourcesEmpty).toBe(true);
        expect(status.pages['index.html'].written).toBe(false);
        expect(status.sources.profarm.lastError).toBe('Profarm login HTTP 503');
    });

    it('前回の最終成功時刻を引き継ぎ、LINE 通知は障害中に連発しない', async () => {
        await runMonitoring(deps());
        const empty = deps({
            sources: [
                source('profinder', 'プロファインダー', [], 'HTTP 503'),
                source('profarm', 'プロファーム', [], 'HTTP 503'),
            ],
        });

        await runMonitoring({ ...empty, now: () => jst('2026-10-26T14:20:00') });
        await runMonitoring({ ...empty, now: () => jst('2026-10-26T14:30:00') });

        const status = await readStatus();
        expect(status.sources.profinder.lastSuccessAt).toBe('2026-10-26T14:10:00+09:00');
        expect(status.dataUpdatedAt).toBe('2026-10-26T14:10:00+09:00');
        expect(status.generatedAt).toBe('2026-10-26T14:30:00+09:00');
        expect(notifications).toHaveLength(1);
    });
});

describe('runMonitoring: 一部ソースの失敗', () => {
    it('ProFarm だけ失敗しても取れたソースで両ページを公開し、終了コードは0', async () => {
        const sheets = fakeSheets({
            getLatestData: async farm => (farm === '静岡' ? [record('1号棟', jst('2026-10-22T01:20:00'))] : []),
        });

        const result = await runMonitoring(deps({
            sources: [
                source('profinder', 'プロファインダー', profinderData(NOW)),
                source('profarm', 'プロファーム', [], 'Profarm login HTTP 503'),
            ],
            createSheets: () => sheets,
        }));

        expect(result.exitCode).toBe(0);
        expect(result.warnings.some(w => w.includes('プロファーム'))).toBe(true);

        const html = await fs.readFile(paths().index, 'utf-8');
        expect(html).toContain('最終 26/10/26 14:10');
        expect(html).toContain('一部ハウスのデータが古い');
        expect(html).toContain('1号棟（10/22 01:20）');
        expect(await exists(paths().gunma)).toBe(true);

        const status = await readStatus();
        expect(status.sources.profarm.lastSuccessAt).toBeNull();
        expect(status.sources.profarm.lastCount).toBe(0);
    });

    it('今回データが無い農場のページは作り直さない', async () => {
        await fs.writeFile(paths().index, 'OLD-INDEX', 'utf-8');

        const result = await runMonitoring(deps({
            sources: [
                source('profinder', 'プロファインダー', [record('8号棟', NOW), record('9号棟', NOW)]),
                source('profarm', 'プロファーム', [], null, false),
            ],
        }));

        expect(result.exitCode).toBe(0);
        expect(await fs.readFile(paths().index, 'utf-8')).toBe('OLD-INDEX');
        expect(await exists(paths().gunma)).toBe(true);
        expect((await readStatus()).sources.profarm.enabled).toBe(false);
    });

    it('スクレイパーが例外を投げても他のソースで続行する', async () => {
        const result = await runMonitoring(deps({
            sources: [
                source('profinder', 'プロファインダー', profinderData(NOW)),
                {
                    key: 'profarm',
                    label: 'プロファーム',
                    enabled: true,
                    scrape: async () => {
                        throw new Error('Failed to launch the browser process');
                    },
                },
            ],
        }));

        expect(result.exitCode).toBe(0);
        expect((await readStatus()).sources.profarm.lastError).toBe('Failed to launch the browser process');
    });
});

describe('mergeLatestByLocation / mergeHistory', () => {
    it('ハウスごとに新しい方を採用する', () => {
        const merged = mergeLatestByLocation(
            [record('2号棟', NOW, { temperature: 30 })],
            [record('2号棟', jst('2026-10-26T14:00:00'), { temperature: 20 }), record('1号棟', jst('2026-10-22T01:20:00'))]
        );
        expect(merged.find(d => d.location === '2号棟')?.temperature).toBe(30);
        expect(merged.find(d => d.location === '1号棟')).toBeDefined();
    });

    it('Sheets に保存済み（秒精度）の行と同じ取得データは履歴に二重に足さない', () => {
        const fresh = record('2号棟', new Date(NOW.getTime() + 123));
        const stored = record('2号棟', NOW);
        expect(mergeHistory([stored], [fresh])).toHaveLength(1);
        expect(mergeHistory([], [fresh])).toHaveLength(1);
    });
});
