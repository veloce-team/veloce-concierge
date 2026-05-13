import type { Button } from './types.js';

export const GREETING =
  'Здравствуйте. Это Veloce Concierge — бот микростудии Veloce. ' +
  'Помогаю разобраться, что мы можем сделать для вашего бизнеса, и связываю с командой.\n\n' +
  'Что подойдёт?';

export const MAIN_MENU_BUTTONS: Button[][] = [
  [{ kind: 'callback', label: '💬 Связаться с командой', data: 'main:contact' }],
  [{ kind: 'callback', label: '📂 Посмотреть портфолио', data: 'main:portfolio' }],
  [{ kind: 'callback', label: '💰 Оценить проект', data: 'main:estimate' }],
];

export const ASK_NAME = 'Как к вам обращаться?';
export const ASK_PHONE =
  'Оставьте телефон для связи. Можно текстом или кнопкой ниже.';
export const ASK_DESCRIPTION =
  'Опишите задачу одним сообщением — что нужно сделать, для какого бизнеса, какие сроки.';
export const CONTACT_DONE =
  'Спасибо. Передал заявку в команду — ответят в течение рабочего дня. ' +
  'Если что-то срочное — напишите ещё раз, отметим как приоритет.';
export const CONTACT_FALLBACK_NOTICE =
  'Минутку, фиксирую заявку. Если в течение 5 минут не получишь подтверждения — напиши /start.';

export const PORTFOLIO_TEXT =
  'Phon — premium hi-fi магазин.\n\n' +
  'Что сделано: одностраничный сайт-каталог с акцентом на эстетику звука ' +
  'и тактильную минималистику. Тёмная цветовая схема, акценты тёплым латунным, ' +
  'типографика на Cormorant + Inter. Каталог построен из MDX, корзина — клиентская.\n\n' +
  'Стек: Next.js 14, TypeScript, Tailwind, MDX. Хостинг — собственный VPS, HTTPS через Caddy.\n\n' +
  'Что заказчик получил: полноценная витрина за 12 дней, готовая под подключение ' +
  'платёжного шлюза и расширение каталога.';

export const PORTFOLIO_URL_PLACEHOLDER = 'https://veloce.team';

export const ESTIMATE_MENU_PROMPT = 'Какой тип задачи примерно подходит?';

export type EstimateType = {
  key: string;
  label: string;
  price: string;
  term: string;
};

export const ESTIMATE_TYPES: EstimateType[] = [
  {
    key: 'basic_bot',
    label: 'Базовый бот в Telegram под ключ',
    price: 'от 50 000 ₽',
    term: '5–10 дней',
  },
  {
    key: 'crm_bot',
    label: 'Бот + интеграция CRM',
    price: 'от 120 000 ₽',
    term: '10–18 дней',
  },
  {
    key: 'ai_bot',
    label: 'Бот + AI-агент (GigaChat)',
    price: 'от 180 000 ₽',
    term: '2–3 недели',
  },
  {
    key: 'max_dup',
    label: 'Дублирование бота в МАКС',
    price: 'от 35 000 ₽',
    term: '3–7 дней',
  },
  {
    key: 'miniapp',
    label: 'Mini App простой',
    price: 'от 150 000 ₽',
    term: '2–4 недели',
  },
  {
    key: 'miniapp_ecom',
    label: 'Mini App с e-commerce',
    price: 'от 350 000 ₽',
    term: '4–8 недель',
  },
];
