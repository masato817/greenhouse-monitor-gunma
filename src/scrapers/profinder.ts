import { BaseScraper } from './base';
import { EnvironmentData } from '../types';
import { getEnv, logger } from '../utils';

/**
 * PROFINDER_DEVICES 環境変数をパースする
 * 形式: "id:name,id:name"  例: "1:2号棟,2:3号棟,3:4号棟,4:9号棟,5:8号棟"
 * 未設定時は統合デフォルト (静岡 2/3/4号 + 群馬 9/8号 = 全5棟) を返す
 */
function parseProfinderDevices(): { id: string; name: string }[] {
  const raw = getEnv('PROFINDER_DEVICES', '1:2号棟,2:3号棟,3:4号棟,4:9号棟,5:8号棟');
  return raw.split(',').map(pair => {
    const [id, name] = pair.split(':');
    return { id: (id || '').trim(), name: (name || '').trim() };
  }).filter(d => d.id && d.name);
}

export class ProfinderScraper extends BaseScraper {
  async scrape(): Promise<EnvironmentData[]> {
    const results: EnvironmentData[] = [];

    try {
      await this.initialize();
      if (!this.page) throw new Error('Page not initialized');

      // 1. Login
      await this.login();
      // Wait for dashboard or redirection
      await new Promise(r => setTimeout(r, 5000));

      const devices = parseProfinderDevices();
      logger.info(`Profinder devices to scrape: ${devices.map(d => `${d.id}:${d.name}`).join(', ')}`);

      // 初回のみ、実際に Profinder 側に存在する <option> を一覧でログ出力（ID確認用）
      try {
        const availableOptions = await this.page.$$eval('#select-device option', opts =>
          opts.map((o: any) => `${o.value}:${o.textContent?.trim()}`)
        );
        logger.info(`Profinder available devices: ${availableOptions.join(' | ')}`);
      } catch (e) {
        logger.warn(`Could not list available devices: ${e}`);
      }

      for (const device of devices) {
        this.logger.info(`Scraping Profinder Device: ${device.name} (ID: ${device.id})...`);
        try {
          const data = await this.scrapeDevice(device);
          if (data) {
            results.push(data);
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          this.logger.error(`Failed to scrape ${device.name}: ${msg}`);
          await this.takeScreenshot(`error-profinder-${device.id}`);
        }
      }

    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Profinder scraping fatal error: ${msg}`);
      await this.takeScreenshot('fatal-error-profinder');
    } finally {
      await this.close();
    }

    return results;
  }

  private async login(): Promise<void> {
    if (!this.page) return;

    this.logger.info('Logging in to Profinder...');
    await this.page.goto(this.config.url, { waitUntil: 'domcontentloaded' });

    const userSelector = '#usid';
    const passSelector = '#pswd';
    const loginButtonSelector = '.login-btn';

    try {
      await this.page.waitForSelector(userSelector, { timeout: 10000 });
      await this.page.type(userSelector, this.config.username || '');
      await this.page.type(passSelector, this.config.password || '');

      // Profinder login might not trigger standard navigation event, just click and wait
      await this.page.click(loginButtonSelector);
      this.logger.info('Login submitted, waiting...');

      // Explicit wait instead of waitForNavigation because of SPA behavior potential
      await new Promise(r => setTimeout(r, 10000));

    } catch (e) {
      this.logger.error(`Profinder Login failed: ${e}`);
      throw e;
    }
  }

  private async scrapeDevice(device: { id: string, name: string }): Promise<EnvironmentData | null> {
    if (!this.page) return null;

    // Select device
    await this.page.waitForSelector('#select-device', { timeout: 20000 });
    await this.page.select('#select-device', device.id);

    // Wait for update
    this.logger.info(`Waiting for data update for ${device.name}...`);
    await new Promise(r => setTimeout(r, 8000));

    // Helper
    const getTextVal = async (parentSelector: string) => {
      try {
        // Profinder often uses .pf-7seg-value inside the container ID
        return await this.page!.$eval(`${parentSelector} .pf-7seg-value`, el => el.textContent?.trim() || null);
      } catch {
        return null;
      }
    };

    const temp = await getTextVal('#min_Temp');
    const humidity = await getTextVal('#min_Humi');
    const co2 = await getTextVal('#min_Co2');
    const solar = await getTextVal('#min_Sun_L');
    const accumulatedSolar = await getTextVal('#sun_sum');
    const vpd = await getTextVal('#min_VPD');

    // New fields
    const todayMaxTemp = await getTextVal('#day_max_temp');
    const todayMinTemp = await getTextVal('#day_min_temp');
    const yesterdayAccumSolar = await getTextVal('#prev_sun_sum');

    const avgTemp24h = await getTextVal('#mv_avg_24');
    const avgTemp48h = await getTextVal('#mv_avg_48');
    const avgTemp72h = await getTextVal('#mv_avg_72');

    const dayAvg = await getTextVal('#temp_avg_c');
    const nightAvg = await getTextVal('#temp_avg_d');
    const prevDayAvg = await getTextVal('#temp_avg_a');
    const prevNightAvg = await getTextVal('#temp_avg_b');

    // Sunrise/Sunset - Use evaluate for safety (no throw if missing)
    const sunrise = await this.page.evaluate(() => {
      // @ts-ignore
      const el = document.querySelector('#calendar_1');
      return el ? el.textContent?.trim() : null;
    });
    const sunset = await this.page.evaluate(() => {
      // @ts-ignore
      const el = document.querySelector('#calendar_2');
      return el ? el.textContent?.trim() : null;
    });

    const data: EnvironmentData = {
      timestamp: new Date(),
      source: 'profinder',
      location: device.name,
      temperature: temp ? parseFloat(temp) : undefined,
      humidity: humidity ? parseFloat(humidity) : undefined,
      co2: co2 ? parseFloat(co2) : undefined,
      solarRadiation: solar ? parseFloat(solar) : undefined,
      accumulatedSolarRadiation: accumulatedSolar ? parseFloat(accumulatedSolar) : undefined,
      vpd: vpd ? parseFloat(vpd) : undefined,

      todayMaxTemp: todayMaxTemp ? parseFloat(todayMaxTemp) : undefined,
      todayMinTemp: todayMinTemp ? parseFloat(todayMinTemp) : undefined,
      yesterdayAccumulatedSolar: yesterdayAccumSolar ? parseFloat(yesterdayAccumSolar) : undefined,

      avgTemp24h: avgTemp24h ? parseFloat(avgTemp24h) : undefined,
      avgTemp48h: avgTemp48h ? parseFloat(avgTemp48h) : undefined,
      avgTemp72h: avgTemp72h ? parseFloat(avgTemp72h) : undefined,

      dayAvgTemp: dayAvg ? parseFloat(dayAvg) : undefined,
      nightAvgTemp: nightAvg ? parseFloat(nightAvg) : undefined,
      prevDayAvgTemp: prevDayAvg ? parseFloat(prevDayAvg) : undefined,
      prevNightAvgTemp: prevNightAvg ? parseFloat(prevNightAvg) : undefined,

      sunrise: sunrise || undefined,
      sunset: sunset || undefined
    };

    if (data.prevDayAvgTemp !== undefined && data.prevNightAvgTemp !== undefined) {
      // User requested DIF to be "Previous Day" - "Previous Night"
      data.diffDayNight = parseFloat((data.prevDayAvgTemp - data.prevNightAvgTemp).toFixed(1));
    }

    this.logger.info(`Profinder Extracted for ${device.name}: ${JSON.stringify(data)}`);
    return data;
  }
}
