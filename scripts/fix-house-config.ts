/**
 * 初期化時に誤って入った1号〜4号のデフォルト行を
 * 群馬用 8号/9号 に書き換えるワンショットスクリプト
 *
 * 使い方: npx tsx scripts/fix-house-config.ts
 */
import dotenv from 'dotenv';
import { google } from 'googleapis';
import { getEnvOrThrow } from '../src/utils';

dotenv.config();

const SHEET_NAME = 'ハウス設定';

async function main() {
    const spreadsheetId = getEnvOrThrow('SPREADSHEET_ID');
    const keyFile = getEnvOrThrow('GOOGLE_SERVICE_ACCOUNT_KEY');

    const auth = new google.auth.GoogleAuth({
        keyFile,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const sheets = google.sheets({ version: 'v4', auth });

    // 1) データ範囲をクリア (A2:D99)
    await sheets.spreadsheets.values.clear({
        spreadsheetId,
        range: `${SHEET_NAME}!A2:D99`,
    });
    console.log(`Cleared ${SHEET_NAME}!A2:D99`);

    // 2) 群馬用のデフォルトを書き込み
    const defaults = [
        ['8号', '10', '', ''],
        ['9号', '10', '', ''],
    ];
    await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${SHEET_NAME}!A2`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: defaults },
    });
    console.log(`Inserted Gunma defaults: 8号 / 9号`);
    console.log('Done.');
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
