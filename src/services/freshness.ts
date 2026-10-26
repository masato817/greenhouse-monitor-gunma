import { EnvironmentData } from '../types';
import { formatJapanese, formatIsoJst } from '../utils';

/** この分数より古いデータは「データが古い」帯を出す */
export const STALE_THRESHOLD_MINUTES = 60;

export interface StaleHouse {
    label: string;
    time: string;
}

/**
 * ダッシュボードのヘッダ表示用の鮮度情報
 * - updatedAt: 表示中データのうち最新の計測時刻（実行時刻ではない）
 * - dataTimeIso: ブラウザ側で経過時間を再判定するための ISO 文字列
 * - isStale: 生成時点で最新データが閾値より古い
 * - staleHouses: 生成時点で閾値より古いハウス（一部ソースだけ止まっている場合の表示用）
 */
export interface FreshnessInfo {
    dataTime: Date | null;
    updatedAt: string;
    dataTimeIso: string;
    isStale: boolean;
    ageText: string;
    staleHouses: StaleHouse[];
    thresholdMinutes: number;
}

/** 経過分を「X分」「X時間」「X日」の粗い表記にする（テンプレートのJSと同じ規則） */
export function formatAge(minutes: number): string {
    if (minutes < 60) return `${Math.max(0, Math.floor(minutes))}分`;
    if (minutes < 60 * 48) return `${Math.floor(minutes / 60)}時間`;
    return `${Math.floor(minutes / 60 / 24)}日`;
}

/**
 * 表示対象ハウスのデータから鮮度情報を作る
 * @param houses ラベルと表示データの組（データ無しのハウスは判定から除外）
 * @param now 判定基準時刻
 */
export function buildFreshness(
    houses: Array<{ label: string; data?: Partial<EnvironmentData> }>,
    now: Date,
    thresholdMinutes: number = STALE_THRESHOLD_MINUTES
): FreshnessInfo {
    const timed = houses
        .filter(h => h.data?.timestamp instanceof Date && !isNaN(h.data.timestamp.getTime()))
        .map(h => ({ label: h.label, timestamp: h.data!.timestamp as Date }));

    if (timed.length === 0) {
        return {
            dataTime: null,
            updatedAt: '-',
            dataTimeIso: '',
            isStale: true,
            ageText: '',
            staleHouses: [],
            thresholdMinutes,
        };
    }

    const newest = timed.reduce((a, b) => (b.timestamp > a.timestamp ? b : a)).timestamp;
    const ageMinutes = (now.getTime() - newest.getTime()) / 60000;
    const isStale = ageMinutes > thresholdMinutes;

    // ページ全体が古い場合は全ハウスが該当するため、一部だけ古い場合に限り列挙する
    const staleHouses = isStale
        ? []
        : timed
            .filter(h => (now.getTime() - h.timestamp.getTime()) / 60000 > thresholdMinutes)
            .map(h => ({ label: h.label, time: formatJapanese(h.timestamp, 'MM/dd HH:mm') }));

    return {
        dataTime: newest,
        updatedAt: formatJapanese(newest, 'yy/MM/dd HH:mm'),
        dataTimeIso: formatIsoJst(newest),
        isStale,
        ageText: formatAge(ageMinutes),
        staleHouses,
        thresholdMinutes,
    };
}
