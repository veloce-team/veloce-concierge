export type LeadPayload = {
  name: string;
  email: string;
  phone: string;
  message: string;
  source: string;
  channel: string;
  landing?: string | null;
  intent?: string | null;
  product?: string | null;
  contactId?: number | null;
  dealId?: number | null;
  sourceId?: string | null;
};

const SOURCE_DISPLAY: Record<string, string> = {
  maxbot_pro: 'maxbot-pro.ru',
  veloce_site: 'veloce.team',
};

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function formatLeadMessage(p: LeadPayload): string {
  const sourceDisplay = SOURCE_DISPLAY[p.source] ?? p.source;
  const lines: string[] = [
    `🔥 <b>Новая заявка с ${esc(sourceDisplay)}</b>`,
    '',
    `<b>Имя:</b> ${esc(p.name)}`,
    `<b>Телефон:</b> ${esc(p.phone)}`,
    `<b>Email:</b> ${esc(p.email)}`,
  ];

  const meta: string[] = [`канал: ${esc(p.channel)}`];
  if (p.landing) meta.push(`landing: ${esc(p.landing)}`);
  if (p.intent) meta.push(`intent: ${esc(p.intent)}`);
  if (p.product) meta.push(`product: ${esc(p.product)}`);
  lines.push(`<b>Доп.:</b> ${meta.join(', ')}`);

  lines.push('', `<b>Сообщение:</b>\n${esc(p.message)}`);

  if (p.dealId) {
    lines.push(
      '',
      `📊 B24: https://veloce.bitrix24.ru/crm/deal/details/${p.dealId}/`,
    );
  }

  return lines.join('\n');
}
