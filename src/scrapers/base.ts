import puppeteer, { Browser, Page, HTTPResponse } from 'puppeteer';
import fs from 'fs/promises';
import { ScraperConfig, EnvironmentData } from '../types';
import * as winston from 'winston';

export abstract class BaseScraper {
  protected browser: Browser | null = null;
  protected page: Page | null = null;
  protected config: ScraperConfig;
  protected logger: winston.Logger;
  /**
   * 直近の scrape() で起きたエラーの要約（無ければ null）
   * scrape() は失敗しても例外を投げず空配列を返すため、呼び出し側が原因を status.json 等に残せるようにする
   */
  lastError: string | null = null;

  constructor(config: ScraperConfig, logger: winston.Logger) {
    this.config = config;
    this.logger = logger;
  }

  async initialize(): Promise<void> {
    this.logger.info('Initializing browser...');
    this.browser = await puppeteer.launch({
      headless: this.config.headless !== false ? 'new' : false, // Default to true (new mode)
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    this.page = await this.browser.newPage();
    // Set viewport to a reasonable size
    await this.page.setViewport({ width: 1280, height: 800 });

    // Set User-Agent to avoid detection
    await this.page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.page = null;
      this.logger.info('Browser closed.');
    }
  }

  /** エラー要約を記録する（複数あれば連結） */
  protected recordError(message: string): void {
    this.lastError = this.lastError ? `${this.lastError} / ${message}` : message;
  }

  /**
   * ページ遷移し、HTTP エラー（503 等）なら例外にする
   * エラー画面のままセレクタ待ちでタイムアウトするより原因が分かりやすい。URL はログに出さない
   */
  protected async gotoChecked(url: string, label: string): Promise<HTTPResponse | null> {
    if (!this.page) throw new Error('Page not initialized');
    const response = await this.page.goto(url, { waitUntil: 'domcontentloaded' });
    if (response && response.status() >= 400) {
      throw new Error(`${label} HTTP ${response.status()}`);
    }
    return response;
  }

  /**
   * デバッグ用スクリーンショット（screenshots/ は .gitignore 済み。CI では artifact にしない）
   * 保存失敗で本来のエラー処理が中断しないよう、例外は投げない
   */
  protected async takeScreenshot(name: string): Promise<void> {
    if (!this.page) return;
    try {
      await fs.mkdir('screenshots', { recursive: true });
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `screenshots/${name}-${timestamp}.png`;
      await this.page.screenshot({ path: filename, fullPage: true });
      this.logger.info(`Screenshot saved: ${filename}`);
    } catch (e) {
      this.logger.warn(`Screenshot failed: ${e}`);
    }
  }

  abstract scrape(): Promise<EnvironmentData[]>;
}
