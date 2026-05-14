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
    // /start всегда переопределяет sourceId: новый deep-link = новая атрибуция.
    return startScenario(msg.startParam);
  }

  // sourceId резолвится только при /start и затем «прилипает» к контексту
  // до следующего /start. Все промежуточные транзиции его сохраняют.
  const sourceId = ctx.sourceId;
  const withSource = (r: ScenarioStepResult): ScenarioStepResult => ({
    ...r,
    next: { ...r.next, sourceId: r.next.sourceId ?? sourceId },
  });

  const cb = msg.callbackData;

  if (cb === 'main:menu') {
    return {
      next: { scenario: 'idle', data: {}, sourceId },
      outgoing: [{ text: GREETING, buttons: MAIN_MENU_BUTTONS }],
    };
  }
  if (cb === 'main:contact') return withSource(enterContact());
  if (cb === 'main:portfolio') return withSource(enterPortfolio());
  if (cb === 'main:estimate') return withSource(enterEstimate());

  if (cb?.startsWith('est:type:')) {
    const key = cb.slice('est:type:'.length);
    return withSource(handleEstimateChoice(key));
  }

  if (ctx.scenario === 'contact') {
    return withSource(handleContact(ctx, msg));
  }

  // idle / неизвестный ввод — мягко возвращаем меню
  return {
    next: { scenario: 'idle', data: {}, sourceId },
    outgoing: [{ text: GREETING, buttons: MAIN_MENU_BUTTONS }],
  };
}
