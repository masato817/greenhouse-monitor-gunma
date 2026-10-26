import fs from 'fs/promises';
import path from 'path';
import handlebars from 'handlebars';
import { EnvironmentData, WateringGuideMark } from '../types';
import { logger, formatJapanese, getEnv } from '../utils';
import { calculateLedMJ, calculateWateringGuide as calculateWateringGuideShared } from './watering-guide';
import { HistoryAnalyzer } from './history-analyzer';
import { buildFreshness } from './freshness';
import { DashboardGeneratorOptions, GenerateOptions, GenerateResult, SheetsAccessor } from './dashboard-common';

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

    constructor(options: DashboardGeneratorOptions = {}) {
        this.templatePath = options.templatePath ?? path.join(process.cwd(), 'src', 'templates', 'gunma.hbs');
        this.outputPath = options.outputPath ?? path.join(process.cwd(), 'public', 'gunma.html');
        registerHandlebarsHelpers();
    }

    /**
     * gunma.html を生成する
     * Sheets 操作の失敗は既定値で続行して GenerateResult.sheetsErrors に返し、
     * テンプレート読込・書込の失敗は例外として呼び出し側に伝える
     */
    async generate(
        dataList: EnvironmentData[],
        historyList: EnvironmentData[] = [],
        options: GenerateOptions = {}
    ): Promise<GenerateResult> {
        logger.info(`[Gunma] Generating dashboard HTML... History count: ${historyList.length}`);
        const now = options.now ?? new Date();

        try {
            const templateContent = await fs.readFile(this.templatePath, 'utf-8');
            const template = handlebars.compile(templateContent);

            // 群馬は 8号/9号 の2棟構成
            // 表示用に設定値を書き足すため、呼び出し元のデータを変更しないようコピーする
            const houses: any = {
                house8: { ...dataList.find(d => d.location.includes('8号')) },
                house9: { ...dataList.find(d => d.location.includes('9号')) },
            };

            // LED累積計算は watering-guide.ts の共通実装 calculateLedMJ を使用

            // Sheets は失敗しても既定値で続行する（権限喪失時もページ生成を止めない）
            const sheets = new SheetsAccessor(options.sheets, '[Gunma] ');

            // ハウス設定を先に読み込み、照明時間を houses に反映
            const houseConfigs = await sheets.call('ハウス設定読込', new Map(), s => s.getHouseConfigs());
            const currentMonth = now.getMonth() + 1;
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
                    now
                );
            }

            // 潅水目安計算
            // - 基準ハウス: 8号（外日射）の積算日射で評価
            // - 日の出・日の入: 8号
            // - 群馬はLED未導入のため LED加算なし (lightingConfig=null)
            const wateringGuide = this.calculateWateringGuide(houses.house8, historyList, null, now);

            // 潅水目安をスプシ保存 (群馬_潅水目安履歴)
            if (wateringGuide && wateringGuide.times && wateringGuide.times.length > 0) {
                const today = now;
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

                await sheets.call('潅水目安保存', undefined, s => s.saveWateringGuide('群馬', dateStr, marks, dailyTotalSolar));
            }

            // 過去7日分の履歴を読み込み (群馬)
            const wateringGuideHistory = await sheets.call('潅水目安履歴読込', [], s => s.getWateringGuideHistory('群馬', 7));

            // 異常期間の分析
            let anomalyPeriods: any[] = [];
            const thresholds = await sheets.call('閾値読込', {}, s => s.getThresholds());

            let rawHistoryForAnalyzer = historyList;
            if (rawHistoryForAnalyzer.length < 1000) {
                logger.info(`[Gunma] historyList件数不足(${rawHistoryForAnalyzer.length})のため、群馬1000件を再取得します`);
                rawHistoryForAnalyzer = await sheets.call('履歴再取得', historyList, s => s.getRawHistoryData(1000, '群馬'));
            }
            const analyzer = new HistoryAnalyzer();
            anomalyPeriods = analyzer.analyze(rawHistoryForAnalyzer, thresholds);

            // ヘッダの「最終」は実行時刻ではなく表示データ自体の計測時刻にする
            const freshness = buildFreshness([
                { label: '8号棟', data: houses.house8 },
                { label: '9号棟', data: houses.house9 },
            ], now);

            const viewData = {
                updatedAt: freshness.updatedAt,
                freshness: freshness,
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

            return { outputPath: this.outputPath, dataTime: freshness.dataTime, sheetsErrors: sheets.errors };
        } catch (error) {
            // 生成失敗を握りつぶすと実行結果が成功扱いになるため、呼び出し側へ伝える
            logger.error(`[Gunma] Failed to generate dashboard: ${error}`);
            throw error;
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
        lightingConfig: { start?: string, end?: string } | null = null,
        now?: Date
    ): any {
        // 群馬: 8号棟を基準ハウスとして共通ロジックで計算する
        return calculateWateringGuideShared(refHouseData, history, lightingConfig, {
            refHouseFilter: d => d.location.includes('8号'),
            logPrefix: '[Gunma] ',
            now,
        });
    }

}
