export interface EnvironmentData {
    timestamp: Date;
    source: 'profarm' | 'profinder';
    location: string;
    temperature?: number;
    humidity?: number;
    co2?: number;
    solarRadiation?: number;
    accumulatedSolarRadiation?: number;
    vpd?: number;

    // Profarm specific
    maxTemp?: number;
    minTemp?: number;

    // Profinder specific
    todayMaxTemp?: number;
    todayMinTemp?: number;
    yesterdayAccumulatedSolar?: number;

    // Averages
    avgTemp24h?: number;
    avgTemp48h?: number;
    avgTemp72h?: number;

    dayAvgTemp?: number;
    nightAvgTemp?: number;
    prevDayAvgTemp?: number;
    prevNightAvgTemp?: number;

    diffDayNight?: number;

    windSpeed?: number;
    outsideTemperature?: number;
    windDirection?: string;

    // Watering Guide
    sunrise?: string;
    sunset?: string;

    // LED Lighting (User requested)
    lightingStartTime?: string;
    lightingEndTime?: string;
}

export interface ScraperConfig {
    url: string;
    username?: string;
    password?: string;
    headless?: boolean;
}

export interface Threshold {
    startTime: string;
    endTime: string;
    item: string;
    minValue: number;
    maxValue: number;
    location: string;
    alertLevel: 'critical' | 'warning';
}

export interface ThresholdConfig {
    month: number;        // 1-12
    house: string;        // "1号", "2号", "3号", "4号"
    item: string;         // "気温(℃)", "湿度(%)", "CO2(ppm)" など
    minValue: number;
    maxValue: number;
    note?: string;        // 備考
}

export interface ThresholdMap {
    [key: string]: ThresholdConfig;  // key: "月-ハウス-項目"
}

export interface WateringGuideMark {
    number: number;
    time: string;
    mj: number;
    targetMJ: string;
    diff: number | null;
}

export interface WateringGuideHistory {
    date: string;
    marks: WateringGuideMark[];
    // Daily Summary
    dailyTotalSolar?: number;
}

export interface HouseConfig {
    houseName: string;
    area: number;
    lightingStartTime?: string;
    lightingEndTime?: string;
}

export interface AnomalyPeriod {
    startTime: Date;
    endTime: Date;
    house: string;
    item: string;
    maxValue: number;
    thresholdValue: number;
    type: 'upper' | 'lower';
    durationString: string;
}
