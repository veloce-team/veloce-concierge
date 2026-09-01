import { z } from 'zod';

const CorsOrigins = z
  .string()
  .min(1)
  .transform((raw, ctx) => {
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed) || !parsed.every((v) => typeof v === 'string')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'CORS_ORIGINS must be a JSON array of strings',
        });
        return z.NEVER;
      }
      return parsed as string[];
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'CORS_ORIGINS must be valid JSON',
      });
      return z.NEVER;
    }
  });

const EnvSchema = z
  .object({
    BITRIX24_WEBHOOK_URL: z
      .string()
      .url('must be a full URL like https://{portal}.bitrix24.ru/rest/{user_id}/{key}/'),
    ASSIGNED_BY_ID: z.coerce.number().int().positive(),
    BITRIX24_PORTAL_ID: z.string().min(1).optional(),

    ANALYTICS_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    ANALYTICS_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(300_000),
    ANALYTICS_UPLOAD_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
    ANALYTICS_RECONCILE_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
    ANALYTICS_OUTBOX_ALERT_THRESHOLD: z.coerce.number().int().positive().default(100),
    YANDEX_METRIKA_COUNTER_ID: z.coerce.number().int().positive().optional(),
    YANDEX_OAUTH_TOKEN: z.string().min(1).optional(),

    CORS_ORIGINS: CorsOrigins,

    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(600_000),
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(5),

    DB_PATH: z.string().min(1).default('/data/web.sqlite'),

    IDEMPOTENCY_TTL_MS: z.coerce.number().int().positive().default(600_000),

    LEAD_NOTIFICATION_URL: z.string().url().optional(),
    LEAD_NOTIFICATION_SECRET: z.string().min(32).optional(),

    PORT: z.coerce.number().int().positive().default(3000),

    LOG_LEVEL: z
      .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
      .default('info'),
    NODE_ENV: z.enum(['development', 'production']).default('production'),
  })
  .refine(
    (v) =>
      (v.LEAD_NOTIFICATION_URL == null) === (v.LEAD_NOTIFICATION_SECRET == null),
    {
      message:
        'LEAD_NOTIFICATION_URL and LEAD_NOTIFICATION_SECRET must both be set or both be empty',
      path: ['LEAD_NOTIFICATION_URL'],
    },
  )
  .superRefine((value, ctx) => {
    if (!value.ANALYTICS_ENABLED) return;
    for (const [name, configured] of [
      ['BITRIX24_PORTAL_ID', value.BITRIX24_PORTAL_ID],
      ['YANDEX_METRIKA_COUNTER_ID', value.YANDEX_METRIKA_COUNTER_ID],
      ['YANDEX_OAUTH_TOKEN', value.YANDEX_OAUTH_TOKEN],
    ] as const) {
      if (configured == null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${name} is required when ANALYTICS_ENABLED=true`,
          path: [name],
        });
      }
    }
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
  // eslint-disable-next-line no-console
  console.error(message);
  process.exit(1);
}
