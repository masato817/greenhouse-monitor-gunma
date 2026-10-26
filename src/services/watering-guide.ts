import { EnvironmentData } from '../types';
import { logger, formatJapanese } from '../utils';

/** LED 補光の日射換算係数 (MJ/h) */
export const COEFF_LED = 0.09;

export interface LightingConfig {
    start?: string;
    end?: string;
}

export interface WateringGuideOptions {
    /** 基準ハウスの履歴を抽出する述語（静岡=1号/profarm、群馬=8号） */
    refHouseFilter: (d: EnvironmentData) => boolean;
    /** ログの接頭辞（例: '[Gunma] '） */
    logPrefix?: string;
    /** 「当日」の基準時刻。テスト用に注入可能（省略時は現在時刻） */
    now?: Date;
}

/**
 * 'HH:mm' や日時文字列から分単位の時刻を取り出す
 * @returns 解釈できない場合は null
 */
export function parseTimeToMinutes(str: string | undefined): number | null {
    if (!str) return null;
    let timeStr = str;
    // シート由来のフル日時文字列にも対応
    if (str.length > 10) {
        const match = str.match(/(\d{1,2}:\d{2})/);
        if (match) timeStr = match[1];
        else {
            const d = new Date(str);
            if (!isNaN(d.getTime())) {
                timeStr = formatJapanese(d, 'H:mm');
            }
        }
    }
    if (timeStr.indexOf(':') === -1) return null;
    const parts = timeStr.split(':');
    return parseInt(parts[0]) * 60 + parseInt(parts[1]);
}

/** 分単位の時刻を 'HH:mm' に整形する */
export function formatMinutes(min: number): string {
    const h = Math.floor(min / 60);
    const m = min % 60;
    return (h < 10 ? '0' + h : h) + ':' + (m < 10 ? '0' + m : m);
}

/** JST 固定でその日の経過分を返す（実行環境のTZに依存しない） */
export function jstMinutesOfDay(date: Date): number {
    const [h, m] = formatJapanese(date, 'HH:mm').split(':').map(Number);
    return h * 60 + m;
}

/**
 * LED 補光の累積日射換算値 (MJ) を計算する
 * 開始 > 終了 は日跨ぎ点灯（例: 22:00→06:00）として扱う
 */
export function calculateLedMJ(
    lightingStart: string | undefined,
    lightingEnd: string | undefined,
    timestamp: Date
): number {
    if (!lightingStart || !lightingEnd) return 0;

    const s = parseTimeToMinutes(lightingStart);
    const e = parseTimeToMinutes(lightingEnd);
    if (s === null || e === null) return 0;
    const currentMin = jstMinutesOfDay(timestamp);

    // 点灯済みの分数
    let litMin = 0;
    if (s < e) {
        // 同日内: 開始前は0、点灯中は経過分、消灯後は全点灯時間
        litMin = currentMin > s ? Math.min(currentMin, e) - s : 0;
    } else if (s > e) {
        if (currentMin >= s) {
            litMin = currentMin - s; // 当日の点灯開始後
        } else if (currentMin < e) {
            litMin = (1440 - s) + currentMin; // 前日から続く早朝の点灯中
        } else {
            litMin = (1440 - s) + e; // 消灯後: 全点灯時間
        }
    }
    return (litMin / 60) * COEFF_LED;
}

/**
 * 潅水目安（積算日射 1.0MJ 刻みのマーク時刻）を計算する
 * 静岡・群馬の両ダッシュボード生成器から共通利用される
 *
 * ロジック [2026-01-11]:
 * - ターゲット-0.4MJ から暫定記録開始、よりターゲットに近い値で書き換え
 *   （同距離なら最初の時刻を優先）
 * - 次のターゲット-0.4MJ に達したら現在のターゲットを確定
 */
