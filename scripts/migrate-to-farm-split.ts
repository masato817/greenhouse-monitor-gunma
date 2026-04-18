/**
 * 統合版への移行スクリプト（Commit A 適用時に1度だけ実行）
 *
 * 動作:
 * 1. 旧シート「環境データ」が存在すれば「群馬_環境データ」にリネーム
 *    （現在 群馬テストデータ 2件が入っているため）
 * 2. 旧シート「潅水目安履歴」が存在すれば「群馬_潅水目安履歴」にリネーム
 *    （空の可能性が高いがそのままリネーム）
 * 3. 「静岡_環境データ」「静岡_潅水目安履歴」は initializeSheets() が自動作成
 * 4. 「ハウス設定」シートに不足している静岡4棟(1-4号)を追記
 *
 * 使い方:
 *   npx tsx scripts/migrate-to-farm-split.ts
 *
 * 冪等性: 2回目以降の実行でも安全 (既に移行済みなら何もしない)
 */
import dotenv from 'dotenv';
import { google, sheets_v4 } from 'googleapis';
import { getEnvOrThrow, getEnv } from '../src/utils';

dotenv.config();

const OLD_DATA = '環境データ';
const OLD_WATERING = '潅水目安履歴';
const NEW_DATA_GUNMA = '群馬_環境データ';
const NEW_WATERING_GUNMA = '群馬_潅水目安履歴';
const HOUSE_CONFIG = 'ハウス設定';

async function main(): Promise<void> {
    const spreadsheetId = getEnvOrThrow('SPREADSHEET_ID');
    const keyFile = getEnv('GOOGLE_SERVICE_ACCOUNT_KEY', './credentials/service-account.json');

    const auth = new google.auth.GoogleAuth({
        keyFile,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const sheets = google.sheets({ version: 'v4', auth });

    console.log(`\n=== マイグレーション開始 (spreadsheet=${spreadsheetId}) ===\n`);

    // 現状シート一覧を取得
    const metadata = await sheets.spreadsheets.get({ spreadsheetId });
    const allSheets: sheets_v4.Schema$Sheet[] = metadata.data.sheets || [];
    const getId = (title: string): number | null => {
        const s = allSheets.find(x => x.properties?.title === title);
        return s?.properties?.sheetId ?? null;
    };

    const renameRequests: sheets_v4.Schema$Request[] = [];

    const oldDataId = getId(OLD_DATA);
    const newDataGunmaExists = getId(NEW_DATA_GUNMA) !== null;
    if (oldDataId !== null && !newDataGunmaExists) {
        console.log(`[RENAME] "${OLD_DATA}" -> "${NEW_DATA_GUNMA}"`);
        renameRequests.push({
            updateSheetProperties: {
                properties: { sheetId: oldDataId, title: NEW_DATA_GUNMA },
                fields: 'title',
            },
        });
    } else if (newDataGunmaExists) {
        console.log(`[SKIP] "${NEW_DATA_GUNMA}" 既に存在`);
    } else {
        console.log(`[SKIP] "${OLD_DATA}" 存在しない`);
    }

    const oldWateringId = getId(OLD_WATERING);
    const newWateringGunmaExists = getId(NEW_WATERING_GUNMA) !== null;
    if (oldWateringId !== null && !newWateringGunmaExists) {
        console.log(`[RENAME] "${OLD_WATERING}" -> "${NEW_WATERING_GUNMA}"`);
        renameRequests.push({
            updateSheetProperties: {
                properties: { sheetId: oldWateringId, title: NEW_WATERING_GUNMA },
                fields: 'title',
            },
        });
    } else if (newWateringGunmaExists) {
        console.log(`[SKIP] "${NEW_WATERING_GUNMA}" 既に存在`);
    } else {
        console.log(`[SKIP] "${OLD_WATERING}" 存在しない`);
    }

    if (renameRequests.length > 0) {
        await sheets.spreadsheets.batchUpdate({
            spreadsheetId,
            requestBody: { requests: renameRequests },
        });
        console.log(`[OK] ${renameRequests.length}件のリネーム完了`);
    }

    // ハウス設定に不足している静岡4棟を追記
    const houseConfigId = getId(HOUSE_CONFIG);
    if (houseConfigId === null) {
        console.log(`[SKIP] "${HOUSE_CONFIG}" 未作成 (initializeSheets 実行が必要)`);
    } else {
        const houseResp = await sheets.spreadsheets.values.get({
            spreadsheetId,
            range: `${HOUSE_CONFIG}!A2:A`,
        });
        const existing = (houseResp.data.values || []).flat().map(v => String(v).trim());
        const need = ['1号', '2号', '3号', '4号'].filter(h => !existing.includes(h));
        if (need.length > 0) {
            console.log(`[APPEND] ハウス設定に不足分を追加: ${need.join(', ')}`);
            const values = need.map(h => [h, '10', '', '']);
            await sheets.spreadsheets.values.append({
                spreadsheetId,
                range: `${HOUSE_CONFIG}!A2`,
                valueInputOption: 'USER_ENTERED',
                insertDataOption: 'INSERT_ROWS',
                requestBody: { values },
            });
        } else {
            console.log(`[SKIP] ハウス設定は静岡4棟も既に登録済み`);
        }
    }

    console.log('\n=== マイグレーション完了 ===');
    console.log('次: `npx tsx src/app.ts --init` で不足シート(静岡_環境データ等)を自動作成');
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
