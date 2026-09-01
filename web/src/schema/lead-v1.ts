import { z } from 'zod';
import { normalizePhone } from './lead.js';

const identifier = (max: number) =>
  z
    .string()
    .trim()
    .toLowerCase()
    .max(max)
    .regex(/^[a-z0-9]+(?:_[a-z0-9]+)*$/);

const nullableIdentifier = (max: number) => identifier(max).nullable();
const webUrl = z
  .string()
  .trim()
  .url()
  .max(2048)
  .refine((value) => {
    const parsed = new URL(value);
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      parsed.username === '' &&
      parsed.password === ''
    );
  }, 'URL must use HTTP(S) without credentials');
const sanitizedUrl = webUrl
  .transform((value) => {
    const parsed = new URL(value);
    return `${parsed.origin}${parsed.pathname}`;
  });
const nullableReferrer = sanitizedUrl.nullable();
const nullableLandingUrl = webUrl
  .refine((value) => {
    const host = new URL(value).hostname.toLowerCase();
    return host === 'veloce.team' || host === 'www.veloce.team';
  }, 'landing_url must point to veloce.team')
  .transform((value) => {
    const parsed = new URL(value);
    return `${parsed.origin}${parsed.pathname}`;
  })
  .nullable();
const path = z.string().trim().min(1).max(512).startsWith('/');
const timestamp = z.string().datetime({ offset: true });

const TouchSchema = z
  .object({
    utm_source: nullableIdentifier(64),
    utm_medium: nullableIdentifier(64),
    utm_campaign: nullableIdentifier(128),
    utm_content: nullableIdentifier(128),
    utm_term: nullableIdentifier(128),
    yclid: z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/).nullable(),
    landing_url: nullableLandingUrl,
    landing_path: path.nullable(),
    referrer: nullableReferrer,
    captured_at: timestamp,
  })
  .strict();

const ContextSchema = z
  .object({
    placement: z.enum(['header', 'fab', 'footer', 'demo', 'thanks', 'form', 'content']),
    form_id: identifier(64).nullable().optional(),
    page_type: identifier(64),
    page_path: path,
    service: identifier(64).nullable().optional(),
  })
  .strict();

const AttributionSchema = z
  .object({
    schema_version: z.literal(1),
    first_touch: TouchSchema,
    last_touch: TouchSchema,
    ym_client_id: z.string().regex(/^\d{6,32}$/).nullable(),
  })
  .strict();

const ConsentProofSchema = z
  .object({
    version: identifier(64),
    accepted_at: timestamp,
  })
  .strict();

export const LeadV1Schema = z
  .object({
    name: z.string().trim().min(2).max(50),
    email: z.string().trim().toLowerCase().email().max(100),
    phone: z
      .string()
      .trim()
      .transform(normalizePhone)
      .refine((value) => /^\+\d{10,15}$/.test(value), 'Введите корректный номер телефона'),
    message: z.string().trim().min(10).max(2000),
    source: z.literal('veloce_site'),
    channel: z.enum(['form', 'telegram', 'max', 'whatsapp', 'phone', 'email']),
    consent: z.literal('on'),
    website: z.literal(''),
    lead_event_id: z.string().uuid(),
    context: ContextSchema,
    attribution: AttributionSchema,
    consent_proof: ConsentProofSchema,
  })
  .strict()
  .refine((lead) => lead.lead_event_id[14] === '4', {
    path: ['lead_event_id'],
    message: 'lead_event_id must be a UUID v4',
  });

export type LeadV1 = z.infer<typeof LeadV1Schema>;
