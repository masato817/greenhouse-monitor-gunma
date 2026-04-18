import fs from 'fs/promises';
import path from 'path';
import handlebars from 'handlebars';
import { EnvironmentData, WateringGuideMark, ThresholdMap } from '../types';
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
    logger.info('Handlebarsヘルパーを登録しました');
}

export class DashboardGenerator {
    private templatePath: string;
    private outputPath: string;

    constructor() {
        this.templatePath = path.join(process.cwd(), 'src', 'templates', 'index.hbs');
        this.outputPath = path.join(process.cwd(), 'public', 'index.html');

        // ヘルパーを登録
        registerHandlebarsHelpers();
    }

    async generate(dataList: EnvironmentData[], historyList: EnvironmentData[] = []): Promise<void> {
        logger.info(`Generating dashboard HTML with Watering Guide... History count: ${historyList.length}`);

        try {
            // Load template
            const templateContent = await fs.readFile(this.templatePath, 'utf-8');
            const template = handlebars.compile(templateContent);

            // Group data by location (simple mapping for now)
            const houses: any = {
                // 1号棟はProfarmデータ、または名前で検索
                house1: dataList.find(d => d.source === 'profarm') || dataList.find(d => d.location.includes('1号')) || {},
                house2: dataList.find(d => d.location.includes('2号')) || {},
                house3: dataList.find(d => d.location.includes('3号')) || {},
                house4: dataList.find(d => d.location.includes('4号')) || {},
            };

            // Helper for LED Calculation
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

            // Initialize Sheets Service early
            const sheetsService = new GoogleSheetsService();

            // Load House Configs FIRST to ensure lighting times are available for calculation
            const houseConfigs = await sheetsService.getHouseConfigs();
            const currentMonth = new Date().getMonth() + 1; // 1-12
            logger.info(`Current month for threshold check: ${currentMonth}`);
            logger.info(`House Configs: ${JSON.stringify(Array.from(houseConfigs.entries()))}`);

            // Enrich houses with config data
            for (const key of Object.keys(houses)) {
                // key is house1, house2..
                // map keys are 1号, 2号...
                let configKey = '';
                if (key === 'house1') configKey = '1号';
                else if (key === 'house2') configKey = '2号';
                else if (key === 'house3') configKey = '3号';
                else if (key === 'house4') configKey = '4号';

                if (configKey && houseConfigs.has(configKey)) {
                    const cfg = houseConfigs.get(configKey);
                    houses[key].area = cfg?.area || 10;
                    // If config has lighting times, override or set them
                    if (cfg?.lightingStartTime) houses[key].lightingStartTime = cfg.lightingStartTime;
                    if (cfg?.lightingEndTime) houses[key].lightingEndTime = cfg.lightingEndTime;
                } else {
                    houses[key].area = 10; // Default
                }

                // Calculate LED Accumulation for display
                houses[key].ledAccumulation = calculateLedMJ(houses[key].lightingStartTime, houses[key].lightingEndTime, new Date());
            }

            // Watering Guide Calculation
            // House 1 Config for Lighting
            const h1Config = {
                start: houses.house1?.lightingStartTime,
                end: houses.house1?.lightingEndTime
            };
            const wateringGuide = this.calculateWateringGuide(houses.house2, historyList, h1Config);

            // 潅水目安をスプシに保存
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


                // Calculate Daily Stats for House 1
                let dailyTotalSolar: number | undefined;

                if (houses.house1 && houses.house1.accumulatedSolarRadiation) {
                    dailyTotalSolar = houses.house1.accumulatedSolarRadiation;
                }

                await sheetsService.saveWateringGuide('静岡', dateStr, marks, dailyTotalSolar);
            }

            // 過去7日分の履歴を読み込み (静岡)
            const wateringGuideHistory = await sheetsService.getWateringGuideHistory('静岡', 7);

            // 異常期間の分析
            let anomalyPeriods: any[] = [];
            const thresholds = await sheetsService.getThresholds();

            // app.ts 側で getRawHistoryData(10080)（1週間分）を取得済みのため、
            // ここでは再取得せず渡された historyList を再利用する。
            // historyList が少ない（＜1000件）場合のみフォールバックとして再取得。
            let rawHistoryForAnalyzer = historyList;
            if (rawHistoryForAnalyzer.length < 1000) {
                logger.info(`historyList件数不足(${rawHistoryForAnalyzer.length})のため、静岡1000件を再取得します`);
                rawHistoryForAnalyzer = await sheetsService.getRawHistoryData(1000, '静岡');
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
                // Effective Solar (Last Guide Mark MJ)
                effectiveSolar: (wateringGuide && wateringGuide.times && wateringGuide.times.length > 0)
                    ? wateringGuide.times[wateringGuide.times.length - 1].mj
                    : (houses.house1.accumulatedSolarRadiation || 0),
                // Reference Solar (Sunset - 4H) for comparison
                referenceSolar: (wateringGuide && wateringGuide.referenceMJ)
                    ? wateringGuide.referenceMJ
                    : (houses.house1.accumulatedSolarRadiation || 0),
                // Helper to format number
                formatNumber: (val: number | undefined) => (val !== undefined ? val.toFixed(1) : '-'),
                refreshInterval: getEnv('DASHBOARD_REFRESH_SECONDS', '300'),
            };

            // 動的ヘルパー（閾値データに依存するため、generate()呼び出しごとに再登録）
            // Handlebarsは同名ヘルパーの再登録を許容し、最後の登録が有効になる
            // Calculate Watering Estimate Helper
            handlebars.registerHelper('calcWateringEstimate', function (accumulatedSolar, lightingStart, lightingEnd, area) {
                const AREA = area || 10;
                const LITER_PER_MJ = 250; // mL/MJ/m2

                // Note: accumulatedSolar passed here is already "Effective MJ" (Solar + LED) from the viewData logic
                const mj = accumulatedSolar ? Number(accumulatedSolar) : 0;

                // User Request: Calculate based on "Watering Counts" (1.0 MJ steps)
                // Count = Floor(MJ) since we start at 1.0 and increment by 1.0
                const count = Math.floor(mj);

                // If count < 1, volume is 0? Or should we show potential? 
                // Usually estimate for the day is shown.
                // If mj is 7.5, count is 7. Volume = 7 * 250 * Area.

                const est = AREA * count * LITER_PER_MJ;
                return Math.floor(est).toLocaleString();
            });

            // 閾値チェックヘルパー
            handlebars.registerHelper('checkThreshold', function (house: string, item: string, value: any) {
                if (value === undefined || value === null) {
                    return { value: '-', isAbnormal: false };
                }

                const key = `${currentMonth}-${house}-${item}`;
                const threshold = thresholds[key];

                if (!threshold) {
                    // 閾値未設定の場合は通常表示
                    return { value: value, isAbnormal: false };
                }

                const numValue = Number(value);
                const isAbnormal = numValue < threshold.minValue || numValue > threshold.maxValue;

                return { value: value, isAbnormal: isAbnormal };
            });

            // Generate HTML
            const html = template(viewData);

            // Ensure directory exists
            await fs.mkdir(path.dirname(this.outputPath), { recursive: true });

            // Write to file
            await fs.writeFile(this.outputPath, html, 'utf-8');
            logger.info(`Dashboard generated at ${this.outputPath}`);

        } catch (error) {
            logger.error(`Failed to generate dashboard: ${error}`);
            // Don't throw, just log, to keep main process alive
        }
    }

    private calculateWateringGuide(house2Data: EnvironmentData, history: EnvironmentData[], lightingConfig: { start?: string, end?: string } | null = null): any {
        if (!house2Data || !house2Data.sunrise || !house2Data.sunset) {
            return { error: '日の出・日の入データなし' };
        }

        const parseTime = (str: string | undefined): number | null => {
            if (!str) return null;
            // Handle full date string from sheets
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

        const sunriseTime = parseTime(house2Data.sunrise);
        const sunsetTime = parseTime(house2Data.sunset);

        if (sunriseTime === null || sunsetTime === null) {
            return { error: '時間形式エラー', rawSunrise: house2Data.sunrise, rawSunset: house2Data.sunset };
        }

        // 以前の "日の出 + 2h" (startTime) ロジックは削除
        // 終了時間の基準: 日没 - 4時間
        const endTime = sunsetTime - (4 * 60);
        const intervalMJ = 1.0; // 変更: 1.0 MJ刻み

        // Filter history for House 1 and today
        const today = new Date();
        // const todayStr = `${today.getFullYear()}/${today.getMonth() + 1}/${today.getDate()}`;

        const house1History = history.filter(d =>
            (d.location.includes('1号') || d.source === 'profarm') &&
            d.timestamp.getFullYear() === today.getFullYear() &&
            d.timestamp.getMonth() === today.getMonth() &&
            d.timestamp.getDate() === today.getDate()
        );
        logger.info(`WateringGuide: Today's history count: ${house1History.length}. Today: ${today.toLocaleDateString()}`);
        if (house1History.length > 0) {
            logger.info(`Sample history item: ${JSON.stringify(house1History[0])}`);
        }

        if (house1History.length === 0) {
            return {
                error: 'データ待機中',
                sunrise: house2Data.sunrise,
                sunset: house2Data.sunset,
                endTime: formatTime(endTime)
            };
        }

        // Sort just in case
        house1History.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

        const guideTimes: any[] = [];
        // Helper to calculate LED MJ
        const COEFF_LED = 0.09;
        const calculateEffectiveMJ = (solarMJ: number, timestamp: Date): number => {
            let ledMJ = 0;
            if (lightingConfig && lightingConfig.start && lightingConfig.end) {
                const s = parseTime(lightingConfig.start);
                const e = parseTime(lightingConfig.end);
                if (s !== null && e !== null) {
                    const currentMin = timestamp.getHours() * 60 + timestamp.getMinutes();
                    // Calculate overlapped minutes
                    // Assuming lighting is within the day (e.g. 05:00 - 20:00)
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

        // 終了時刻を30分延長（検索バッファ）
        const endTimeExtended = endTime + 30;

        // [2026-01-11] 新しいロジック:
        // - ターゲット-0.4MJから暫定表示開始
        // - よりターゲットに近い値で書き換え
        // - 次のターゲット-0.4MJに達したら確定
        // - 同距離なら最初の時刻を優先(書き換えしない)

        let currentTargetMJ = 1.0; // 現在のターゲット
        const searchStartOffset = 0.4; // ターゲット-0.4から探索開始

        // 暫定記録用
        let provisional: { data: EnvironmentData, min: number, effectiveMJ: number, distanceToTarget: number } | null = null;

        // 履歴データ全体を時系列で走査
        for (let i = 0; i < house1History.length; i++) {
            const d = house1History[i];
            const min = d.timestamp.getHours() * 60 + d.timestamp.getMinutes();
            const rawMJ = d.accumulatedSolarRadiation;

            // 日射量がない場合はスキップ
            if (rawMJ === undefined || rawMJ === null) continue;

            // 終了時刻(+30分)を過ぎたら探索終了
            if (min > endTimeExtended) break;

            // 有効MJ計算
            const effectiveMJ = calculateEffectiveMJ(rawMJ, d.timestamp);

            // 次のターゲットの探索開始点に達したかチェック
            const nextTargetSearchStart = currentTargetMJ + 1.0 - searchStartOffset; // 例: 1.0 -> 1.6

            if (effectiveMJ >= nextTargetSearchStart) {
                // 次のターゲットの探索範囲に入った = 現在のターゲットは確定
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
                // 次のターゲットへ移行
                currentTargetMJ += intervalMJ;

                // この計測点が新しいターゲットの探索範囲内かもチェック
                // 例: 1.4から一気に2.7に跳んだ場合、2.0を飛ばして3.0の範囲に入る可能性
                // その場合は2.0は記録なしで3.0の暫定記録を開始
                while (effectiveMJ >= currentTargetMJ + 1.0 - searchStartOffset) {
                    currentTargetMJ += intervalMJ;
                }
            }

            // 現在のターゲットの探索範囲（ターゲット-0.4以上）に入っているかチェック
            const currentSearchStart = currentTargetMJ - searchStartOffset; // 例: 1.0 -> 0.6

            if (effectiveMJ >= currentSearchStart) {
                const distanceToTarget = Math.abs(effectiveMJ - currentTargetMJ);

                if (!provisional) {
                    // 暫定記録がない場合、この計測点を暫定記録
                    provisional = { data: d, min: min, effectiveMJ: effectiveMJ, distanceToTarget: distanceToTarget };
                } else {
                    // 暫定記録がある場合、よりターゲットに近いかチェック
                    // 同距離の場合は書き換えしない（最初の時刻を優先）
                    if (distanceToTarget < provisional.distanceToTarget) {
                        provisional = { data: d, min: min, effectiveMJ: effectiveMJ, distanceToTarget: distanceToTarget };
                    }
                }
            }
        }

        // ループ終了後、最後の暫定記録があれば確定
        if (provisional) {
            validStartFound = true;
            guideTimes.push({
                time: formatTime(provisional.min),
                mj: provisional.effectiveMJ,
                type: guideTimes.length === 0 ? 'start' : 'water',
                diff: parseFloat((provisional.effectiveMJ - currentTargetMJ).toFixed(1))
            });
        }

        // Add isFinal flag to the last element
        if (guideTimes.length > 0) {
            guideTimes[guideTimes.length - 1].isFinal = true;
        }

        // Calculate Reference MJ (Sunset - 4H approx)
        let referenceMJ = 0;
        let refDiff = 9999;
        // Search history for closest time to endTime (Sunset - 4H)
        for (const d of house1History) {
            const min = d.timestamp.getHours() * 60 + d.timestamp.getMinutes();
            const currentMJ = d.accumulatedSolarRadiation;
            if (currentMJ !== undefined && currentMJ !== null) {
                // endTime is Sunset - 4H. We want data closest to this time.
                const diff = Math.abs(min - endTime);
                if (diff < refDiff) {
                    refDiff = diff;
                    // Use Effective MJ (Solar + LED)
                    referenceMJ = calculateEffectiveMJ(currentMJ, d.timestamp);
                }
            }
        }

        // Current status (Last recorded data info)
        let currentStatus = null;
        if (house1History.length > 0) {
            const lastData = house1History[house1History.length - 1];
            const lastMin = lastData.timestamp.getHours() * 60 + lastData.timestamp.getMinutes();
            // 現在時刻が終了時間内であれば表示
            if (lastMin <= endTimeExtended) {
                const currentMJ = lastData.accumulatedSolarRadiation;
                if (currentMJ !== undefined && currentMJ !== null) {
                    if (lastMin <= endTimeExtended) {
                        const currentSolarMJ = lastData.accumulatedSolarRadiation || 0;
                        const currentEffectiveMJ = calculateEffectiveMJ(currentSolarMJ, lastData.timestamp);

                        // 次のターゲット表示用
                        // 既にクリアしたターゲットの数に基づいて計算
                        // validStartFoundに関わらず、現在は nextTargetMJ で管理されているが、
                        // whileループを抜けた後の nextTargetMJ は「次に達成すべき目標」になっているはず。

                        // ただし、何も見つかっていない場合(validStartFound=false)は 1.0 が目標。
                        // 見つかっている場合は、guideTimesの最後に基づいて次を計算できる。

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
        }

        // 日の出+2時間を計算
        const startTime = sunriseTime + (2 * 60);

        return {
            times: guideTimes,
            sunrise: house2Data.sunrise,
            sunset: house2Data.sunset,
            startTime: formatTime(startTime), // 日の出+2時間
            endTime: formatTime(endTime),
            currentStatus: currentStatus,
            referenceMJ: referenceMJ // Add reference MJ
        };
    }
}
