// Registers/refreshes the Telegram webhook for the concierge bot.
// Reads PUBLIC_URL, TG_BOT_TOKEN, TG_WEBHOOK_SECRET from env (same as the app).
// Usage: npm run set-webhook

import { parseEnv } from '../src/config/env.js';
import { createTgAdapter } from '../src/adapters/tg/adapter.js';

async function main(): Promise<void> {
  const env = parseEnv();
  const url = `${env.PUBLIC_URL.replace(/\/$/, '')}/webhook/tg`;
  const tg = createTgAdapter(env.TG_BOT_TOKEN);
  await tg.setWebhook(url, env.TG_WEBHOOK_SECRET);
  // eslint-disable-next-line no-console
  console.log(`webhook set: ${url}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('set-webhook failed:', err);
  process.exit(1);
});
