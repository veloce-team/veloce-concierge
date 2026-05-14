import { describe, expect, it } from 'vitest';
import { handleUpdate } from '../src/core/dialog/state-machine.js';
import type { DialogContext, IncomingMessage } from '../src/core/dialog/types.js';

function msg(partial: Partial<IncomingMessage>): IncomingMessage {
  return {
    platform: 'tg',
    chatId: '100',
    updateId: '1',
    isCommand: false,
    ...partial,
  };
}

describe('state machine: contact happy path', () => {
  it('walks start → awaiting_name → awaiting_phone → awaiting_description → idle + enqueue', () => {
    // /start
    const r1 = handleUpdate(null, msg({ isCommand: true, command: 'start', text: '/start' }));
    expect(r1.next.scenario).toBe('idle');
    expect(r1.outgoing[0]?.buttons).toBeDefined();

    // pick "contact"
    const r2 = handleUpdate(r1.next, msg({ callbackData: 'main:contact' }));
    expect(r2.next.scenario).toBe('contact');
    expect(r2.next.step).toBe('awaiting_name');

    // send name
    const r3 = handleUpdate(r2.next, msg({ text: 'Иван' }));
    expect(r3.next.step).toBe('awaiting_phone');
    expect(r3.next.data.name).toBe('Иван');

    // send phone
    const r4 = handleUpdate(r3.next, msg({ text: '+79991234567' }));
    expect(r4.next.step).toBe('awaiting_description');
    expect(r4.next.data.phone).toBe('+79991234567');

    // send description → done + enqueue
    const r5 = handleUpdate(
      r4.next,
      msg({ text: 'Нужен бот для записи на тест-драйв, авто-дилер, в течение 2 недель' }),
    );
    expect(r5.next.scenario).toBe('idle');
    expect(r5.sideEffects).toHaveLength(1);
    expect(r5.sideEffects?.[0]?.kind).toBe('enqueue_crm');
    if (r5.sideEffects?.[0]?.kind === 'enqueue_crm') {
      expect(r5.sideEffects[0].payload.name).toBe('Иван');
      expect(r5.sideEffects[0].payload.phone).toBe('+79991234567');
    }
  });

  it('/start phon → next.sourceId = mapping for phon, propagates to CrmPayload', () => {
    const r1 = handleUpdate(
      null,
      msg({ isCommand: true, command: 'start', text: '/start phon', startParam: 'phon' }),
    );
    expect(r1.next.sourceId).toBe('PHON_TG_CONCIERGE');

    const r2 = handleUpdate(r1.next, msg({ callbackData: 'main:contact' }));
    expect(r2.next.sourceId).toBe('PHON_TG_CONCIERGE');

    const r3 = handleUpdate(r2.next, msg({ text: 'Иван' }));
    const r4 = handleUpdate(r3.next, msg({ text: '+79991234567' }));
    const r5 = handleUpdate(r4.next, msg({ text: 'описание задачи на 30+ символов хватит уже' }));

    expect(r5.sideEffects?.[0]?.kind).toBe('enqueue_crm');
    if (r5.sideEffects?.[0]?.kind === 'enqueue_crm') {
      expect(r5.sideEffects[0].payload.sourceId).toBe('PHON_TG_CONCIERGE');
    }
  });

  it('/start без параметра → DEFAULT_SOURCE_ID', () => {
    const r = handleUpdate(null, msg({ isCommand: true, command: 'start', text: '/start' }));
    expect(r.next.sourceId).toBe('TG_CONCIERGE_DIRECT');
  });

  it('/start с неизвестным параметром → DEFAULT_SOURCE_ID', () => {
    const r = handleUpdate(
      null,
      msg({ isCommand: true, command: 'start', text: '/start xxx', startParam: 'xxx' }),
    );
    expect(r.next.sourceId).toBe('TG_CONCIERGE_DIRECT');
  });

  it('/start mid-dialog resets to idle', () => {
    const mid: DialogContext = {
      scenario: 'contact',
      step: 'awaiting_phone',
      data: { name: 'Иван' },
    };
    const r = handleUpdate(mid, msg({ isCommand: true, command: 'start', text: '/start' }));
    expect(r.next.scenario).toBe('idle');
    expect(r.next.data.name).toBeUndefined();
  });

  it('awaiting_phone accepts contact-share button payload', () => {
    const ctx: DialogContext = {
      scenario: 'contact',
      step: 'awaiting_phone',
      data: { name: 'Иван' },
    };
    const r = handleUpdate(
      ctx,
      msg({ contact: { phone: '+79990000000', name: 'Иван' } }),
    );
    expect(r.next.step).toBe('awaiting_description');
    expect(r.next.data.phone).toBe('+79990000000');
  });

  it('empty input on awaiting_name re-prompts without losing scenario', () => {
    const ctx: DialogContext = {
      scenario: 'contact',
      step: 'awaiting_name',
      data: {},
    };
    const r = handleUpdate(ctx, msg({ text: '   ' }));
    expect(r.next.scenario).toBe('contact');
    expect(r.next.step).toBe('awaiting_name');
  });
});

describe('state machine: estimate', () => {
  it('estimate menu → answer with Связаться/Назад', () => {
    const r1 = handleUpdate(null, msg({ callbackData: 'main:estimate' }));
    expect(r1.next.scenario).toBe('estimate');
    expect(r1.next.step).toBe('menu');

    const r2 = handleUpdate(r1.next, msg({ callbackData: 'est:type:basic_bot' }));
    expect(r2.next.scenario).toBe('estimate');
    expect(r2.next.step).toBe('answer');
    expect(r2.outgoing[0]?.text).toContain('50 000');
  });

  it('answer → main:contact enters contact flow', () => {
    const ctx: DialogContext = {
      scenario: 'estimate',
      step: 'answer',
      data: { estimateChoice: 'basic_bot' },
    };
    const r = handleUpdate(ctx, msg({ callbackData: 'main:contact' }));
    expect(r.next.scenario).toBe('contact');
    expect(r.next.step).toBe('awaiting_name');
  });
});
