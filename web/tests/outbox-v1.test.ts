import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { createOutboxQueue } from '../src/services/outbox/queue.js';
import type { CrmPayload } from '../src/services/crm/types.js';
import { validV1Body } from './schema-v1.test.js';

const HERE = dirname(fileURLToPath(import.meta.url));

function makeDb() {
  const db = new Database(':memory:');
  for (const migration of ['001-init.sql', '002-lead-event-id.sql']) {
    db.exec(
      readFileSync(join(HERE, '..', 'src/services/sessions/migrations', migration), 'utf8'),
    );
  }
  return db;
}

function payload(): CrmPayload {
  return { ...validV1Body, sourceId: 'VELOCE_SITE' };
}

describe('OutboxQueue v1 durable idempotency', () => {
  let queue: ReturnType<typeof createOutboxQueue>;

  beforeEach(() => {
    queue = createOutboxQueue(makeDb(), () => 1_000);
  });

  it('stores at most one outbox row for a lead_event_id', () => {
    const first = queue.enqueueV1(payload());
    const duplicate = queue.enqueueV1({ ...payload(), message: 'Другое сообщение не создаёт дубль' });

    expect(first).toEqual({ id: 1, created: true });
    expect(duplicate).toEqual({ id: 1, created: false });
    expect(queue.getByLeadEventId(validV1Body.lead_event_id)?.payload.message).toBe(
      validV1Body.message,
    );
  });

  it('persists the confirmed CRM result for later duplicate requests', () => {
    queue.enqueueV1(payload());
    queue.markSent(1, { ...payload(), contactId: 42, dealId: 99 }, 2_000, {
      type: 'deal',
      id: '99',
    });

    const record = queue.getByLeadEventId(validV1Body.lead_event_id);
    expect(record).toMatchObject({
      status: 'sent',
      crmEntityType: 'deal',
      crmEntityId: '99',
      sentAt: 2_000,
    });
  });

  it('leases claimed rows so a concurrent worker cannot deliver the same deal', () => {
    const db = makeDb();
    const firstWorkerQueue = createOutboxQueue(db, () => 1_000);
    const secondWorkerQueue = createOutboxQueue(db, () => 1_000);
    firstWorkerQueue.enqueueV1(payload());

    expect(firstWorkerQueue.claimDue(1_000)).toHaveLength(1);
    expect(secondWorkerQueue.claimDue(1_000)).toEqual([]);
    expect(secondWorkerQueue.claimDue(60_000)).toEqual([]);
    expect(secondWorkerQueue.claimDue(121_001)).toHaveLength(1);
  });
});
