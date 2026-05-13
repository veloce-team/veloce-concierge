import {
  ASK_DESCRIPTION,
  ASK_NAME,
  ASK_PHONE,
  CONTACT_DONE,
  CONTACT_FALLBACK_NOTICE,
} from '../menu.js';
import type {
  Button,
  DialogContext,
  IncomingMessage,
  ScenarioStepResult,
} from '../types.js';

const PHONE_BUTTONS: Button[][] = [
  [{ kind: 'request_contact', label: '📱 Отправить мой номер' }],
];

export function enterContact(): ScenarioStepResult {
  return {
    next: { scenario: 'contact', step: 'awaiting_name', data: {} },
    outgoing: [{ text: ASK_NAME }],
  };
}

export function handleContact(
  ctx: DialogContext,
  msg: IncomingMessage,
): ScenarioStepResult {
  const step = ctx.step ?? 'awaiting_name';

  if (step === 'awaiting_name') {
    const name = msg.text?.trim();
    if (!name) return reprompt(ctx, ASK_NAME);
    return {
      next: { scenario: 'contact', step: 'awaiting_phone', data: { ...ctx.data, name } },
      outgoing: [{ text: ASK_PHONE, buttons: PHONE_BUTTONS }],
    };
  }

  if (step === 'awaiting_phone') {
    const phone = msg.contact?.phone ?? msg.text?.trim();
    if (!phone) return reprompt(ctx, ASK_PHONE, PHONE_BUTTONS);
    return {
      next: {
        scenario: 'contact',
        step: 'awaiting_description',
        data: { ...ctx.data, phone },
      },
      outgoing: [{ text: ASK_DESCRIPTION }],
    };
  }

  if (step === 'awaiting_description') {
    const description = msg.text?.trim();
    if (!description) return reprompt(ctx, ASK_DESCRIPTION);

    const { name, phone } = ctx.data;
    if (!name || !phone) {
      // Should not happen — state machine prevents it. Defensive reset.
      return reprompt(ctx, ASK_NAME);
    }

    return {
      next: { scenario: 'idle', data: {} },
      outgoing: [{ text: CONTACT_FALLBACK_NOTICE }, { text: CONTACT_DONE }],
      sideEffects: [
        {
          kind: 'enqueue_crm',
          payload: {
            name,
            phone,
            description,
            chatId: msg.chatId,
          },
        },
      ],
    };
  }

  return reprompt(ctx, ASK_NAME);
}

function reprompt(
  ctx: DialogContext,
  text: string,
  buttons?: Button[][],
): ScenarioStepResult {
  return {
    next: ctx,
    outgoing: [buttons ? { text, buttons } : { text }],
  };
}
