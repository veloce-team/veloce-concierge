import { describe, expect, it } from 'vitest';
import { LeadV1Schema } from '../src/schema/lead-v1.js';

export const validV1Body = {
  name: ' Иван ',
  phone: '8 (999) 123-45-67',
  email: 'IVAN@EXAMPLE.TEST',
  message: ' Нужен аудит CRM и процессов продаж ',
  source: 'veloce_site',
  channel: 'form',
  consent: 'on',
  website: '',
  lead_event_id: '550e8400-e29b-41d4-a716-446655440000',
  context: {
    placement: 'form',
    form_id: 'zayavka',
    page_type: 'solution',
    page_path: '/resheniya/audit/',
    service: 'audit',
  },
  attribution: {
    schema_version: 1,
    first_touch: {
      utm_source: 'youtube',
      utm_medium: 'organic_video',
      utm_campaign: 'vm_2026_w36_crm_losses',
      utm_content: 'yt_video_main',
      utm_term: null,
      yclid: null,
      landing_url: 'https://veloce.team/resheniya/audit/?utm_source=youtube',
      landing_path: '/resheniya/audit/',
      referrer: 'https://www.youtube.com/',
      captured_at: '2026-08-31T12:00:00Z',
    },
    last_touch: {
      utm_source: 'yandex',
      utm_medium: 'cpc',
      utm_campaign: 'yd_2026_crm_audit_krasnoyarsk',
      utm_content: 'yd_ad_03',
      utm_term: 'crm_audit',
      yclid: 'example-not-real',
      landing_url: 'https://veloce.team/resheniya/audit/?utm_source=yandex',
      landing_path: '/resheniya/audit/',
      referrer: 'https://yandex.ru/',
      captured_at: '2026-08-31T12:20:00Z',
    },
    ym_client_id: '123456789012345678',
  },
  consent_proof: {
    version: 'pending_legal_version',
    accepted_at: '2026-08-31T12:21:00Z',
  },
} as const;

describe('LeadV1Schema', () => {
  it('accepts and normalizes the Analytics Contract v1 payload', () => {
    const parsed = LeadV1Schema.parse(validV1Body);

    expect(parsed.name).toBe('Иван');
    expect(parsed.phone).toBe('+79991234567');
    expect(parsed.email).toBe('ivan@example.test');
    expect(parsed.message).toBe('Нужен аудит CRM и процессов продаж');
    expect(parsed.attribution.last_touch.utm_campaign).toBe('yd_2026_crm_audit_krasnoyarsk');
  });

  it('rejects unknown keys at every object level', () => {
    expect(LeadV1Schema.safeParse({ ...validV1Body, extra: true }).success).toBe(false);
    expect(
      LeadV1Schema.safeParse({
        ...validV1Body,
        context: { ...validV1Body.context, extra: true },
      }).success,
    ).toBe(false);
    expect(
      LeadV1Schema.safeParse({
        ...validV1Body,
        attribution: { ...validV1Body.attribution, extra: true },
      }).success,
    ).toBe(false);
  });

  it('rejects non-v4 event IDs and non-contract schema versions', () => {
    expect(LeadV1Schema.safeParse({ ...validV1Body, lead_event_id: 'not-a-uuid' }).success).toBe(false);
    expect(
      LeadV1Schema.safeParse({
        ...validV1Body,
        attribution: { ...validV1Body.attribution, schema_version: 2 },
      }).success,
    ).toBe(false);
  });

  it('rejects malformed or overlong attribution identifiers', () => {
    const invalidValues = ['Has Spaces', 'кириллица', 'double__underscore', 'x'.repeat(129)];
    for (const utm_campaign of invalidValues) {
      expect(
        LeadV1Schema.safeParse({
          ...validV1Body,
          attribution: {
            ...validV1Body.attribution,
            last_touch: { ...validV1Body.attribution.last_touch, utm_campaign },
          },
        }).success,
      ).toBe(false);
    }
  });

  it('rejects invalid context, consent proof, and click identifiers', () => {
    expect(
      LeadV1Schema.safeParse({
        ...validV1Body,
        context: { ...validV1Body.context, placement: 'sidebar' },
      }).success,
    ).toBe(false);
    expect(
      LeadV1Schema.safeParse({
        ...validV1Body,
        consent_proof: { ...validV1Body.consent_proof, accepted_at: 'yesterday' },
      }).success,
    ).toBe(false);
    expect(
      LeadV1Schema.safeParse({
        ...validV1Body,
        attribution: { ...validV1Body.attribution, ym_client_id: 'client@example.test' },
      }).success,
    ).toBe(false);
  });

  it('removes query strings and fragments from stored URLs to avoid PII leakage', () => {
    const parsed = LeadV1Schema.parse({
      ...validV1Body,
      attribution: {
        ...validV1Body.attribution,
        first_touch: {
          ...validV1Body.attribution.first_touch,
          landing_url:
            'https://veloce.team/resheniya/audit/?utm_source=youtube&email=person@example.test#form',
          referrer: 'https://www.youtube.com/watch?v=secret&utm_source=tracking#comments',
        },
      },
    });

    expect(parsed.attribution.first_touch.landing_url).toBe(
      'https://veloce.team/resheniya/audit/',
    );
    expect(parsed.attribution.first_touch.referrer).toBe('https://www.youtube.com/watch');
  });

  it('rejects non-Veloce landing hosts and unsafe click IDs', () => {
    expect(
      LeadV1Schema.safeParse({
        ...validV1Body,
        attribution: {
          ...validV1Body.attribution,
          first_touch: {
            ...validV1Body.attribution.first_touch,
            landing_url: 'https://evil.example/collect',
          },
        },
      }).success,
    ).toBe(false);
    expect(
      LeadV1Schema.safeParse({
        ...validV1Body,
        attribution: {
          ...validV1Body.attribution,
          last_touch: { ...validV1Body.attribution.last_touch, yclid: 'bad&id=value' },
        },
      }).success,
    ).toBe(false);
  });

  it('rejects non-web URL schemes and credential-bearing URLs', () => {
    for (const referrer of [
      'ftp://example.test/path',
      'file:///tmp/source',
      'https://user:password@example.test/path',
    ]) {
      expect(
        LeadV1Schema.safeParse({
          ...validV1Body,
          attribution: {
            ...validV1Body.attribution,
            first_touch: { ...validV1Body.attribution.first_touch, referrer },
          },
        }).success,
      ).toBe(false);
    }

    for (const landing_url of [
      'ftp://veloce.team/resheniya/audit/',
      'https://user:password@veloce.team/resheniya/audit/',
    ]) {
      expect(
        LeadV1Schema.safeParse({
          ...validV1Body,
          attribution: {
            ...validV1Body.attribution,
            first_touch: { ...validV1Body.attribution.first_touch, landing_url },
          },
        }).success,
      ).toBe(false);
    }
  });
});
