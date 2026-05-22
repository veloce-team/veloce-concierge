import { z } from 'zod';

export function normalizePhone(input: string): string {
  const cleaned = input.replace(/[^\d+]/g, '');
  if (cleaned.startsWith('+')) return cleaned;
  if (cleaned.length === 11 && cleaned.startsWith('8')) return '+7' + cleaned.slice(1);
  if (cleaned.length === 11 && cleaned.startsWith('7')) return '+' + cleaned;
  if (cleaned.length === 10) return '+7' + cleaned;
  return cleaned;
}

export const LeadSchema = z.object({
  name: z.string().trim().min(2).max(50),
  email: z.string().trim().email().max(100),
  phone: z
    .string()
    .trim()
    .transform(normalizePhone)
    .refine((v) => /^\+\d{10,15}$/.test(v), {
      message: 'Телефон должен содержать 10–15 цифр в формате E.164 (+...)',
    }),
  message: z.string().trim().min(10).max(2000),
  source: z.enum(['veloce_site', 'maxbot_pro']),
  channel: z.enum(['form', 'telegram', 'mailto']),
  landing: z.enum(['home', 'uk', 'gos']).optional(),
  intent: z.enum(['kp', 'tz']).optional(),
  product: z.enum(['obrashcheniya', 'miniapp', 'zapis', '']).optional(),
  website: z.string().max(0).optional(),
});

export type Lead = z.infer<typeof LeadSchema>;