export function calculateWateringGuide(
    refHouseData: EnvironmentData,
    history: EnvironmentData[],
    lightingConfig: LightingConfig | null,
    options: WateringGuideOptions
): any {
    const logPrefix = options.logPrefix ?? '';
    const now = options.now ?? new Date();

    if (!refHouseData || !refHouseData.sunrise || !refHouseData.sunset) {
        return { error: '日の出・日の入データなし' };
    }

    const sunriseTime = parseTimeToMinutes(refHouseData.sunrise);
    const sunsetTime = parseTimeToMinutes(refHouseData.sunset);

    if (sunriseTime === null || sunsetTime === null) {
        return { error: '時間形式エラー', rawSunrise: refHouseData.sunrise, rawSunset: refHouseData.sunset };
    }

    // 終了時間の基準: 日没 - 4時間
    const endTime = sunsetTime - (4 * 60);
    const intervalMJ = 1.0;

    // 基準ハウスの当日履歴を抽出（JST 基準で日付比較）
    const todayJst = formatJapanese(now, 'yyyy-MM-dd');
    const refHistory = history.filter(d =>
        options.refHouseFilter(d) &&
        formatJapanese(d.timestamp, 'yyyy-MM-dd') === todayJst
    );
    logger.info(`${logPrefix}WateringGuide: Today's history count: ${refHistory.length}. Today: ${todayJst}`);

    if (refHistory.length === 0) {
        return {
            error: 'データ待機中',
            sunrise: refHouseData.sunrise,
            sunset: refHouseData.sunset,
            endTime: formatMinutes(endTime)
        };
    }

    refHistory.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    const calculateEffectiveMJ = (solarMJ: number, timestamp: Date): number => {
        if (!lightingConfig || !lightingConfig.start || !lightingConfig.end) return solarMJ;
        return solarMJ + calculateLedMJ(lightingConfig.start, lightingConfig.end, timestamp);
    };

    const guideTimes: any[] = [];
    // 終了時刻を30分延長（検索バッファ）
    const endTimeExtended = endTime + 30;

    let currentTargetMJ = 1.0; // 現在のターゲット
    const searchStartOffset = 0.4; // ターゲット-0.4から探索開始

    // 暫定記録
    let provisional: { min: number, effectiveMJ: number, distanceToTarget: number } | null = null;

    const confirmProvisional = () => {
        if (!provisional) return;
        guideTimes.push({
            time: formatMinutes(provisional.min),
            mj: provisional.effectiveMJ,
            type: guideTimes.length === 0 ? 'start' : 'water',
            diff: parseFloat((provisional.effectiveMJ - currentTargetMJ).toFixed(1))
        });
        provisional = null;
    };

    for (const d of refHistory) {
        const min = jstMinutesOfDay(d.timestamp);
        const rawMJ = d.accumulatedSolarRadiation;
        if (rawMJ === undefined || rawMJ === null) continue;
        // 終了時刻(+30分)を過ぎたら探索終了
        if (min > endTimeExtended) break;

        const effectiveMJ = calculateEffectiveMJ(rawMJ, d.timestamp);

        // 次のターゲットの探索範囲に入った = 現在のターゲットは確定
        if (effectiveMJ >= currentTargetMJ + intervalMJ - searchStartOffset) {
            confirmProvisional();
            currentTargetMJ += intervalMJ;
            // 一気に複数ターゲット分跳んだ場合は、間のターゲットを記録なしで飛ばす
            while (effectiveMJ >= currentTargetMJ + intervalMJ - searchStartOffset) {
                currentTargetMJ += intervalMJ;
            }
        }

        // 現在のターゲットの探索範囲（ターゲット-0.4以上）なら暫定記録を更新
        if (effectiveMJ >= currentTargetMJ - searchStartOffset) {
            const distanceToTarget = Math.abs(effectiveMJ - currentTargetMJ);
            // 同距離なら最初の時刻を優先（書き換えしない）
            if (!provisional || distanceToTarget < provisional.distanceToTarget) {
                provisional = { min, effectiveMJ, distanceToTarget };
            }
        }
    }

    // ループ終了後、最後の暫定記録があれば確定
    confirmProvisional();

    if (guideTimes.length > 0) {
        guideTimes[guideTimes.length - 1].isFinal = true;
    }

    // 基準日射: endTime (日没-4H) に最も近い時刻の有効MJ
    let referenceMJ = 0;
    let refDiff = 9999;
    for (const d of refHistory) {
        const min = jstMinutesOfDay(d.timestamp);
        const currentMJ = d.accumulatedSolarRadiation;
        if (currentMJ !== undefined && currentMJ !== null) {
            const diff = Math.abs(min - endTime);
            if (diff < refDiff) {
                refDiff = diff;
                referenceMJ = calculateEffectiveMJ(currentMJ, d.timestamp);
            }
        }
    }

    // 現況（最新測定）: 終了時刻+30分以内のみ表示
    let currentStatus = null;
    const lastData = refHistory[refHistory.length - 1];
    const lastMin = jstMinutesOfDay(lastData.timestamp);
    if (lastMin <= endTimeExtended) {
        const currentSolarMJ = lastData.accumulatedSolarRadiation;
        if (currentSolarMJ !== undefined && currentSolarMJ !== null) {
            const currentEffectiveMJ = calculateEffectiveMJ(currentSolarMJ, lastData.timestamp);
            // 次に達成すべき目標: ガイドが1つでも確定していれば現在のターゲット、なければ 1.0
            const targetBase = guideTimes.length > 0 ? currentTargetMJ : 1.0;
            currentStatus = {
                currentMJ: parseFloat(currentEffectiveMJ.toFixed(1)),
                nextTarget: parseFloat(targetBase.toFixed(1)),
                progress: parseFloat((currentEffectiveMJ - (targetBase - intervalMJ)).toFixed(1))
            };
        }
    }

    // 日の出+2時間
    const startTime = sunriseTime + (2 * 60);

    return {
        times: guideTimes,
        sunrise: refHouseData.sunrise,
        sunset: refHouseData.sunset,
        startTime: formatMinutes(startTime),
        endTime: formatMinutes(endTime),
        currentStatus: currentStatus,
        referenceMJ: referenceMJ
    };
}
