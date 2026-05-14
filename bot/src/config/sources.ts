// Маппинг deep-link start_param Telegram (?start=XXX) → External ID источника в Битрикс24.
// Схема имён в Б24: «Откуда → через что добрался». TG-канал; MAX добавится в Блоке 2б отдельной таблицей.
//
// External ID берётся в Б24: Настройки → CRM → Справочники → Источники → внешний идентификатор.
// Сейчас в Б24 физически создан только один источник (Тильда Phon). Остальные ниже — placeholders.

// External ID источника «TG Concierge (direct)» в Б24.
export const DEFAULT_SOURCE_ID = 'TG_CONCIERGE_DIRECT';

export const START_PARAM_TO_SOURCE_ID: Record<string, string> = {
  phon: 'PHON_TG_CONCIERGE',
  veloce: 'VELOCE_TG_CONCIERGE',
  // Алиас veloce — тот же External ID.
  site: 'VELOCE_TG_CONCIERGE',
  kwork: 'KWORK_TG_CONCIERGE',
};

export function resolveSourceId(startParam: string | undefined): {
  sourceId: string;
  known: boolean;
} {
  if (!startParam) return { sourceId: DEFAULT_SOURCE_ID, known: true };
  const hit = START_PARAM_TO_SOURCE_ID[startParam];
  if (hit) return { sourceId: hit, known: true };
  return { sourceId: DEFAULT_SOURCE_ID, known: false };
}
