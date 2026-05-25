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
  name: z
    .string()
    .trim()
    .min(2, 'Имя должно содержать минимум 2 символа')
    .max(50, 'Имя слишком длинное (максимум 50 символов)'),
  email: z
    .string()
    .trim()
    .email('Введите корректный email-адрес')
    .max(100, 'Email слишком длинный (максимум 100 символов)'),
  phone: z
    .string()
    .trim()
    .transform(normalizePhone)
    .refine((v) => /^\+\d{10,15}$/.test(v), {
      message: 'Телефон должен содержать 10–15 цифр в формате E.164 (+...)',
    }),
  message: z
    .string()
    .trim()
    .min(10, 'Опишите задачу подробнее — минимум 10 символов')
    .max(2000, 'Сообщение слишком длинное (максимум 2000 символов)'),
  source: z.enum(['veloce_site', 'maxbot_pro']),
  channel: z.enum(['form', 'telegram', 'mailto']),
  landing: z.enum(['home', 'uk', 'gos']).optional(),
  intent: z.enum(['kp', 'tz']).optional(),
  product: z.enum(['obrashcheniya', 'miniapp', 'zapis', '']).optional(),
  consent: z.literal('on', {
    errorMap: () => ({ message: 'Подтвердите согласие на обработку персональных данных' }),
  }),
  website: z.string().max(0).optional(),
});

export type Lead = z.infer<typeof LeadSchema>;
