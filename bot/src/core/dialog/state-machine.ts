import { GREETING, MAIN_MENU_BUTTONS } from './menu.js';
import { handleContact, enterContact } from './scenarios/contact.js';
import { enterEstimate, handleEstimateChoice } from './scenarios/estimate.js';
import { enterPortfolio } from './scenarios/portfolio.js';
import { startScenario } from './scenarios/start.js';
import {
  INITIAL_CONTEXT,
  type DialogContext,
  type IncomingMessage,
  type ScenarioStepResult,
} from './types.js';

export function handleUpdate(
  ctxOrNull: DialogContext | null,
  msg: IncomingMessage,
): ScenarioStepResult {
  const ctx = ctxOrNull ?? INITIAL_CONTEXT;

  // /start всегда сбрасывает state — это явное требование задания
  if (msg.isCommand && msg.command === 'start') {
    return startScenario();
  }

  const cb = msg.callbackData;

  if (cb === 'main:menu') {
    return {
      next: { scenario: 'idle', data: {} },
      outgoing: [{ text: GREETING, buttons: MAIN_MENU_BUTTONS }],
    };
  }
  if (cb === 'main:contact') return enterContact();
  if (cb === 'main:portfolio') return enterPortfolio();
  if (cb === 'main:estimate') return enterEstimate();

  if (cb?.startsWith('est:type:')) {
    const key = cb.slice('est:type:'.length);
    return handleEstimateChoice(key);
  }

  if (ctx.scenario === 'contact') {
    return handleContact(ctx, msg);
  }

  // idle / неизвестный ввод — мягко возвращаем меню
  return {
    next: { scenario: 'idle', data: {} },
    outgoing: [{ text: GREETING, buttons: MAIN_MENU_BUTTONS }],
  };
}
