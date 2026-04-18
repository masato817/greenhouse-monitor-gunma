import fs from 'fs/promises';
import path from 'path';
import handlebars from 'handlebars';
import { EnvironmentData, WateringGuideMark } from '../types';
import { logger, formatJapanese, getEnv } from '../utils';
import { GoogleSheetsService } from './sheets';
import { HistoryAnalyzer } from './history-analyzer';

// Handlebarsヘルパーを一度だけ登録するためのフラグ
let helpersRegistered = false;

/**
 * Handlebarsヘルパーを登録（一度だけ）
 */
function registerHandlebarsHelpers(): void {
    if (helpersRegistered) return;

    handlebars.registerHelper('formatNum', function (val) {
        return val !== undefined && val !== null ? Number(val).toFixed(1) : '-';
    });

    handlebars.registerHelper('formatInt', function (val) {
        return val !== undefined && val !== null ? Number(val).toFixed(0) : '-';
    });

    handlebars.registerHelper('formatTime', function (val) {
        if (!val) return '--:--';
        const str = String(val);
        if (str.includes(':')) {
            if (str.length > 8) {
                const match = str.match(/(\d{1,2}:\d{2})/);
                if (match) return match[1];
                const d = new Date(str);
                if (!isNaN(d.getTime())) {
                    const h = d.getHours().toString().padStart(2, '0');
                    const m = d.getMinutes().toString().padStart(2, '0');
                    return `${h}:${m}`;
                }
            }
            return str.substring(0, 5);
        }
        return val;
    });

    handlebars.registerHelper('eq', function (arg1, arg2) {
        return arg1 == arg2;
    });

    handlebars.registerHelper('subtract', function (a, b) {
        return Number(a) - Number(b);
    });

    handlebars.registerHelper('multiply', function (a, b) {
        return Number(a) * Number(b);
    });

    // 日本語フォーマットヘルパー
    handlebars.registerHelper('formatJapanese', function (date, formatStr) {
        if (!date) return '-';
        const d = date instanceof Date ? date : new Date(date);
        if (isNaN(d.getTime())) return '-';
        return formatJapanese(d, formatStr || 'yyyy/MM/dd HH:mm');
    });

    helpersRegistered = true;
    logger.info('[Gunma] Handlebarsヘルパーを登録しました');
}

/**
 * 群馬農場版: リッチ・ダッシュボード生成器
 *
 * 静岡(DashboardGenerator)と同一レイアウトで 8号/9号 の2棟を表示する。
 * 基準ハウスは 8号（外日射、積算日射・潅水目安のリファレンス）。
 */
export class GunmaDashboardGenerator {
    private templatePath: string;
    private outputPath: string;

    constructor() {
        this.templatePath = path.join(process.cwd(), 'src', 'templates', 'gunma.hbs');
        this.outputPath = path.join(process.cwd(), 'public', 'gunma.html');
        registerHandlebarsHelpers();
    }

