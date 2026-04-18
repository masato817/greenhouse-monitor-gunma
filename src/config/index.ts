import { Threshold } from '../types';

/**
 * 環境データ項目の表示名と絵文字
 */
export const ITEM_DISPLAY = {
  temperature: { name: '温度', emoji: '🌡️', unit: '℃' },
  humidity: { name: '湿度', emoji: '💧', unit: '%' },
  co2: { name: 'CO2', emoji: '🌬️', unit: 'ppm' },
  solarRadiation: { name: '日射量', emoji: '☀️', unit: 'W/m²' },
  vpd: { name: '飽差', emoji: '💨', unit: 'kPa' },
  soilTemp: { name: '地温', emoji: '🌱', unit: '℃' },
  ecValue: { name: 'EC', emoji: '⚡', unit: 'mS/cm' },
  phValue: { name: 'pH', emoji: '🧪', unit: '' },
} as const;

/**
 * デフォルト閾値（Google Sheetsに設定がない場合に使用）
 * 実際の運用では Google Sheets の「閾値マスタ」シートで管理
 */
export const DEFAULT_THRESHOLDS: Threshold[] = [
  // 日中（6:00-17:00）の温度
  {
    startTime: '06:00',
    endTime: '17:00',
    item: 'temperature',
    minValue: 18,
    maxValue: 32,
    location: 'all',
    alertLevel: 'critical',
  },
  // 夜間（17:00-6:00）の温度
  {
    startTime: '17:00',
    endTime: '06:00',
    item: 'temperature',
    minValue: 12,
    maxValue: 25,
    location: 'all',
    alertLevel: 'critical',
  },
  // 湿度（終日）
  {
    startTime: '00:00',
    endTime: '23:59',
    item: 'humidity',
    minValue: 50,
    maxValue: 85,
    location: 'all',
    alertLevel: 'warning',
  },
  // CO2（日中のみ重要）
  {
    startTime: '06:00',
    endTime: '17:00',
    item: 'co2',
    minValue: 400,
    maxValue: 1500,
    location: 'all',
    alertLevel: 'warning',
  },
  // 飽差
  {
    startTime: '06:00',
    endTime: '17:00',
    item: 'vpd',
    minValue: 0.3,
    maxValue: 1.2,
    location: 'all',
    alertLevel: 'warning',
  },
];

/**
 * スクレイピング関連の設定
 */
export const SCRAPER_CONFIG = {
  /** ページ読み込み待機時間（ミリ秒） */
  PAGE_LOAD_TIMEOUT: 30000,
  /** 要素待機時間（ミリ秒） */
  ELEMENT_WAIT_TIMEOUT: 10000,
  /** リトライ回数 */
  MAX_RETRIES: 3,
  /** リトライ間隔（ミリ秒） */
  RETRY_DELAY: 5000,
  /** スクリーンショット保存先 */
  SCREENSHOT_DIR: './screenshots',
};

// NOTE: LINE_CONFIG, SHEETS_CONFIG は以前ここに定義されていたが、
// 各サービスクラス内で直接定義されているため削除。
// 設定の一元管理が必要になった場合はここに集約すること。
