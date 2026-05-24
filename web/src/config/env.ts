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
  );

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
