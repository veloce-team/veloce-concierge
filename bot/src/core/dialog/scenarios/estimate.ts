import {
  ESTIMATE_MENU_PROMPT,
  ESTIMATE_TYPES,
  type EstimateType,
} from '../menu.js';
import type { Button, ScenarioStepResult } from '../types.js';

const ESTIMATE_BUTTONS: Button[][] = [
  ...ESTIMATE_TYPES.map(
    (t): Button[] => [{ kind: 'callback', label: t.label, data: `est:type:${t.key}` }],
  ),
  [{ kind: 'callback', label: 'Другое', data: 'est:type:other' }],
];

const ANSWER_BUTTONS: Button[][] = [
  [{ kind: 'callback', label: '💬 Связаться', data: 'main:contact' }],
  [{ kind: 'callback', label: '← Назад в меню', data: 'main:menu' }],
];

export function enterEstimate(): ScenarioStepResult {
  return {
    next: { scenario: 'estimate', step: 'menu', data: {} },
    outgoing: [{ text: ESTIMATE_MENU_PROMPT, buttons: ESTIMATE_BUTTONS }],
  };
}

export function handleEstimateChoice(choiceKey: string): ScenarioStepResult {
  const type = ESTIMATE_TYPES.find((t) => t.key === choiceKey);
  const text = type ? formatAnswer(type) : formatOtherAnswer();
  return {
    next: { scenario: 'estimate', step: 'answer', data: { estimateChoice: choiceKey } },
    outgoing: [{ text, buttons: ANSWER_BUTTONS }],
  };
}

function formatAnswer(t: EstimateType): string {
  return (
    `${t.label}: ${t.price}, срок ${t.term}.\n\n` +
    'Это вилка по прайсу — детальная AI-смета будет в следующей версии бота. ' +
    'Хочешь обсудить точную цифру сейчас — нажми «Связаться».'
  );
}

function formatOtherAnswer(): string {
  return (
    'Окей, нестандартная задача — давай обсудим напрямую. ' +
    'Нажми «Связаться», коротко опиши задачу — вернёмся с конкретной вилкой в течение дня.'
  );
}
