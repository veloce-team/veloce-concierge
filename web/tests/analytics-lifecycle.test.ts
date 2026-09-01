import Database from 'better-sqlite3';
import pino from 'pino';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { createAnalyticsRepository } from '../src/services/analytics/repository.js';
import type { AnalyticsDeal } from '../src/services/analytics/semantic.js';
import { createAnalyticsWorker } from '../src/services/analytics/worker.js';

const HERE = dirname(fileURLToPath(import.meta.url));

function makeDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  for (const migration of ['001-init.sql', '002-lead-event-id.sql', '003-offline-analytics.sql']) {
    db.exec(readFileSync(join(HERE, '..', 'src/services/sessions/migrations', migration), 'utf8'));
  }
  return db;
}

const deal: AnalyticsDeal = {
  portalId: 'portal-1',
  dealId: '42',
  contactId: '7',
  categoryId: '2',
  stageId: 'C2:NEW',
  createdAt: '2026-09-01T09:00:00Z',
  modifiedAt: '2026-09-01T10:00:00Z',
  opportunity: '0',
  currencyId: 'RUB',
  ymClientId: '123456789012345678',
};
const history = [
  { id: '1', categoryId: '0', stageId: 'NEW', createdAt: '2026-09-01T09:00:00Z' },
  { id: '2', categoryId: '2', stageId: 'C2:NEW', createdAt: '2026-09-01T10:00:00Z' },
];

function fakeBitrix() {
  return {
    listTrackedDeals: vi.fn().mockResolvedValue([deal]),
    getStageHistory: vi.fn().mockResolvedValue(history),
  };
}

function silentLogger() {
  return pino({ enabled: false });
}

describe('offline analytics lifecycle integration', () => {
  it('recovers committed outbox work after a restart between polling and delivery', async () => {
    const db = makeDb();
    const repository = createAnalyticsRepository(db, () => 1_000);
    const firstProcess = createAnalyticsWorker({
      bitrix: fakeBitrix(),
      repository,
      yandex: {} as never,
      logger: silentLogger(),
      now: () => 1_000,
    });

    await firstProcess.tickPoll();
    expect(repository.countByStatus()).toMatchObject({ dirty: 1 });

    const upload = vi.fn().mockResolvedValue({
      uploadId: 'upload-1',
      validationStatus: 'PASSED',
      elementsCount: 1,
    });
    const restarted = createAnalyticsWorker({
      bitrix: fakeBitrix(),
      repository,
      yandex: {
        upload,
        getUploadStatusPage: vi.fn().mockResolvedValue({
          upload: { uploadId: 'upload-1', validationStatus: 'PASSED', elementsCount: 1 },
          nextCursor: null,
          exhausted: true,
        }),
      },
      logger: silentLogger(),
      now: () => 2_000,
    });

    await restarted.tickUpload();
    await restarted.tickReconcile();
    expect(upload).toHaveBeenCalledOnce();
    expect(repository.countByStatus()).toMatchObject({ clean: 1 });
    db.close();
  });

  it('replays an interrupted send with the same deterministic order id', async () => {
    const db = makeDb();
    const firstRepository = createAnalyticsRepository(db, () => 1_000);

    const poller = createAnalyticsWorker({
      bitrix: fakeBitrix(),
      repository: firstRepository,
      yandex: {} as never,
      logger: silentLogger(),
      now: () => 1_000,
    });
    await poller.tickPoll();

    const upload = vi.fn().mockResolvedValue({
      uploadId: 'upload-1',
      validationStatus: 'PASSED',
      elementsCount: 1,
    });
    firstRepository.claimDue(1_000);
    const restarted = createAnalyticsWorker({
      bitrix: fakeBitrix(),
      repository: createAnalyticsRepository(db, () => 2_000),
      yandex: { upload } as never,
      logger: silentLogger(),
      now: () => 2_000,
    });

    await restarted.tickUpload();
    expect(upload).toHaveBeenCalledOnce();
    expect(upload.mock.calls[0]![0]).toMatchObject({ id: 'b24:portal-1:deal:42' });
    expect(firstRepository.countByStatus()).toMatchObject({ accepted: 1 });
    db.close();
  });
});
