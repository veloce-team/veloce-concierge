// Форматирование CrmPayload → строки для полей сделки Bitrix24.
// Чистые функции, без I/O — изолированно тестируется в tests/crm-format.test.ts.

import { WEB_SOURCE_TO_LABEL } from '../../config/sources.js';
import type { CrmPayload } from './types.js';

const LANDING_LABELS: Record<NonNullable<CrmPayload['landing']>, string> = {
  home: 'Главная (/)',
  uk: 'Для управляющих компаний (/uk/)',
  gos: 'Для администраций (/administraciyam/)',
};

const INTENT_LABELS: Record<NonNullable<CrmPayload['intent']>, string> = {
  kp: 'Коммерческое предложение',
  tz: 'Техническое задание',
};

const PRODUCT_LABELS: Record<Exclude<NonNullable<CrmPayload['product']>, ''>, string> = {
  obrashcheniya: '«Приём обращений граждан»',
  miniapp: 'Mini App «Портал жителя округа»',
  zapis: '«Запись на приём» с СЭД',
};

// TITLE сделки: «Заявка с сайта <label> — <name>».
// veloce_site сохраняет текущий вид (backward-compat существующей воронки).
export function formatDealTitle(payload: CrmPayload): string {
  const label = WEB_SOURCE_TO_LABEL[payload.source] ?? 'неизвестно';
  return `Заявка с сайта ${label} — ${payload.name}`;
}

// Префикс к user-сообщению с контекстом лендинга/намерения/продукта.
// Для veloce_site без landing/intent/product — пустая строка (backward-compat:
// сделки с veloce.team выглядят как раньше). Для maxbot_pro строка «Сайт: …»
// добавляется явно для disambiguation в карточке сделки.
export function formatCommentsPrefix(payload: CrmPayload): string {
  const lines: string[] = [];

  if (payload.source !== 'veloce_site') {
    lines.push(`Сайт: ${WEB_SOURCE_TO_LABEL[payload.source]}`);
  }
  if (payload.landing) lines.push(`Лендинг: ${LANDING_LABELS[payload.landing]}`);
  if (payload.intent) lines.push(`Запрос: ${INTENT_LABELS[payload.intent]}`);
  // payload.product === '' (CTA не из карточки витрины) — truthy-check отсечёт его.
  if (payload.product) {
    lines.push(`Интерес: ${PRODUCT_LABELS[payload.product]}`);
  }

  if (lines.length === 0) return '';
  return lines.join('\n') + '\n---\n';
}

export function formatComments(payload: CrmPayload): string {
  return formatCommentsPrefix(payload) + payload.message;
}
