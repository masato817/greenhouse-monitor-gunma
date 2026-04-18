import puppeteer, { Browser, Page } from 'puppeteer';
import { ScraperConfig, EnvironmentData } from '../types';
import * as winston from 'winston';

export abstract class BaseScraper {
  protected browser: Browser | null = null;
  protected page: Page | null = null;
  protected config: ScraperConfig;
  protected logger: winston.Logger;

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

  protected async takeScreenshot(name: string): Promise<void> {
    if (this.page) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `screenshots/${name}-${timestamp}.png`;
      await this.page.screenshot({ path: filename, fullPage: true });
      this.logger.info(`Screenshot saved: ${filename}`);
    }
  }

  abstract scrape(): Promise<EnvironmentData[]>;
}
