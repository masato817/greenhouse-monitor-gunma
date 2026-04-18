/**
 * LINE Messaging API - ユーザーID/グループID取得用 GASスクリプト
 * 
 * 使い方:
 * 1. Google Apps Scriptで新規プロジェクトを作成
 * 2. このコードを貼り付け
 * 3. CHANNEL_ACCESS_TOKENを設定
 * 4. 「デプロイ」→「新しいデプロイ」→「ウェブアプリ」として公開
 * 5. 公開されたURLをLINE DevelopersのWebhook URLに設定
 * 6. LINE公式アカウントを友だち追加 or グループに招待
 * 7. スプレッドシートにIDが記録される
 */

// 設定
const CHANNEL_ACCESS_TOKEN = 'YOUR_CHANNEL_ACCESS_TOKEN'; // ← ここを変更
const SPREADSHEET_ID = 'YOUR_SPREADSHEET_ID'; // ← 記録用スプレッドシートID（任意）

/**
 * Webhookエンドポイント
 */
function doPost(e) {
  try {
    const events = JSON.parse(e.postData.contents).events;
    
    events.forEach(event => {
      logEvent(event);
    });
    
    return ContentService.createTextOutput(JSON.stringify({ status: 'ok' }))
      .setMimeType(ContentService.MimeType.JSON);
      
  } catch (error) {
    console.error('Error:', error);
    return ContentService.createTextOutput(JSON.stringify({ status: 'error', message: error.message }))
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