    async generate(dataList: EnvironmentData[], historyList: EnvironmentData[] = []): Promise<void> {
        logger.info(`[Gunma] Generating dashboard HTML... History count: ${historyList.length}`);

        try {
            const templateContent = await fs.readFile(this.templatePath, 'utf-8');
            const template = handlebars.compile(templateContent);

            // 群馬は 8号/9号 の2棟構成
            const houses: any = {
                house8: dataList.find(d => d.location.includes('8号')) || {},
                house9: dataList.find(d => d.location.includes('9号')) || {},
            };

            // LED累積計算ヘルパー
            const calculateLedMJ = (lightingStart: string | undefined, lightingEnd: string | undefined, timestamp: Date): number => {
                const COEFF_LED = 0.09;
                if (!lightingStart || !lightingEnd) return 0;

                const parseToMin = (t: string) => {
                    const parts = t.split(':');
                    if (parts.length === 2) return parseInt(parts[0]) * 60 + parseInt(parts[1]);
                    return 0;
                };

                const s = parseToMin(lightingStart);
                const e = parseToMin(lightingEnd);
                const currentMin = timestamp.getHours() * 60 + timestamp.getMinutes();

                let durationHour = 0;
                if (currentMin > s) {
                    const effectiveEnd = Math.min(currentMin, e);
                    if (effectiveEnd > s) {
                        durationHour = (effectiveEnd - s) / 60;
                    }
                }
                return durationHour * COEFF_LED;
            };

            const sheetsService = new GoogleSheetsService();

            // ハウス設定を先に読み込み、照明時間を houses に反映
            const houseConfigs = await sheetsService.getHouseConfigs();
            const currentMonth = new Date().getMonth() + 1;
            logger.info(`[Gunma] Current month for threshold check: ${currentMonth}`);

            for (const key of Object.keys(houses)) {
                let configKey = '';
                if (key === 'house8') configKey = '8号';
                else if (key === 'house9') configKey = '9号';

                if (configKey && houseConfigs.has(configKey)) {
                    const cfg = houseConfigs.get(configKey);
                    houses[key].area = cfg?.area || 10;
                    if (cfg?.lightingStartTime) houses[key].lightingStartTime = cfg.lightingStartTime;
                    if (cfg?.lightingEndTime) houses[key].lightingEndTime = cfg.lightingEndTime;
                } else {
                    houses[key].area = 10;
                }

                houses[key].ledAccumulation = calculateLedMJ(
                    houses[key].lightingStartTime,
                    houses[key].lightingEndTime,
                    new Date()
                );
            }

            // 潅水目安計算
            // - 基準ハウス: 8号（外日射）の積算日射で評価
            // - 日の出・日の入: 8号
            // - LED: 8号 の照明設定
            const refConfig = {
                start: houses.house8?.lightingStartTime,
                end: houses.house8?.lightingEndTime,
            };
            const wateringGuide = this.calculateWateringGuide(houses.house8, historyList, refConfig);

            // 潅水目安をスプシ保存 (群馬_潅水目安履歴)
            if (wateringGuide && wateringGuide.times && wateringGuide.times.length > 0) {
                const today = new Date();
                const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

                const marks: WateringGuideMark[] = wateringGuide.times.map((t: any, index: number) => ({
                    number: index + 1,
                    time: t.time,
                    mj: t.mj,
                    targetMJ: t.type === 'start' ? '開始' : `${(index * 1.0 + 2.0).toFixed(1)}`,
                    diff: t.type === 'start' ? null : t.diff,
                }));

                let dailyTotalSolar: number | undefined;
                if (houses.house8 && houses.house8.accumulatedSolarRadiation) {
                    dailyTotalSolar = houses.house8.accumulatedSolarRadiation;
                }

                await sheetsService.saveWateringGuide('群馬', dateStr, marks, dailyTotalSolar);
            }

            // 過去7日分の履歴を読み込み (群馬)
            const wateringGuideHistory = await sheetsService.getWateringGuideHistory('群馬', 7);

            // 異常期間の分析
            let anomalyPeriods: any[] = [];
            const thresholds = await sheetsService.getThresholds();

            let rawHistoryForAnalyzer = historyList;
            if (rawHistoryForAnalyzer.length < 1000) {
                logger.info(`[Gunma] historyList件数不足(${rawHistoryForAnalyzer.length})のため、群馬1000件を再取得します`);
                rawHistoryForAnalyzer = await sheetsService.getRawHistoryData(1000, '群馬');
            }
            const analyzer = new HistoryAnalyzer();
            anomalyPeriods = analyzer.analyze(rawHistoryForAnalyzer, thresholds);

            const viewData = {
                updatedAt: formatJapanese(new Date(), 'yy/MM/dd HH:mm'),
                houses: houses,
                wateringGuide: wateringGuide,
                wateringGuideHistory: wateringGuideHistory,
                anomalyPeriods: anomalyPeriods,
                currentMonth: currentMonth,
                thresholds: thresholds,
                effectiveSolar: (wateringGuide && wateringGuide.times && wateringGuide.times.length > 0)
                    ? wateringGuide.times[wateringGuide.times.length - 1].mj
                    : (houses.house8.accumulatedSolarRadiation || 0),
                referenceSolar: (wateringGuide && wateringGuide.referenceMJ)
                    ? wateringGuide.referenceMJ
                    : (houses.house8.accumulatedSolarRadiation || 0),
                refreshInterval: getEnv('DASHBOARD_REFRESH_SECONDS', '300'),
            };

            // 動的ヘルパー（閾値データに依存するため、generate()呼び出しごとに再登録）
            handlebars.registerHelper('calcWateringEstimate', function (accumulatedSolar, _lightingStart, _lightingEnd, area) {
                const AREA = area || 10;
                const LITER_PER_MJ = 250;
                const mj = accumulatedSolar ? Number(accumulatedSolar) : 0;
                const count = Math.floor(mj);
                const est = AREA * count * LITER_PER_MJ;
                return Math.floor(est).toLocaleString();
            });

            handlebars.registerHelper('checkThreshold', function (house: string, item: string, value: any) {
                if (value === undefined || value === null) {
                    return { value: '-', isAbnormal: false };
                }

                const key = `${currentMonth}-${house}-${item}`;
                const threshold = thresholds[key];

                if (!threshold) {
                    return { value: value, isAbnormal: false };
                }

                const numValue = Number(value);
                const isAbnormal = numValue < threshold.minValue || numValue > threshold.maxValue;

                return { value: value, isAbnormal: isAbnormal };
            });

            const html = template(viewData);

            await fs.mkdir(path.dirname(this.outputPath), { recursive: true });
            await fs.writeFile(this.outputPath, html, 'utf-8');
            logger.info(`[Gunma] Dashboard generated at ${this.outputPath}`);

        } catch (error) {
            logger.error(`[Gunma] Failed to generate dashboard: ${error}`);
        }
    }

