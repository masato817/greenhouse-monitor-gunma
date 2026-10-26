/**
 * LINE Messaging API - ユーザーID/グループID取得用 GASスクリプト
 * 
 * 使い方:
 * 1. Google Apps Scriptで新規プロジェクトを作成
 * 2. このコードを貼り付け
 * 3. CHANNEL_ACCESS_TOKENを設定
 * 4. WEBHOOK_TOKENを推測困難なランダム文字列に変更（必須）
 * 5. 「デプロイ」→「新しいデプロイ」→「ウェブアプリ」として公開
 * 6. 公開されたURLに ?token=<WEBHOOK_TOKENの値> を付けて
 *    LINE DevelopersのWebhook URLに設定
 *    例: https://script.google.com/macros/s/xxx/exec?token=ランダム文字列
 * 7. LINE公式アカウントを友だち追加 or グループに招待
 * 8. スプレッドシートにIDが記録される
 */

// 設定
const CHANNEL_ACCESS_TOKEN = 'YOUR_CHANNEL_ACCESS_TOKEN'; // ← ここを変更
const SPREADSHEET_ID = 'YOUR_SPREADSHEET_ID'; // ← 記録用スプレッドシートID（任意）
const WEBHOOK_TOKEN = 'YOUR_WEBHOOK_TOKEN'; // ← 推測困難なランダム文字列に変更（必須）

/**
 * Webhookエンドポイント
 */
function doPost(e) {
  // GAS の doPost は HTTP ヘッダを参照できず X-Line-Signature の HMAC 検証が
  // 実装不可能なため、代替として URL クエリトークンで送信元を制限する。
  // トークン未設定時も全リクエストを拒否する（fail close）。
  const token = e && e.parameter ? e.parameter.token : '';
  if (WEBHOOK_TOKEN === 'YOUR_WEBHOOK_TOKEN' || !token || token !== WEBHOOK_TOKEN) {
    console.error('Unauthorized webhook request');
    return ContentService.createTextOutput(JSON.stringify({ status: 'unauthorized' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  try {
    const events = JSON.parse(e.postData.contents).events;

    events.forEach(event => {
      logEvent(event);
    });

    return ContentService.createTextOutput(JSON.stringify({ status: 'ok' }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (error) {
    console.error('Error:', error);
    // 内部情報の漏えい防止のため、詳細はGASログのみに残し固定文言を返す
    return ContentService.createTextOutput(JSON.stringify({ status: 'error' }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

/**
 * イベントをログに記録
 */
function logEvent(event) {
  const timestamp = new Date().toLocaleString('ja-JP');
  const eventType = event.type;
  const source = event.source;
  
  let userId = source.userId || '';
  let groupId = source.groupId || '';
  let roomId = source.roomId || '';
  
  // コンソールに出力
  console.log('=== LINE Event ===');
  console.log('Timestamp:', timestamp);
  console.log('Event Type:', eventType);
  console.log('User ID:', userId);
  console.log('Group ID:', groupId);
  console.log('Room ID:', roomId);
  
  // スプレッドシートに記録（設定されている場合）
  if (SPREADSHEET_ID && SPREADSHEET_ID !== 'YOUR_SPREADSHEET_ID') {
    try {
      const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getActiveSheet();
      sheet.appendRow([timestamp, eventType, userId, groupId, roomId]);
    } catch (e) {
      console.error('Spreadsheet error:', e);
    }
  }
  
  // 友だち追加時にウェルカムメッセージを送信
  if (eventType === 'follow' && userId) {
    sendMessage(userId, 
      '🌱 ハウス環境監視システムです\n\n' +
      'あなたのユーザーIDは:\n' + userId + '\n\n' +
      'このIDを.envファイルのLINE_TARGET_IDに設定してください。'
    );
  }
  
  // グループ参加時
  if (eventType === 'join' && groupId) {
    sendMessage(groupId,
      '🌱 ハウス環境監視システムです\n\n' +
      'このグループのIDは:\n' + groupId + '\n\n' +
      'このIDを.envファイルのLINE_TARGET_IDに設定してください。'
    );
  }
}

/**
 * メッセージを送信
 */
function sendMessage(targetId, text) {
  const url = 'https://api.line.me/v2/bot/message/push';
  
  const payload = {
    to: targetId,
    messages: [
      {
        type: 'text',
        text: text
      }
    ]
  };
  
  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'Authorization': 'Bearer ' + CHANNEL_ACCESS_TOKEN
    },
    payload: JSON.stringify(payload)
  };
  
  try {
    const response = UrlFetchApp.fetch(url, options);
    console.log('Message sent:', response.getContentText());
  } catch (e) {
    console.error('Send message error:', e);
  }
}

/**
 * テスト用: 手動でメッセージ送信
 */
function testSendMessage() {
  const targetId = 'YOUR_USER_OR_GROUP_ID'; // ← テスト用ID
  sendMessage(targetId, '🌡️ テストメッセージです');
}

/**
 * Webhookの疎通確認用
 */
function doGet(e) {
  return ContentService.createTextOutput('LINE Messaging API Webhook is running!');
}
