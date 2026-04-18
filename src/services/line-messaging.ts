import axios from 'axios';
import { logger, getEnv } from '../utils';

export class LineMessagingService {
  private channelAccessToken: string;
  private userId: string;

  constructor() {
    this.channelAccessToken = getEnv('LINE_CHANNEL_ACCESS_TOKEN', '');
    this.userId = getEnv('LINE_USER_ID', '');
  }

  async send(text: string): Promise<void> {
    if (!this.channelAccessToken || !this.userId) {
      logger.warn('LINE credential (Token or UserID) not set. Skipping notification.');
      return;
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

    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to send LINE message: ${msg}`);
      if (axios.isAxiosError(error) && error.response) {
        logger.error(`LINE API Response: ${JSON.stringify(error.response.data)}`);
      }
    }
  }

}
