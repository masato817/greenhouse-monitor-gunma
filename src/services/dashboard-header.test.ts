import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { EnvironmentData } from '../types';
import { DashboardGenerator } from './dashboard-generator';
import { GunmaDashboardGenerator } from './gunma-dashboard';
import { buildFreshness, formatAge } from './freshness';

const jst = (isoLocal: string) => new Date(`${isoLocal}+09:00`);

const record = (location: string, timestamp: Date): EnvironmentData => ({
    timestamp,
    source: location === '1号棟' ? 'profarm' : 'profinder',
    location,
    temperature: 22.1,
});

const staleBanner = (html: string): string => {
    const m = html.match(/<div id="stale-banner"[\s\S]*?>/);
    if (!m) throw new Error('stale-banner が見つからない');
    return m[0];
};

let dir: string;

beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dashboard-test-'));
});

afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
});

describe('ダッシュボードのヘッダ時刻', () => {
    it('「最終」は実行時刻ではなくデータの計測時刻を表示する', async () => {
        const out = path.join(dir, 'index.html');
        const data = ['1号棟', '2号棟', '3号棟', '4号棟'].map(l => record(l, jst('2026-07-04T10:20:00')));

        const result = await new DashboardGenerator({ outputPath: out })
            .generate(data, [], { sheets: null, now: jst('2026-07-04T10:30:00') });

        const html = await fs.readFile(out, 'utf-8');
        expect(html).toContain('最終 26/07/04 10:20');
        expect(html).not.toContain('最終 26/07/04 10:30');
        expect(staleBanner(html)).toContain('display:none');
        expect(html).toContain('data-data-time="2026-07-04T10:20:00+09:00"');
        expect(result.dataTime?.toISOString()).toBe(jst('2026-07-04T10:20:00').toISOString());
        expect(result.sheetsErrors).toEqual([]);
    });

    it('データが60分より古ければ「データが古い」帯を表示する', async () => {
        const out = path.join(dir, 'gunma.html');
        const data = ['8号棟', '9号棟'].map(l => record(l, jst('2026-07-04T10:20:00')));

        await new GunmaDashboardGenerator({ outputPath: out })
            .generate(data, [], { sheets: null, now: jst('2026-07-04T12:00:00') });

        const html = await fs.readFile(out, 'utf-8');
        expect(html).toContain('最終 26/07/04 10:20');
        expect(staleBanner(html)).not.toContain('display:none');
        expect(html).toContain('データが古い');
        expect(html).toContain('1時間');
    });

    it('テンプレートを読めない場合は例外にして呼び出し側に伝える', async () => {
        const gen = new DashboardGenerator({ outputPath: path.join(dir, 'x.html'), templatePath: path.join(dir, 'missing.hbs') });
        await expect(gen.generate([record('2号棟', jst('2026-07-04T10:20:00'))], [], { sheets: null })).rejects.toThrow();
    });
});

describe('buildFreshness', () => {
    const now = jst('2026-10-26T14:10:00');

    it('最新のハウスの時刻を採用し、閾値内なら古くない扱い', () => {
        const f = buildFreshness([
            { label: '2号棟', data: record('2号棟', jst('2026-10-26T14:05:00')) },
            { label: '1号棟', data: record('1号棟', jst('2026-10-26T13:50:00')) },
        ], now);
        expect(f.updatedAt).toBe('26/10/26 14:05');
        expect(f.isStale).toBe(false);
        expect(f.staleHouses).toEqual([]);
    });

    it('一部ハウスだけ古い場合はそのハウスを列挙する', () => {
        const f = buildFreshness([
            { label: '2号棟', data: record('2号棟', now) },
            { label: '1号棟', data: record('1号棟', jst('2026-10-22T01:20:00')) },
            { label: '3号棟', data: {} },
        ], now);
        expect(f.isStale).toBe(false);
        expect(f.staleHouses).toEqual([{ label: '1号棟', time: '10/22 01:20' }]);
    });

    it('データが無ければ古い扱い', () => {
        const f = buildFreshness([{ label: '8号棟', data: {} }], now);
        expect(f.isStale).toBe(true);
        expect(f.updatedAt).toBe('-');
    });

    it('経過時間の表記', () => {
        expect(formatAge(5)).toBe('5分');
        expect(formatAge(125)).toBe('2時間');
        expect(formatAge(60 * 24 * 3)).toBe('3日');
    });
});
