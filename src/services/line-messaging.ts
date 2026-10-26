import axios from 'axios';
import { logger, getEnv } from '../utils';

export class LineMessagingService {
  private channelAccessToken: string;
  private userId: string;

  constructor() {
    // 前後の改行・空白（CRLF の \r や貼り付け時の余白）が残ると Authorization ヘッダが
    // 「Invalid character in header content」で拒否され、通知が一度も届かなくなるため除去する
    this.channelAccessToken = getEnv('LINE_CHANNEL_ACCESS_TOKEN', '').trim();
    this.userId = getEnv('LINE_USER_ID', '').trim();
  }

  /**
   * テキストをプッシュ送信する。失敗しても例外は投げない
   * @returns 送信できたら true（未設定・失敗は false）
   */
  async send(text: string): Promise<boolean> {
    if (!this.channelAccessToken || !this.userId) {
      logger.warn('LINE credential (Token or UserID) not set. Skipping notification.');
      return false;
    }

    try {
      logger.info('Sending LINE message via Messaging API...');

      const url = 'https://api.line.me/v2/bot/message/push';
      const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.channelAccessToken}`
      };

      const data = {
        to: this.userId,
        messages: [
          {
            type: 'text',
            text: text
          }
        ]
      };

      await axios.post(url, data, { headers });
      logger.info('LINE message sent successfully.');
      return true;

    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to send LINE message: ${msg}`);
      if (axios.isAxiosError(error) && error.response) {
        logger.error(`LINE API Response: ${JSON.stringify(error.response.data)}`);
      }
      return false;
    }
  }

}
