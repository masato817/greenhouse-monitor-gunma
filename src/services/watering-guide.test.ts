import { describe, it, expect } from 'vitest';
import { EnvironmentData } from '../types';
import {
    parseTimeToMinutes,
    formatMinutes,
    calculateLedMJ,
    calculateWateringGuide,
} from './watering-guide';

// JST の壁時計時刻で Date を作る（実行環境のTZに依存しない）
const jst = (isoLocal: string) => new Date(`${isoLocal}+09:00`);

const mkData = (
    time: string,
    mj: number | undefined,
    over: Partial<EnvironmentData> = {}
): EnvironmentData => ({
    timestamp: jst(`2026-07-04T${time}:00`),
    source: 'profinder',
    location: '1号棟',
    accumulatedSolarRadiation: mj,
    ...over,
});

const shizuokaOptions = {
    refHouseFilter: (d: EnvironmentData) => d.location.includes('1号') || d.source === 'profarm',
    now: jst('2026-07-04T12:00:00'),
};

describe('parseTimeToMinutes', () => {
    it('HH:mm 形式を分に変換する', () => {
        expect(parseTimeToMinutes('06:30')).toBe(390);
    });
    it('フル日時文字列から時刻部分を抽出する', () => {
        expect(parseTimeToMinutes('2026/07/04 05:45:00')).toBe(345);
    });
    it('undefined や不正文字列は null を返す', () => {
        expect(parseTimeToMinutes(undefined)).toBeNull();
        expect(parseTimeToMinutes('abc')).toBeNull();
    });
});

describe('formatMinutes', () => {
    it('分を HH:mm にゼロ埋め整形する', () => {
        expect(formatMinutes(65)).toBe('01:05');
        expect(formatMinutes(900)).toBe('15:00');
    });
});

describe('calculateLedMJ', () => {
    it('同日点灯 (06:00-17:00): 開始前は0、点灯中は経過分、消灯後は全点灯時間', () => {
        expect(calculateLedMJ('06:00', '17:00', jst('2026-07-04T05:00:00'))).toBe(0);
        expect(calculateLedMJ('06:00', '17:00', jst('2026-07-04T10:00:00'))).toBeCloseTo(4 * 0.09);
        expect(calculateLedMJ('06:00', '17:00', jst('2026-07-04T18:20:00'))).toBeCloseTo(11 * 0.09);
    });
    it('日跨ぎ点灯 (22:00-06:00): 夜間・早朝・消灯後で正しく積算する', () => {
        expect(calculateLedMJ('22:00', '06:00', jst('2026-07-04T23:00:00'))).toBeCloseTo(1 * 0.09);
        expect(calculateLedMJ('22:00', '06:00', jst('2026-07-04T03:00:00'))).toBeCloseTo(5 * 0.09);
        expect(calculateLedMJ('22:00', '06:00', jst('2026-07-04T12:00:00'))).toBeCloseTo(8 * 0.09);
    });
    it('開始=終了や設定なしは 0 を返す', () => {
        expect(calculateLedMJ('06:00', '06:00', jst('2026-07-04T12:00:00'))).toBe(0);
        expect(calculateLedMJ(undefined, '06:00', jst('2026-07-04T12:00:00'))).toBe(0);
    });
});

describe('calculateWateringGuide', () => {
    const refData = mkData('12:00', 3.0, { sunrise: '04:40', sunset: '19:00' });

    const history = [
        mkData('07:00', 0.2),
        mkData('08:00', 0.7),
        mkData('08:30', 1.0),
        mkData('09:00', 1.3),
        mkData('10:00', 1.7),
        mkData('10:30', 2.1),
        mkData('11:00', 2.4),
    ];

    it('日の出・日の入がない場合はエラーを返す', () => {
        const result = calculateWateringGuide(mkData('12:00', 3.0), history, null, shizuokaOptions);
        expect(result.error).toBe('日の出・日の入データなし');
    });

    it('当日の基準ハウス履歴がない場合はデータ待機中を返す', () => {
        const result = calculateWateringGuide(refData, history, null, {
            ...shizuokaOptions,
            now: jst('2026-07-05T12:00:00'), // 履歴は前日分になる
        });
        expect(result.error).toBe('データ待機中');
        expect(result.endTime).toBe('15:00'); // 日没19:00 - 4h
    });

    it('基準ハウスフィルタに合致しない履歴は無視される', () => {
        const result = calculateWateringGuide(refData, history, null, {
            ...shizuokaOptions,
            refHouseFilter: d => d.location.includes('8号'),
        });
        expect(result.error).toBe('データ待機中');
    });

    it('1.0MJ 刻みのマーク時刻を確定する（特性テスト）', () => {
        const result = calculateWateringGuide(refData, history, null, shizuokaOptions);

        expect(result.times).toEqual([
            { time: '08:30', mj: 1.0, type: 'start', diff: 0 },
            { time: '10:30', mj: 2.1, type: 'water', diff: 0.1, isFinal: true },
        ]);
        expect(result.currentStatus).toEqual({
            currentMJ: 2.4,
            nextTarget: 2.0,
            progress: 1.4,
        });
        expect(result.referenceMJ).toBe(2.4); // 15:00 に最も近い 11:00 時点の値
        expect(result.startTime).toBe('06:40'); // 日の出 04:40 + 2h
        expect(result.endTime).toBe('15:00');
        expect(result.sunrise).toBe('04:40');
        expect(result.sunset).toBe('19:00');
    });

    it('照明設定があると LED 換算分が有効MJに加算される', () => {
        const result = calculateWateringGuide(
            refData,
            history,
            { start: '01:00', end: '11:00' },
            shizuokaOptions
        );
        // 11:00 時点: 実測 2.4 + LED 10h * 0.09 = 3.3
        expect(result.currentStatus.currentMJ).toBe(3.3);
    });
});
