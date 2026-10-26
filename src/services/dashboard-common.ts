import { logger } from '../utils';
import { GoogleSheetsService, DashboardSheetsPort } from './sheets';

export interface DashboardGeneratorOptions {
    /** 出力先（省略時は public/ 配下）。テストで一時ディレクトリに向ける */
    outputPath?: string;
    templatePath?: string;
}

export interface GenerateOptions {
    /**
     * 使用する Sheets。null なら Sheets を使わず既定値で生成する。
     * 省略時は GoogleSheetsService を生成する（生成に失敗したら null 扱い）
     */
    sheets?: DashboardSheetsPort | null;
    /** 判定基準時刻（省略時は現在時刻） */
    now?: Date;
}

export interface GenerateResult {
    outputPath: string;
    /** ページに表示したデータの最新計測時刻 */
    dataTime: Date | null;
    /** ページは生成できたが失敗した Sheets 操作（呼び出し側で終了コードに反映する） */
    sheetsErrors: string[];
}

/**
 * ダッシュボード生成中の Sheets 操作を、失敗しても既定値で続行できるように包む
 * Sheets の権限喪失や障害でページ生成ごと止まらないようにするため
 */
export class SheetsAccessor {
    readonly errors: string[] = [];
    private readonly sheets: DashboardSheetsPort | null;

    constructor(sheets: DashboardSheetsPort | null | undefined, private readonly logPrefix: string = '') {
        if (sheets !== undefined) {
            this.sheets = sheets;
            return;
        }
        try {
            this.sheets = new GoogleSheetsService();
        } catch (error) {
            this.sheets = null;
            this.record('Sheets初期化', error);
        }
    }

    async call<T>(label: string, fallback: T, fn: (sheets: DashboardSheetsPort) => Promise<T>): Promise<T> {
        if (!this.sheets) return fallback;
        try {
            return await fn(this.sheets);
        } catch (error) {
            this.record(label, error);
            return fallback;
        }
    }

    private record(label: string, error: unknown): void {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`${this.logPrefix}${label}に失敗（既定値で生成を続行）: ${msg}`);
        this.errors.push(`${label}: ${msg}`);
    }
}
