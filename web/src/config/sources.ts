// Map web-form `source` payload values → Битрикс24 SOURCE_ID (STATUS_ID).
// Создан 16.05.2026: единственный канал на старте — veloce_site → VELOCE_SITE.
// 22.05.2026: добавлен maxbot_pro → MAXBOT_PRO (вторая посадочная — max-microsite).

export const WEB_SOURCE_TO_SOURCE_ID = {
  veloce_site: 'VELOCE_SITE',
  maxbot_pro: 'MAXBOT_PRO',
} as const;

export type WebSource = keyof typeof WEB_SOURCE_TO_SOURCE_ID;

export function resolveWebSource(source: string): string | null {
  return source in WEB_SOURCE_TO_SOURCE_ID
    ? WEB_SOURCE_TO_SOURCE_ID[source as WebSource]
    : null;
}

// Человекочитаемые лейблы сайтов для TITLE сделки и COMMENTS-префикса.
// veloce.team — основной сайт студии, MaxBot Pro — продуктовый сайт max-microsite.
export const WEB_SOURCE_TO_LABEL = {
  veloce_site: 'veloce.team',
  maxbot_pro: 'MaxBot Pro',
} as const;

export function resolveWebSourceLabel(source: string): string | null {
  return source in WEB_SOURCE_TO_LABEL
    ? WEB_SOURCE_TO_LABEL[source as WebSource]
    : null;
}
