/**
 * Google Apps Script for Greenhouse Monitor Web App
 * 
 * 役割:
 * 1. doGet(): Webアプリとしてアクセスされた時にHTMLを返す
 * 2. getData(): スプレッドシートから最新の環境データを取得して返す
 * 
 * セットアップ:
 * 1. GASエディタで「ファイル」→「プロジェクトのプロパティ」
 * 2. 「スクリプトプロパティ」タブで以下を設定:
 *    - SPREADSHEET_ID: スプレッドシートのID
 */

/**
 * スクリプトプロパティからスプレッドシートIDを取得
 * 未設定の場合はエラーを投げる
 */
function getSpreadsheetId() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('SPREADSHEET_ID');
  if (!id) {
    throw new Error('スクリプトプロパティ SPREADSHEET_ID が設定されていません。プロジェクトのプロパティで設定してください。');
  }
  return id;
}

var SHEET_NAME = '環境データ';
var DISPLAY_ROWS = 150; // 最新何行分をチェックするか

/**
 * Webアプリへのアクセスに対するレスポンス
 */
function doGet(e) {
    var template = HtmlService.createTemplateFromFile('index');
    // 必要な変数をテンプレートに渡す場合はここで設定
    // template.someVar = 'value';

    return template.evaluate()
        .setTitle('サングレイス 環境モニター')
        .addMetaTag('viewport', 'width=device-width, initial-scale=1.0')
        .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * クライアントサイド(JavaScript)から呼ばれる関数
 * スプレッドシートの最新データを整形して返す
 */
function getData() {
    var sheet;
    try {
        var spreadsheetId = getSpreadsheetId();
        sheet = SpreadsheetApp.openById(spreadsheetId).getSheetByName(SHEET_NAME);
    } catch (e) {
        throw new Error('スプレッドシートを開けませんでした。IDを確認してください: ' + e.message);
    }

    if (!sheet) {
        throw new Error('シート「' + SHEET_NAME + '」が見つかりません。');
    }

    // データ範囲を取得 (最終行から過去N行分) -> 1週間分欲しいので多めに取得(150->400)
    var lastRow = sheet.getLastRow();
    // 1日48行 x 8日 = 384行 + α
    var DISPLAY_ROWS = 400;
    var startRow = Math.max(2, lastRow - DISPLAY_ROWS);
    var numRows = lastRow - startRow + 1;

    if (numRows <= 0) return { updatedAt: '', houses: {} };

    // A列(1)からAA列(27)まで取得
    var dataValues = sheet.getRange(startRow, 1, numRows, 27).getValues();

    // 最新のデータを場所ごとにMap化
    var latestMap = {};

    for (var i = 0; i < dataValues.length; i++) {
        var row = dataValues[i];
        var timestampStr = row[0]; // 日時

        // Dateオブジェクトの場合は文字列に変換 (google.script.run対策)
        if (timestampStr instanceof Date) {
            timestampStr = Utilities.formatDate(timestampStr, 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss');
        } else {
            timestampStr = String(timestampStr);
        }

        var location = row[2];     // 場所

        if (!timestampStr || !location) continue;

        // データオブジェクト作成
        // シートの列定義に合わせてマッピング:
        // 0: 日時, ... 21: 外気温度, 22: 風向, 23: 日の出, 24: 日の入, 25: 点灯開始, 26: 点灯終了
        var data = {
            timestamp: timestampStr,
            source: row[1],
            location: location,
            temperature: parseNum(row[3]),
            humidity: parseNum(row[4]),
            co2: parseNum(row[5]),
            solarRadiation: parseNum(row[6]),
            accumulatedSolarRadiation: parseNum(row[7]),
            vpd: parseNum(row[8]),
            todayMaxTemp: parseNum(row[9]),
            todayMinTemp: parseNum(row[10]),
            avgTemp24h: parseNum(row[11]),
            dayAvgTemp: parseNum(row[12]),
            nightAvgTemp: parseNum(row[13]),
            prevDayAvgTemp: parseNum(row[14]),
            prevNightAvgTemp: parseNum(row[15]),
            diffDayNight: parseNum(row[16]),
            windSpeed: parseNum(row[17]),
            yesterdayAccumulatedSolar: parseNum(row[18]),
            avgTemp48h: parseNum(row[19]),
            avgTemp72h: parseNum(row[20]),
            outsideTemperature: parseNum(row[21]),
            windDirection: String(row[22]), // 文字列として取得
            sunrise: row[23],
            sunset: row[24],
            lightingStartTime: row[25],
            lightingEndTime: row[26]
        };

        // 上書きしていくことで最新のみ残る
        latestMap[location] = data;
    }

    // フロントエンド用に整形
    // location名からhouse1, house2などを判定
    var houses = {
        house1: {},
        house2: {},
        house3: {},
        house4: {}
    };

    Object.keys(latestMap).forEach(function (loc) {
        if (loc.indexOf('1号') > -1 || latestMap[loc].source === 'profarm') {
            houses.house1 = latestMap[loc];
        } else if (loc.indexOf('2号') > -1) {
            houses.house2 = latestMap[loc];
        } else if (loc.indexOf('3号') > -1) {
            houses.house3 = latestMap[loc];
        } else if (loc.indexOf('4号') > -1) {
            houses.house4 = latestMap[loc];
        }
    });

    return {
        updatedAt: Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yy/MM/dd HH:mm'),
        houses: houses
    };
}

function parseNum(val) {
    if (val === '' || val === null || val === undefined) return null;
    var num = Number(val);
    return isNaN(num) ? null : num;
}
