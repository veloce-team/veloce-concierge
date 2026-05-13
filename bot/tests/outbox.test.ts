import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CRMClient, CrmPayload } from '../src/core/dialog/types.js';
import { CrmPartialError } from '../src/services/crm/bitrix24.js';
import { createOutboxQueue } from '../src/services/outbox/queue.js';
import {
  BACKOFF_MS,
  MAX_ATTEMPTS,
  createOutboxWorker,
} from '../src/services/outbox/worker.js';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION_SQL = readFileSync(
  join(here, '..', 'src', 'services', 'sessions', 'migrations', '001-init.sql'),
  'utf8',
);
const silentLogger = pino({ level: 'silent' });

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(MIGRATION_SQL);
  return db;
}

const samplePayload: CrmPayload = {
  name: 'Иван',
  phone: '+79991234567',
  description: 'Нужен бот',
  chatId: '100',
};

describe('outbox worker', () => {
  let nowMs = 1_700_000_000_000;
  beforeEach(() => {
    nowMs = 1_700_000_000_000;
  });
  const now = () => nowMs;

  it('marks record as sent on first success', async () => {
    const db = freshDb();
    const queue = createOutboxQueue(db, () => nowMs);
    const crm: CRMClient = {
      createLead: vi.fn().mockResolvedValue({ contactId: 11, dealId: 22 }),
    };
    const worker = createOutboxWorker({ queue, crm, logger: silentLogger, now });

    queue.enqueue(samplePayload);
    await worker.tick();

    const row = db.prepare('SELECT status, attempts, sent_at FROM outbox').get() as {
      status: string;
      attempts: number;
      sent_at: number | null;
    };
    expect(row.status).toBe('sent');
    expect(row.attempts).toBe(0);
    expect(row.sent_at).toBe(nowMs);
    expect(crm.createLead).toHaveBeenCalledTimes(1);
  });

  it('retries after failure with exponential backoff', async () => {
    const db = freshDb();
    const queue = createOutboxQueue(db, () => nowMs);
    const createLead = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom-1'))
      .mockRejectedValueOnce(new Error('boom-2'))
      .mockResolvedValueOnce({ contactId: 11, dealId: 22 });
    const worker = createOutboxWorker({
      queue,
      crm: { createLead },
      logger: silentLogger,
      now,
    });

    queue.enqueue(samplePayload);

    await worker.tick();
    let row = db.prepare('SELECT status, attempts, next_attempt_at FROM outbox').get() as {
      status: string;
      attempts: number;
      next_attempt_at: number;
    };
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(1);
    expect(row.next_attempt_at).toBe(nowMs + BACKOFF_MS[1]!);

    // advance time past the next attempt
    nowMs += BACKOFF_MS[1]!;
    await worker.tick();
    row = db.prepare('SELECT status, attempts, next_attempt_at FROM outbox').get() as {
      status: string;
      attempts: number;
      next_attempt_at: number;
    };
    expect(row.attempts).toBe(2);

    nowMs += BACKOFF_MS[2]!;
    await worker.tick();
    row = db.prepare('SELECT status, attempts, next_attempt_at FROM outbox').get() as {
      status: string;
      attempts: number;
      next_attempt_at: number;
    };
    expect(row.status).toBe('sent');
    expect(createLead).toHaveBeenCalledTimes(3);
  });

  it('marks failed after MAX_ATTEMPTS', async () => {
    const db = freshDb();
    const queue = createOutboxQueue(db, () => nowMs);
    const createLead = vi.fn().mockRejectedValue(new Error('always-fail'));
    const worker = createOutboxWorker({
      queue,
      crm: { createLead },
      logger: silentLogger,
      now,
    });
    queue.enqueue(samplePayload);

    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      await worker.tick();
      const row = db.prepare('SELECT status, next_attempt_at FROM outbox').get() as {
        status: string;
        next_attempt_at: number;
      };
      if (i < MAX_ATTEMPTS - 1) {
        expect(row.status).toBe('pending');
        nowMs += BACKOFF_MS[Math.min(i + 1, BACKOFF_MS.length - 1)]!;
      } else {
        expect(row.status).toBe('failed');
      }
    }
    expect(createLead).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    const final = db.prepare('SELECT last_error FROM outbox').get() as {
      last_error: string;
    };
    expect(final.last_error).toBe('always-fail');
  });

  it('preserves contactId across retries on CrmPartialError', async () => {
    const db = freshDb();
    const queue = createOutboxQueue(db, () => nowMs);
    const createLead = vi
      .fn()
      .mockRejectedValueOnce(new CrmPartialError('deal.add failed', 555))
      .mockResolvedValueOnce({ contactId: 555, dealId: 777 });
    const worker = createOutboxWorker({
      queue,
      crm: { createLead },
      logger: silentLogger,
      now,
    });
    queue.enqueue(samplePayload);

    await worker.tick();
    const mid = db.prepare('SELECT payload FROM outbox').get() as { payload: string };
    expect(JSON.parse(mid.payload).contactId).toBe(555);

    nowMs += BACKOFF_MS[1]!;
    await worker.tick();
    expect(createLead.mock.calls[1]?.[0].contactId).toBe(555);
    const row = db.prepare('SELECT status FROM outbox').get() as { status: string };
    expect(row.status).toBe('sent');
  });
});
