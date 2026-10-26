import { describe, it, expect, vi, afterEach } from 'vitest';
import axios from 'axios';
import { LineMessagingService } from './line-messaging';

describe('LineMessagingService', () => {
    const original = { ...process.env };

    afterEach(() => {
        process.env = { ...original };
        vi.restoreAllMocks();
    });

    it('トークン前後の改行・空白を除いてから Authorization ヘッダに入れる', async () => {
        process.env.LINE_CHANNEL_ACCESS_TOKEN = ' token-value\r\n';
        process.env.LINE_USER_ID = 'U123\n';
        const post = vi.spyOn(axios, 'post').mockResolvedValue({ data: {} });

        const sent = await new LineMessagingService().send('test');

        expect(sent).toBe(true);
        const [, body, config] = post.mock.calls[0] as [string, { to: string }, { headers: Record<string, string> }];
        expect(config.headers.Authorization).toBe('Bearer token-value');
        expect(body.to).toBe('U123');
    });

    it('未設定なら送信せず false を返す', async () => {
        process.env.LINE_CHANNEL_ACCESS_TOKEN = '  ';
        process.env.LINE_USER_ID = 'U123';
        const post = vi.spyOn(axios, 'post');

        expect(await new LineMessagingService().send('test')).toBe(false);
        expect(post).not.toHaveBeenCalled();
    });

    it('送信失敗は例外にせず false を返す', async () => {
        process.env.LINE_CHANNEL_ACCESS_TOKEN = 'token';
        process.env.LINE_USER_ID = 'U123';
        vi.spyOn(axios, 'post').mockRejectedValue(new Error('Invalid character in header content'));

        expect(await new LineMessagingService().send('test')).toBe(false);
    });
});
