import winston from 'winston';
import { format } from 'date-fns';
import { ja } from 'date-fns/locale';
import { formatInTimeZone } from 'date-fns-tz';
import fs from 'fs';
import path from 'path';

/** アプリ全体で使用するタイムゾーン定数 */
export const JST = 'Asia/Tokyo';

/**
 * ログディレクトリを確保
 */
const LOG_DIR = path.join(process.cwd(), 'logs');
if (!fs.existsSync(LOG_DIR)) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch (error) {
    console.error(`ログディレクトリの作成に失敗しました: ${error}`);
  }
}

/**
 * ロガーの設定
 */
export const logger = winston.createLogger({
  level: process.env.DEBUG === 'true' ? 'debug' : 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ level, message, timestamp }) => {
      return `[${timestamp}] ${level.toUpperCase()}: ${message}`;
    })
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: path.join(LOG_DIR, 'error.log'), level: 'error' }),
    new winston.transports.File({ filename: path.join(LOG_DIR, 'combined.log') }),
  ],
});

/**
 * リトライ付きで関数を実行
 * @param fn 実行する関数
 * @param maxRetries 最大リトライ回数
 * @param delay リトライ間隔（ミリ秒）
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  delay: number = 5000
): Promise<T> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      if (attempt === maxRetries) {
        logger.error(`最大リトライ回数に到達: ${errorMessage}`);
        throw error;
      }

      logger.warn(`リトライ ${attempt}/${maxRetries}: ${errorMessage}`);
      await sleep(delay);
    }
  }
  throw new Error('Unreachable');
}

/**
 * 指定時間待機
 * @param ms 待機時間（ミリ秒）
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 現在時刻が指定の時間範囲内かチェック
 * @param startTime 開始時刻 (HH:mm形式)
 * @param endTime 終了時刻 (HH:mm形式)
 * @param now チェック対象の時刻（省略時は現在時刻）
 */
export function isInTimeRange(
  startTime: string,
  endTime: string,
  now: Date = new Date()
): boolean {
  const currentMinutes = now.getHours() * 60 + now.getMinutes();

  const [startHour, startMin] = startTime.split(':').map(Number);
  const [endHour, endMin] = endTime.split(':').map(Number);

  const startMinutes = startHour * 60 + startMin;
  const endMinutes = endHour * 60 + endMin;

  // 日をまたぐ場合（例: 17:00 - 06:00）
  if (startMinutes > endMinutes) {
    return currentMinutes >= startMinutes || currentMinutes < endMinutes;
  }

  // 通常の場合（例: 06:00 - 17:00）
  return currentMinutes >= startMinutes && currentMinutes < endMinutes;
}

/**
 * 日本語フォーマットで日時を文字列化（JST固定）
 * date-fns-tz を使用し、実行環境のタイムゾーンに依存しない
 */
export function formatJapanese(
  date: Date,
  formatStr: string = 'yyyy/MM/dd HH:mm'
): string {
  return formatInTimeZone(date, JST, formatStr, { locale: ja });
}

/**
 * 数値を指定桁数で丸める
 * @param value 数値
 * @param decimals 小数点以下の桁数
 */
export function roundTo(value: number, decimals: number = 1): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

/**
 * 文字列から数値を抽出
 * @param str 対象文字列（例: "25.5℃"）
 */
export function extractNumber(str: string): number | null {
  const match = str.match(/-?\d+\.?\d*/);
  if (match) {
    return parseFloat(match[0]);
  }
  return null;
}

/**
 * 農場の識別子
 * 静岡: サングレイス (1号〜4号)
 * 群馬: 群馬農場     (8号・9号)
 */
export type Farm = '静岡' | '群馬';

export const ALL_FARMS: Farm[] = ['静岡', '群馬'];

/**
 * ハウス名→農場 のマッピング
 */
const HOUSE_TO_FARM: Record<string, Farm> = {
  '1号': '静岡',
  '2号': '静岡',
  '3号': '静岡',
  '4号': '静岡',
  '8号': '群馬',
  '9号': '群馬',
};

/**
 * EnvironmentDataからハウス名を判定する
 * alert-checker, history-analyzer, dashboard-generator で共通利用
 *
 * 静岡: 1号〜4号 (Profarm=1号, Profinder=2/3/4号)
 * 群馬: 8号・9号 (Profinder のみ)
 */
export function resolveHouseName(data: { source?: string; location?: string }): string {
  if (data.source === 'profarm') return '1号';
  const loc = data.location || '';
  if (loc.includes('1号')) return '1号';
  if (loc.includes('2号')) return '2号';
  if (loc.includes('3号')) return '3号';
  if (loc.includes('4号')) return '4号';
  if (loc.includes('8号')) return '8号';
  if (loc.includes('9号')) return '9号';
  return '';
}

/**
 * EnvironmentDataから農場を判定する
 * 該当なしの場合は静岡（旧来動作と互換）を返す
 */
export function resolveFarm(data: { source?: string; location?: string }): Farm {
  const house = resolveHouseName(data);
  return HOUSE_TO_FARM[house] ?? '静岡';
}

/**
 * 環境変数を取得（未設定の場合はエラー）
 * @param key 環境変数名
 */
export function getEnvOrThrow(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`環境変数 ${key} が設定されていません`);
  }
  return value;
}

/**
 * 環境変数を取得（未設定の場合はデフォルト値）
 * @param key 環境変数名
 * @param defaultValue デフォルト値
 */
export function getEnv(key: string, defaultValue: string): string {
  return process.env[key] || defaultValue;
}
