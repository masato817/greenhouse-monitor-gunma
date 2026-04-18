import { BaseScraper } from './base';
import { EnvironmentData } from '../types';
import { getEnvOrThrow } from '../utils';

export class ProfarmScraper extends BaseScraper {
  async scrape(): Promise<EnvironmentData[]> {
    const results: EnvironmentData[] = [];

    try {
      await this.initialize();
      if (!this.page) throw new Error('Page not initialized');

      // 1. Login
      await this.login();

      // 2. Scrape House 1 (Profarm is for 1T)
      this.logger.info('Scraping サングレイス1号棟 (Profarm)...');

      // Navigate to Realtime Monitor
      await this.page.waitForSelector('#ddlhb0201u a', { timeout: 30000 }).catch(() => {
        this.logger.warn('Realtime monitor link not found immediately, trying direct navigation...');
      });

      // Navigate directly to ensure we are on the right page
      // 環境変数から取得（ハウスID等の業務固有値はリポジトリに埋め込まない）
      const realtimeUrl = getEnvOrThrow('PROFARM_REALTIME_URL');
      await this.page.goto(realtimeUrl, { waitUntil: 'domcontentloaded' });
      // Discovery Mode: Log all interesting IDs
      try {
        const ids = await this.page.$$eval('*[id]', els =>
          els.map(e => e.id).filter(id => id.startsWith('hom_') || id.startsWith('oum_'))
        );
        this.logger.info(`Profarm Discovery IDs: ${ids.join(', ')}`);
      } catch (e) {
        this.logger.warn(`Discovery failed: ${e}`);
      }

      // 3. Extract Data
      // Wait for data to populate (Proposal 1)
      this.logger.info('Waiting for sensor data to populate on page...');
      try {
        await this.page.waitForFunction(
          () => {
            // @ts-ignore
            const el = document.querySelector('#hom_Temp1');
            return el && el.textContent && el.textContent.trim().length > 0;
          },
          { timeout: 15000 } // Wait up to 15 seconds
        );
        this.logger.info('Sensor data populated.');
      } catch (e) {
        this.logger.warn(`Timeout waiting for data population, attempting extraction anyway: ${e}`);
      }

      let data = await this.extractData();

      // Check for missing data and retry if needed
      if (data && this.hasMissingValues(data)) {
        this.logger.warn('一部のデータが欠損しているため、10秒待機して再取得します...');
        await new Promise(resolve => setTimeout(resolve, 10000));
        data = await this.extractData();
      }
      if (data) {
        results.push(data);
      }

    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Profarm scraping fatal error: ${msg}`);
      await this.takeScreenshot('fatal-error-profarm');
    } finally {
      await this.close();
    }

    return results;
  }

  private async login(): Promise<void> {
    if (!this.page) return;

    this.logger.info('Logging in to Profarm...');
    await this.page.goto(this.config.url, { waitUntil: 'domcontentloaded' });

    const userSelector = '#userId';
    const passSelector = '#password';
    const loginButtonSelector = '#btnha0101ulogin';

    try {
      await this.page.waitForSelector(userSelector, { timeout: 10000 });
      await this.page.type(userSelector, this.config.username || '');
      await this.page.type(passSelector, this.config.password || '');

      const navPromise = this.page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 });
      await this.page.click(loginButtonSelector);

      try {
        await navPromise;
      } catch (e) {
        this.logger.warn(`Login nav timeout: ${e}`);
      }

      // Verify login success
      try {
        await this.page.waitForSelector('#ddlhb0201u a', { timeout: 10000 });
      } catch (e) {
        const url = this.page.url();
        const html = await this.page.content();
        this.logger.error(`Login verification failed on ${url}`);

        throw new Error(`Login failed: Menu element not found on ${url}`);
      }
      this.logger.info('Login submitted and verified.');
    } catch (e) {
      this.logger.error(`Login failed: ${e}`);
      throw e;
    }
  }

  private extractNumber(text: string | null): number | undefined {
    if (text === null) return undefined;
    const cleanedText = text.replace(/[^\d.-]/g, ''); // Remove non-numeric characters except decimal and sign
    const value = parseFloat(cleanedText);
    return isNaN(value) ? undefined : value;
  }

  private async extractData(): Promise<EnvironmentData | null> {
    if (!this.page) return null;

    const getText = async (selector: string) => {
      try {
        return await this.page!.$eval(selector, el => el.textContent?.trim() || null);
      } catch {
        return null;
      }
    };

    const temp = await getText('#hom_Temp1');
    const humidity = await getText('#hom_RelHumid1');
    const co2 = await getText('#hom_Co2');
    const solar = await getText('#oum_AmountInso');
    const accumulatedSolar = await getText('#oum_AccumInso');
    const vpd = await getText('#hom_SatDef1');
    const dayAvgTemp = await getText('#hom_DayAveTemp1');
    const nightAvgTemp = await getText('#hom_NightAveTemp1');

    // New fields
    const avgTemp24h = await getText('#hom_Temp24H1');
    const windSpeed = await getText('#oum_WindSpeed');
    const outsideTemp = await getText('#oum_Temp');
    const diffDayNight = await getText('#hom_DifAveTemp1');

    this.logger.debug(`Profarm NightAvg raw: "${nightAvgTemp}"`);

    const data: EnvironmentData = {
      timestamp: new Date(),
      source: 'profarm',
      location: '1号棟',
      temperature: temp ? this.extractNumber(temp) : undefined,
      humidity: humidity ? this.extractNumber(humidity) : undefined,
      co2: co2 ? this.extractNumber(co2) : undefined,
      solarRadiation: solar ? this.extractNumber(solar) : undefined,
      accumulatedSolarRadiation: accumulatedSolar ? this.extractNumber(accumulatedSolar) : undefined,
      vpd: vpd ? this.extractNumber(vpd) : undefined,
      dayAvgTemp: dayAvgTemp ? this.extractNumber(dayAvgTemp) : undefined,
      nightAvgTemp: nightAvgTemp ? this.extractNumber(nightAvgTemp) : undefined,
      avgTemp24h: avgTemp24h ? this.extractNumber(avgTemp24h) : undefined,
      windSpeed: windSpeed ? this.extractNumber(windSpeed) : undefined,
      outsideTemperature: outsideTemp ? this.extractNumber(outsideTemp) : undefined,
      diffDayNight: diffDayNight ? this.extractNumber(diffDayNight) : undefined,
      windDirection: ((await getText('#oum_WindDir')) || undefined),
    };

    // Calculate diff if not scraped (backup)
    if (data.diffDayNight === undefined && data.dayAvgTemp !== undefined && data.nightAvgTemp !== undefined) {
      data.diffDayNight = parseFloat((data.dayAvgTemp - data.nightAvgTemp).toFixed(1));
    }

    this.logger.info(`Profarm Extracted: ${JSON.stringify(data)}`);
    return data;
  }

  private hasMissingValues(data: EnvironmentData): boolean {
    const requiredFields: (keyof EnvironmentData)[] = [
      'temperature',
      'humidity',
      'co2',
      'solarRadiation',
      'accumulatedSolarRadiation',
      'vpd',
      'dayAvgTemp',
      'nightAvgTemp',
      'avgTemp24h',
      'windSpeed',
      'outsideTemperature',
    ];

    const missing = requiredFields.filter(field => data[field] === undefined);
    if (missing.length > 0) {
      this.logger.warn(`Missing fields detected: ${missing.join(', ')}`);
      return true;
    }
    return false;
  }
}
