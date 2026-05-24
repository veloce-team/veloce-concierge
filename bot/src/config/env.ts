import { z } from 'zod';

const EnvSchema = z.object({
  TG_BOT_TOKEN: z.string().min(1, 'must be a non-empty BotFather token'),
  TG_WEBHOOK_SECRET: z
    .string()
    .min(32, 'must be at least 32 characters for webhook signature validation'),

  BITRIX24_WEBHOOK_URL: z
    .string()
    .url('must be a full URL like https://{portal}.bitrix24.ru/rest/{user_id}/{key}/'),
  BITRIX24_DEAL_CATEGORY_ID: z.coerce.number().int().nonnegative().default(0),

  SQLITE_PATH: z.string().min(1).default('/data/concierge.sqlite'),

  LOG_LEVEL: z
    .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
    .default('info'),

  LEAD_NOTIFICATION_SECRET: z
    .string()
    .min(32, 'must be at least 32 characters for notify-lead Bearer auth'),
  OPERATOR_CHAT_ID: z
    .string()
    .regex(/^-?\d+$/, 'must be numeric chat_id, with optional leading -'),

  PUBLIC_URL: z.string().url('must be the public origin where webhook is reachable'),
  NODE_ENV: z.enum(['development', 'production']),
  PORT: z.coerce.number().int().positive().default(3000),
});

export type Env = z.infer<typeof EnvSchema>;

export function parseEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = EnvSchema.safeParse(source);
  if (result.success) return result.data;

  const lines = result.error.issues.map((issue) => {
    const name = issue.path.join('.') || '(root)';
    return `  - ${name}: ${issue.message}`;
  });
  const message =
    'Invalid environment configuration. Fix the following and restart:\n' +
    lines.join('\n');
  // No logger yet — print plainly, then exit.
  // eslint-disable-next-line no-console
  console.error(message);
  process.exit(1);
}
