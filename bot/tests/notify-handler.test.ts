import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import pino from 'pino';
import { createNotifyHandler } from '../src/infra/http/notify-handler.js';

const SECRET = 'a'.repeat(32);

const VALID_BODY = {
  name: 'Иван',
  email: 'ivan@test.ru',
  phone: '+79991234567',
  message: 'Тест',
  source: 'maxbot_pro',
  channel: 'form',
  dealId: 99,
};

function makeBot(sendOk = true) {
  const sendMessage = sendOk
    ? vi.fn().mockResolvedValue({})
    : vi.fn().mockRejectedValue(new Error('TG error'));
  return { api: { sendMessage } } as any;
}

function makeApp(bot = makeBot()) {
  const handler = createNotifyHandler({
    bot,
    operatorChatId: '-100123',
    secret: SECRET,
    logger: pino({ level: 'silent' }),
  });
  const app = new Hono();
  app.post('/internal/notify-lead', handler);
  return { app, bot };
}

async function post(
  app: Hono,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return app.request('/internal/notify-lead', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe('notify-handler', () => {
  it('returns 200 and calls sendMessage on valid request', async () => {
    const { app, bot } = makeApp();
    const res = await post(app, VALID_BODY, {
      Authorization: `Bearer ${SECRET}`,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'sent' });
    expect(bot.api.sendMessage).toHaveBeenCalledOnce();
    expect(bot.api.sendMessage).toHaveBeenCalledWith(
      '-100123',
      expect.stringContaining('Иван'),
      expect.objectContaining({ parse_mode: 'HTML' }),
    );
  });

  it('returns 401 when Authorization header is missing', async () => {
    const { app, bot } = makeApp();
    const res = await post(app, VALID_BODY);
    expect(res.status).toBe(401);
    expect(bot.api.sendMessage).not.toHaveBeenCalled();
  });

  it('returns 401 when Bearer token is wrong', async () => {
    const { app, bot } = makeApp();
    const res = await post(app, VALID_BODY, {
      Authorization: 'Bearer wrong-token-that-is-at-least-32-chars-long',
    });
    expect(res.status).toBe(401);
    expect(bot.api.sendMessage).not.toHaveBeenCalled();
  });

  it('returns 400 on invalid JSON body', async () => {
    const { app } = makeApp();
    const res = await app.request('/internal/notify-lead', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SECRET}`,
      },
      body: 'not json',
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 on failed Zod validation', async () => {
    const { app } = makeApp();
    const res = await post(app, { name: 'only name' }, {
      Authorization: `Bearer ${SECRET}`,
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('validation failed');
    expect(body.issues).toBeDefined();
  });

  it('returns 500 when sendMessage throws', async () => {
    const { app } = makeApp(makeBot(false));
    const res = await post(app, VALID_BODY, {
      Authorization: `Bearer ${SECRET}`,
    });
    expect(res.status).toBe(500);
  });

  it('handles Bearer tokens of different lengths safely', async () => {
    const { app, bot } = makeApp();
    const res = await post(app, VALID_BODY, {
      Authorization: 'Bearer short',
    });
    expect(res.status).toBe(401);
    expect(bot.api.sendMessage).not.toHaveBeenCalled();
  });
});