    /**
     * 潅水目安計算 (DashboardGenerator.calculateWateringGuide と同一ロジック)
     * - 基準ハウス: Gunma は 8号 の履歴で評価
     * - history のうち 8号 の当日データを抽出
     */
    private calculateWateringGuide(
        refHouseData: EnvironmentData,
        history: EnvironmentData[],
        lightingConfig: { start?: string, end?: string } | null = null
    ): any {
        if (!refHouseData || !refHouseData.sunrise || !refHouseData.sunset) {
            return { error: '日の出・日の入データなし' };
        }

        const parseTime = (str: string | undefined): number | null => {
            if (!str) return null;
            let timeStr = str;
            if (str.length > 10) {
                const match = str.match(/(\d{1,2}:\d{2})/);
                if (match) timeStr = match[1];
                else {
                    const d = new Date(str);
                    if (!isNaN(d.getTime())) {
                        timeStr = `${d.getHours()}:${d.getMinutes()}`;
                    }
                }
            }
            if (timeStr.indexOf(':') === -1) return null;
            const parts = timeStr.split(':');
            return parseInt(parts[0]) * 60 + parseInt(parts[1]);
        };

        const formatTime = (min: number): string => {
            const h = Math.floor(min / 60);
            const m = min % 60;
            return (h < 10 ? '0' + h : h) + ':' + (m < 10 ? '0' + m : m);
        };

        const sunriseTime = parseTime(refHouseData.sunrise);
        const sunsetTime = parseTime(refHouseData.sunset);

        if (sunriseTime === null || sunsetTime === null) {
            return { error: '時間形式エラー', rawSunrise: refHouseData.sunrise, rawSunset: refHouseData.sunset };
        }

        const endTime = sunsetTime - (4 * 60);
        const intervalMJ = 1.0;

        const today = new Date();

        // 基準ハウス(8号) の当日履歴を抽出
        const refHistory = history.filter(d =>
            d.location.includes('8号') &&
            d.timestamp.getFullYear() === today.getFullYear() &&
            d.timestamp.getMonth() === today.getMonth() &&
            d.timestamp.getDate() === today.getDate()
        );
        logger.info(`[Gunma] WateringGuide: Today's 8号 history count: ${refHistory.length}`);

        if (refHistory.length === 0) {
            return {
                error: 'データ待機中',
                sunrise: refHouseData.sunrise,
                sunset: refHouseData.sunset,
                endTime: formatTime(endTime)
            };
        }

        refHistory.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

        const guideTimes: any[] = [];
        const COEFF_LED = 0.09;
        const calculateEffectiveMJ = (solarMJ: number, timestamp: Date): number => {
            let ledMJ = 0;
            if (lightingConfig && lightingConfig.start && lightingConfig.end) {
                const s = parseTime(lightingConfig.start);
                const e = parseTime(lightingConfig.end);
                if (s !== null && e !== null) {
                    const currentMin = timestamp.getHours() * 60 + timestamp.getMinutes();
                    if (currentMin > s) {
                        const effectiveEnd = Math.min(currentMin, e);
                        if (effectiveEnd > s) {
                            const durationHour = (effectiveEnd - s) / 60;
                            ledMJ = durationHour * COEFF_LED;
                        }
                    }
                }
            }
            return solarMJ + ledMJ;
        };

        let validStartFound = false;
        const endTimeExtended = endTime + 30;
        let currentTargetMJ = 1.0;
        const searchStartOffset = 0.4;
        let provisional: { data: EnvironmentData, min: number, effectiveMJ: number, distanceToTarget: number } | null = null;

        for (let i = 0; i < refHistory.length; i++) {
            const d = refHistory[i];
            const min = d.timestamp.getHours() * 60 + d.timestamp.getMinutes();
            const rawMJ = d.accumulatedSolarRadiation;

            if (rawMJ === undefined || rawMJ === null) continue;
            if (min > endTimeExtended) break;

            const effectiveMJ = calculateEffectiveMJ(rawMJ, d.timestamp);
            const nextTargetSearchStart = currentTargetMJ + 1.0 - searchStartOffset;

            if (effectiveMJ >= nextTargetSearchStart) {
                if (provisional) {
                    validStartFound = true;
                    guideTimes.push({
                        time: formatTime(provisional.min),
                        mj: provisional.effectiveMJ,
                        type: guideTimes.length === 0 ? 'start' : 'water',
                        diff: parseFloat((provisional.effectiveMJ - currentTargetMJ).toFixed(1))
                    });
                    provisional = null;
                }
                currentTargetMJ += intervalMJ;
                while (effectiveMJ >= currentTargetMJ + 1.0 - searchStartOffset) {
                    currentTargetMJ += intervalMJ;
                }
            }

            const currentSearchStart = currentTargetMJ - searchStartOffset;

            if (effectiveMJ >= currentSearchStart) {
                const distanceToTarget = Math.abs(effectiveMJ - currentTargetMJ);

                if (!provisional) {
                    provisional = { data: d, min: min, effectiveMJ: effectiveMJ, distanceToTarget: distanceToTarget };
                } else {
                    if (distanceToTarget < provisional.distanceToTarget) {
                        provisional = { data: d, min: min, effectiveMJ: effectiveMJ, distanceToTarget: distanceToTarget };
                    }
                }
            }
        }

        if (provisional) {
            validStartFound = true;
            guideTimes.push({
                time: formatTime(provisional.min),
                mj: provisional.effectiveMJ,
                type: guideTimes.length === 0 ? 'start' : 'water',
                diff: parseFloat((provisional.effectiveMJ - currentTargetMJ).toFixed(1))
            });
        }

        if (guideTimes.length > 0) {
            guideTimes[guideTimes.length - 1].isFinal = true;
        }

        // 基準日射 (日没 -4H 付近)
        let referenceMJ = 0;
        let refDiff = 9999;
        for (const d of refHistory) {
            const min = d.timestamp.getHours() * 60 + d.timestamp.getMinutes();
            const currentMJ = d.accumulatedSolarRadiation;
            if (currentMJ !== undefined && currentMJ !== null) {
                const diff = Math.abs(min - endTime);
                if (diff < refDiff) {
                    refDiff = diff;
                    referenceMJ = calculateEffectiveMJ(currentMJ, d.timestamp);
                }
            }
        }

        // 現況 (最新測定)
        let currentStatus = null;
        if (refHistory.length > 0) {
            const lastData = refHistory[refHistory.length - 1];
            const lastMin = lastData.timestamp.getHours() * 60 + lastData.timestamp.getMinutes();
            if (lastMin <= endTimeExtended) {
                const currentMJ = lastData.accumulatedSolarRadiation;
                if (currentMJ !== undefined && currentMJ !== null) {
                    const currentSolarMJ = lastData.accumulatedSolarRadiation || 0;
                    const currentEffectiveMJ = calculateEffectiveMJ(currentSolarMJ, lastData.timestamp);

                    let targetBase = 1.0;
                    if (guideTimes.length > 0) {
                        targetBase = currentTargetMJ;
                    }

                    currentStatus = {
                        currentMJ: parseFloat(currentEffectiveMJ.toFixed(1)),
                        nextTarget: parseFloat(targetBase.toFixed(1)),
                        progress: parseFloat((currentEffectiveMJ - (targetBase - intervalMJ)).toFixed(1))
                    };
                }
            }
        }

        // validStartFound は guideTimes の非空と同義のため未使用警告回避
        void validStartFound;

        const startTime = sunriseTime + (2 * 60);

        return {
            times: guideTimes,
            sunrise: refHouseData.sunrise,
            sunset: refHouseData.sunset,
            startTime: formatTime(startTime),
            endTime: formatTime(endTime),
            currentStatus: currentStatus,
            referenceMJ: referenceMJ
        };
    }
}
