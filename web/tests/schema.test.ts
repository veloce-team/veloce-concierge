import { describe, it, expect } from 'vitest';
import { LeadSchema, normalizePhone } from '../src/schema/lead.js';

const valid = {
  name: 'Иван Петров',
  email: 'ivan@example.com',
  phone: '+79991234567',
  message: 'Хочу обсудить проект — лендинг + бот.',
  source: 'veloce_site',
  channel: 'form',
  consent: 'on',
};

describe('LeadSchema', () => {
  it('accepts valid payload', () => {
    expect(LeadSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects short name', () => {
    const r = LeadSchema.safeParse({ ...valid, name: 'A' });
    expect(r.success).toBe(false);
  });

  it('rejects long name', () => {
    const r = LeadSchema.safeParse({ ...valid, name: 'A'.repeat(51) });
    expect(r.success).toBe(false);
  });

  it('rejects invalid email', () => {
    const r = LeadSchema.safeParse({ ...valid, email: 'not-an-email' });
    expect(r.success).toBe(false);
  });

  it('rejects too-short phone', () => {
    const r = LeadSchema.safeParse({ ...valid, phone: '123' });
    expect(r.success).toBe(false);
  });

  it('rejects short message', () => {
    const r = LeadSchema.safeParse({ ...valid, message: 'short' });
    expect(r.success).toBe(false);
  });

  it('rejects unknown source', () => {
    const r = LeadSchema.safeParse({ ...valid, source: 'tinder' });
    expect(r.success).toBe(false);
  });

  it('rejects unknown channel', () => {
    const r = LeadSchema.safeParse({ ...valid, channel: 'fax' });
    expect(r.success).toBe(false);
  });

  it('allows honeypot empty/optional', () => {
    expect(LeadSchema.safeParse({ ...valid, website: '' }).success).toBe(true);
    expect(LeadSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts maxbot_pro source without optional context fields', () => {
    const r = LeadSchema.safeParse({ ...valid, source: 'maxbot_pro' });
    expect(r.success).toBe(true);
  });

  it('accepts maxbot_pro with landing/intent/product', () => {
    const r = LeadSchema.safeParse({
      ...valid,
      source: 'maxbot_pro',
      landing: 'gos',
      intent: 'kp',
      product: 'obrashcheniya',
    });
    expect(r.success).toBe(true);
  });

  it('accepts empty-string product (CTA не из карточки витрины)', () => {
    const r = LeadSchema.safeParse({
      ...valid,
      source: 'maxbot_pro',
      landing: 'gos',
      intent: 'kp',
      product: '',
    });
    expect(r.success).toBe(true);
  });

  it('rejects unknown landing', () => {
    const r = LeadSchema.safeParse({ ...valid, source: 'maxbot_pro', landing: 'other' });
    expect(r.success).toBe(false);
  });

  it('rejects unknown intent', () => {
    const r = LeadSchema.safeParse({ ...valid, source: 'maxbot_pro', intent: 'rfq' });
    expect(r.success).toBe(false);
  });

  it('rejects whitespace product (not in enum)', () => {
    const r = LeadSchema.safeParse({ ...valid, source: 'maxbot_pro', product: ' ' });
    expect(r.success).toBe(false);
  });
});

describe('LeadSchema consent field', () => {
  it('принимает consent: "on"', () => {
    expect(LeadSchema.safeParse(valid).success).toBe(true);
  });

  it('отвергает payload без consent', () => {
    const { consent, ...withoutConsent } = valid;
    expect(LeadSchema.safeParse(withoutConsent).success).toBe(false);
  });

  it('отвергает consent: false', () => {
    expect(LeadSchema.safeParse({ ...valid, consent: false }).success).toBe(false);
  });

  it('отвергает consent: "off"', () => {
    expect(LeadSchema.safeParse({ ...valid, consent: 'off' }).success).toBe(false);
  });

  it('отвергает consent: true (boolean)', () => {
    expect(LeadSchema.safeParse({ ...valid, consent: true }).success).toBe(false);
  });
});

describe('normalizePhone', () => {
  const expected = '+79991234567';

  it('normalizes 8-prefix', () => {
    expect(normalizePhone('89991234567')).toBe(expected);
  });

  it('normalizes 7-prefix without plus', () => {
    expect(normalizePhone('79991234567')).toBe(expected);
  });

  it('keeps +7 as-is', () => {
    expect(normalizePhone('+79991234567')).toBe(expected);
  });

  it('strips spaces and dashes', () => {
    expect(normalizePhone('+7 (999) 123-45-67')).toBe(expected);
  });

  it('schema produces same normalized phone for all variants', () => {
    const variants = ['89991234567', '79991234567', '+79991234567', '+7 999 123 45 67'];
    const results = variants.map((p) => {
      const r = LeadSchema.safeParse({ ...valid, phone: p });
      expect(r.success).toBe(true);
      return r.success ? r.data.phone : null;
    });
    expect(new Set(results).size).toBe(1);
  });
});
