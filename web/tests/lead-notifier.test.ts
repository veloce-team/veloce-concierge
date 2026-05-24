import { describe, it, expect, vi, beforeEach } from 'vitest';
import pino from 'pino';
import {
  createLeadNotifier,
  createNullNotifier,
} from '../src/services/notifications/lead-notifier.js';
import type { CrmPayload } from '../src/services/crm/types.js';

const PAYLOAD: CrmPayload = {
  name: 'Иван',
  email: 'ivan@test.ru',
  phone: '+79991234567',
  message: 'Тестовая заявка длиннее 10 символов',
  source: 'maxbot_pro',
  channel: 'form',
  sourceId: 'MAXBOT_PRO_SITE',
  landing: 'uk',
  intent: 'kp',
  product: 'obrashcheniya',
  contactId: 42,
  dealId: 99,
};

function makeLogger() {
  return pino({ level: 'silent' });
}

describe('createLeadNotifier', () => {
  it('sends POST with Bearer header and correct body', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response('ok', { status: 200 }),
    );
    const notifier = createLeadNotifier({
      url: 'https://bot.example.com/internal/notify-lead',
      secret: 'a'.repeat(32),
      logger: makeLogger(),
      fetch: fetchMock,
    });

    await notifier.notify(PAYLOAD);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://bot.example.com/internal/notify-lead');
    expect((init as RequestInit).method).toBe('POST');
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: `Bearer ${'a'.repeat(32)}`,
      'Content-Type': 'application/json',
    });
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.name).toBe('Иван');
    expect(body.dealId).toBe(99);
    expect(body.contactId).toBe(42);
    expect(body.landing).toBe('uk');
  });

  it('does not throw on 4xx response', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response('bad', { status: 400 }),
    );
    const notifier = createLeadNotifier({
      url: 'https://bot.example.com/x',
      secret: 'a'.repeat(32),
      logger: makeLogger(),
      fetch: fetchMock,
    });

    await expect(notifier.notify(PAYLOAD)).resolves.toBeUndefined();
  });

  it('does not throw on 5xx response', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response('err', { status: 500 }),
    );
    const notifier = createLeadNotifier({
      url: 'https://bot.example.com/x',
      secret: 'a'.repeat(32),
      logger: makeLogger(),
      fetch: fetchMock,
    });

    await expect(notifier.notify(PAYLOAD)).resolves.toBeUndefined();
  });

  it('does not throw on network error', async () => {
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValue(new TypeError('fetch failed'));
    const notifier = createLeadNotifier({
      url: 'https://bot.example.com/x',
      secret: 'a'.repeat(32),
      logger: makeLogger(),
      fetch: fetchMock,
    });

    await expect(notifier.notify(PAYLOAD)).resolves.toBeUndefined();
  });

  it('does not throw on abort (timeout)', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockImplementation(
      async (_url, init) => {
        const signal = (init as RequestInit).signal!;
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        });
      },
    );
    const notifier = createLeadNotifier({
      url: 'https://bot.example.com/x',
      secret: 'a'.repeat(32),
      logger: makeLogger(),
      fetch: fetchMock,
      timeoutMs: 50,
    });

    await expect(notifier.notify(PAYLOAD)).resolves.toBeUndefined();
  });

  it('sends null for missing optional fields', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response('ok', { status: 200 }),
    );
    const notifier = createLeadNotifier({
      url: 'https://bot.example.com/x',
      secret: 'a'.repeat(32),
      logger: makeLogger(),
      fetch: fetchMock,
    });

    const minimal: CrmPayload = {
      name: 'Test',
      email: 't@t.ru',
      phone: '+79990000000',
      message: 'minimal test message',
      source: 'veloce_site',
      channel: 'form',
      sourceId: 'VELOCE_SITE',
    };
    await notifier.notify(minimal);

    const body = JSON.parse(
      (fetchMock.mock.calls[0]![1] as RequestInit).body as string,
    );
    expect(body.landing).toBeNull();
    expect(body.intent).toBeNull();
    expect(body.product).toBeNull();
    expect(body.contactId).toBeNull();
    expect(body.dealId).toBeNull();
  });
});

describe('createNullNotifier', () => {
  it('notify() does not throw and does not call fetch', async () => {
    const notifier = createNullNotifier();
    await expect(notifier.notify(PAYLOAD)).resolves.toBeUndefined();
  });
});
