// Map web-form `source` payload values → Битрикс24 SOURCE_ID (STATUS_ID).
// Создан 16.05.2026: единственный канал на старте — veloce_site → VELOCE_SITE.
// В будущем сюда добавятся другие площадки (например, kwork-форма, тильда-форма).

export const WEB_SOURCE_TO_SOURCE_ID = {
  veloce_site: 'VELOCE_SITE',
} as const;

export type WebSource = keyof typeof WEB_SOURCE_TO_SOURCE_ID;

export function resolveWebSource(source: string): string | null {
  return source in WEB_SOURCE_TO_SOURCE_ID
    ? WEB_SOURCE_TO_SOURCE_ID[source as WebSource]
    : null;
}
