import { EnvironmentData, ThresholdMap, AnomalyPeriod } from '../types';
import { logger, resolveHouseName } from '../utils';

export class HistoryAnalyzer {
    // 異常とみなす最小継続時間（分）- これ未満の一時的な異常は無視するなど（今回はすべての異常を検知してからマージする方針）
    // private readonly MIN_DURATION_MINUTES = 10; 

    /**
     * 履歴データを分析して、異常期間のリストを返します
     * @param historyList 履歴データのリスト（時系列昇順または降順、どちらでも対応可）
     * @param thresholds 閾値設定
     * @returns 異常期間のリスト（新しい順）
     */
    analyze(historyList: EnvironmentData[], thresholds: ThresholdMap): AnomalyPeriod[] {
        // 時系列昇順にソート（古い -> 新しい）
        const sortedHistory = [...historyList].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

        const anomalies: AnomalyPeriod[] = [];

        // 分析対象のハウスと項目
        // ハウス名はデータ中の location 文字列に含まれるもの ("1号", "2号"...)
        // データソースが 'profarm' の場合は "1号" とみなすなどのマッピングが必要

        const targetHouses = ['1号', '2号', '3号', '4号'];
        const targetItems = [
            { key: 'temperature', name: '気温(℃)' },
            { key: 'humidity', name: '湿度(%)' },
            { key: 'co2', name: 'CO2(ppm)' }
        ];

        targetHouses.forEach(house => {
            targetItems.forEach(itemConfig => {
                const itemAnomalies = this.analyzeItem(sortedHistory, house, itemConfig, thresholds);
                anomalies.push(...itemAnomalies);
            });
        });

        // 新しい順（降順）にソートして返す
        return anomalies.sort((a, b) => b.endTime.getTime() - a.endTime.getTime());
    }

    private analyzeItem(
        history: EnvironmentData[],
        house: string,
        itemConfig: { key: string, name: string },
        thresholds: ThresholdMap
    ): AnomalyPeriod[] {
        const result: AnomalyPeriod[] = [];
        let currentPeriod: AnomalyPeriod | null = null;

        for (const data of history) {
            // このデータのハウスを特定
            const dataHouse = resolveHouseName(data);
            if (dataHouse !== house) continue;

            // 値を取得
            const val = (data as any)[itemConfig.key];
            if (val === undefined || val === null || val === '') continue;

            const numVal = Number(val);
            if (isNaN(numVal)) continue;

            // その時点の月の閾値を取得
            // データのタイムスタンプから月を取得
            const month = data.timestamp.getMonth() + 1;
            const thresholdKey = `${month}-${house}-${itemConfig.name}`;
            const threshold = thresholds[thresholdKey];

            if (!threshold) continue;

            // 判定
            let isAnomaly = false;
            let type: 'upper' | 'lower' | null = null;
            let thresholdValue = 0;

            if (numVal > threshold.maxValue) {
                isAnomaly = true;
                type = 'upper';
                thresholdValue = threshold.maxValue;
            } else if (numVal < threshold.minValue) {
                isAnomaly = true;
                type = 'lower';
                thresholdValue = threshold.minValue;
            }

            if (isAnomaly && type) {
                if (currentPeriod) {
                    // 継続中
                    // タイプが変わった場合（上限超え -> 下限割れ）はどうするか？
                    // 一旦区切る実装にします。
                    if (currentPeriod.type === type) {
                        currentPeriod.endTime = data.timestamp;
                        // 最大逸脱値の更新（upperは最大値、lowerは最小値を記録）
                        if (type === 'upper') {
                            if (numVal > currentPeriod.maxValue) currentPeriod.maxValue = numVal;
                        } else {
                            if (numVal < currentPeriod.maxValue || currentPeriod.maxValue === 0) currentPeriod.maxValue = numVal;
                        }
                    } else {
                        // タイプが変わったので前の期間を終了し、新しい期間を開始
                        currentPeriod.durationString = this.calcDuration(currentPeriod.startTime, currentPeriod.endTime);
                        result.push(currentPeriod);

                        currentPeriod = {
                            startTime: data.timestamp,
                            endTime: data.timestamp,
                            house: house,
                            item: itemConfig.name,
                            maxValue: numVal,
                            thresholdValue: thresholdValue,
                            type: type,
                            durationString: ''
                        };
                    }
                } else {
                    // 新規開始
                    currentPeriod = {
                        startTime: data.timestamp,
                        endTime: data.timestamp,
                        house: house,
                        item: itemConfig.name,
                        maxValue: numVal,
                        thresholdValue: thresholdValue,
                        type: type,
                        durationString: ''
                    };
                }
            } else {
                // 正常値に戻った
                if (currentPeriod) {
                    currentPeriod.durationString = this.calcDuration(currentPeriod.startTime, currentPeriod.endTime);
                    result.push(currentPeriod);
                    currentPeriod = null;
                }
            }
        }

        // ループ終了時に継続中のものがあれば追加
        if (currentPeriod) {
            currentPeriod.durationString = this.calcDuration(currentPeriod.startTime, currentPeriod.endTime);
            result.push(currentPeriod);
        }

        return result;
    }

    private calcDuration(start: Date, end: Date): string {
        const diffMs = end.getTime() - start.getTime();
        const minutes = Math.floor(diffMs / 60000);

        if (minutes < 60) {
            return `${minutes}分`;
        } else {
            const h = Math.floor(minutes / 60);
            const m = minutes % 60;
            return `${h}時間${m}分`;
        }
    }
}
