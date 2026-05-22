import { describe, it, expect } from 'vitest';
import {
  formatCommentsPrefix,
  formatComments,
  formatDealTitle,
} from '../src/services/crm/format.js';
import type { CrmPayload } from '../src/services/crm/types.js';

function base(overrides: Partial<CrmPayload> = {}): CrmPayload {
  return {
    name: 'Иван',
    email: 'i@example.com',
    phone: '+79991234567',
    message: 'Хочу обсудить проект',
    source: 'veloce_site',
    channel: 'form',
    sourceId: 'VELOCE_SITE',
    ...overrides,
  };
}

describe('formatDealTitle', () => {
  it('veloce_site → "Заявка с сайта veloce.team — <name>"', () => {
    expect(formatDealTitle(base())).toBe('Заявка с сайта veloce.team — Иван');
  });

  it('maxbot_pro → "Заявка с сайта MaxBot Pro — <name>"', () => {
    expect(formatDealTitle(base({ source: 'maxbot_pro', sourceId: 'MAXBOT_PRO' }))).toBe(
      'Заявка с сайта MaxBot Pro — Иван',
    );
  });
});

describe('formatCommentsPrefix', () => {
  it('veloce_site без landing/intent/product — пустой префикс (backward-compat)', () => {
    expect(formatCommentsPrefix(base())).toBe('');
  });

  it('maxbot_pro без optional полей — префикс только с строкой "Сайт"', () => {
    const out = formatCommentsPrefix(base({ source: 'maxbot_pro', sourceId: 'MAXBOT_PRO' }));
    expect(out).toBe('Сайт: MaxBot Pro\n---\n');
  });

  it('maxbot_pro + landing=uk без intent/product — две строки', () => {
    const out = formatCommentsPrefix(
      base({ source: 'maxbot_pro', sourceId: 'MAXBOT_PRO', landing: 'uk' }),
    );
    expect(out).toBe(
      'Сайт: MaxBot Pro\nЛендинг: Для управляющих компаний (/uk/)\n---\n',
    );
  });

  it('maxbot_pro + landing=gos + intent=kp + product=miniapp — полный префикс', () => {
    const out = formatCommentsPrefix(
      base({
        source: 'maxbot_pro',
        sourceId: 'MAXBOT_PRO',
        landing: 'gos',
        intent: 'kp',
        product: 'miniapp',
      }),
    );
    expect(out).toContain('Сайт: MaxBot Pro');
    expect(out).toContain('Лендинг: Для администраций (/administraciyam/)');
    expect(out).toContain('Запрос: Коммерческое предложение');
    expect(out).toContain('Интерес: Mini App «Портал жителя округа»');
    expect(out.endsWith('\n---\n')).toBe(true);
  });

  it('product="" (CTA не из карточки) — Интерес-строка не рендерится', () => {
    const out = formatCommentsPrefix(
      base({
        source: 'maxbot_pro',
        sourceId: 'MAXBOT_PRO',
        landing: 'gos',
        intent: 'kp',
        product: '',
      }),
    );
    expect(out).not.toContain('Интерес:');
    expect(out).toContain('Лендинг:');
    expect(out).toContain('Запрос:');
  });

  it('все три product-варианта мапятся корректно', () => {
    const base24 = base({ source: 'maxbot_pro', sourceId: 'MAXBOT_PRO' });
    expect(formatCommentsPrefix({ ...base24, product: 'obrashcheniya' })).toContain(
      '«Приём обращений граждан»',
    );
    expect(formatCommentsPrefix({ ...base24, product: 'zapis' })).toContain(
      '«Запись на приём» с СЭД',
    );
  });
});

describe('formatComments', () => {
  it('veloce_site backward-compat — COMMENTS = payload.message', () => {
    expect(formatComments(base())).toBe('Хочу обсудить проект');
  });

  it('maxbot_pro — префикс + разделитель + message', () => {
    const out = formatComments(
      base({
        source: 'maxbot_pro',
        sourceId: 'MAXBOT_PRO',
        landing: 'gos',
        intent: 'kp',
        product: 'miniapp',
        message: 'Заявка через max-microsite',
      }),
    );
    expect(out).toContain('Сайт: MaxBot Pro');
    expect(out).toContain('---');
    expect(out.endsWith('Заявка через max-microsite')).toBe(true);
  });
});
