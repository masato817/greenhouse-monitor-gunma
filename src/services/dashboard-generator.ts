import fs from 'fs/promises';
import path from 'path';
import handlebars from 'handlebars';
import { EnvironmentData, WateringGuideMark, ThresholdMap } from '../types';
import { logger, formatJapanese, getEnv } from '../utils';
import { calculateLedMJ, calculateWateringGuide as calculateWateringGuideShared } from './watering-guide';
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

            // LED累積計算は watering-guide.ts の共通実装 calculateLedMJ を使用

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
        // 静岡: 1号棟(Profarm)を基準ハウスとして共通ロジックで計算する
        return calculateWateringGuideShared(house2Data, history, lightingConfig, {
            refHouseFilter: d => d.location.includes('1号') || d.source === 'profarm',
        });
    }

}
