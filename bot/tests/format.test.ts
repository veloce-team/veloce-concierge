import { describe, it, expect } from 'vitest';
import { formatLeadMessage, type LeadPayload } from '../src/services/notifications/format.js';

const FULL: LeadPayload = {
  name: 'Иван',
  email: 'ivan@test.ru',
  phone: '+79991234567',
  message: 'Хочу обсудить проект',
  source: 'maxbot_pro',
  channel: 'form',
  landing: 'uk',
  intent: 'kp',
  product: 'obrashcheniya',
  contactId: 42,
  dealId: 99,
};

describe('formatLeadMessage', () => {
  it('renders all fields', () => {
    const html = formatLeadMessage(FULL);
    expect(html).toContain('<b>Новая заявка с maxbot-pro.ru</b>');
    expect(html).toContain('<b>Имя:</b> Иван');
    expect(html).toContain('<b>Телефон:</b> +79991234567');
    expect(html).toContain('<b>Email:</b> ivan@test.ru');
    expect(html).toContain('landing: uk');
    expect(html).toContain('intent: kp');
    expect(html).toContain('product: obrashcheniya');
    expect(html).toContain('Хочу обсудить проект');
    expect(html).toContain('/crm/deal/details/99/');
  });

  it('omits empty optional fields', () => {
    const minimal: LeadPayload = {
      name: 'Test',
      email: 't@t.ru',
      phone: '+70000000000',
      message: 'msg',
      source: 'veloce_site',
      channel: 'form',
    };
    const html = formatLeadMessage(minimal);
    expect(html).toContain('veloce.team');
    expect(html).not.toContain('landing');
    expect(html).not.toContain('intent');
    expect(html).not.toContain('product');
    expect(html).not.toContain('B24:');
  });

  it('escapes HTML special characters in user input', () => {
    const payload: LeadPayload = {
      ...FULL,
      name: '<script>alert(1)</script>',
      message: 'a & b < c > d',
    };
    const html = formatLeadMessage(payload);
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('a &amp; b &lt; c &gt; d');
    expect(html).not.toContain('<script>');
  });

  it('preserves newlines in message', () => {
    const payload: LeadPayload = { ...FULL, message: 'line1\nline2\nline3' };
    const html = formatLeadMessage(payload);
    expect(html).toContain('line1\nline2\nline3');
  });

  it('omits deal link when dealId is absent', () => {
    const payload: LeadPayload = { ...FULL, dealId: null };
    const html = formatLeadMessage(payload);
    expect(html).not.toContain('B24:');
  });

  it('maps veloce_site source correctly', () => {
    const payload: LeadPayload = { ...FULL, source: 'veloce_site' };
    const html = formatLeadMessage(payload);
    expect(html).toContain('veloce.team');
  });

  it('passes through unknown source as-is', () => {
    const payload: LeadPayload = { ...FULL, source: 'custom_src' };
    const html = formatLeadMessage(payload);
    expect(html).toContain('custom_src');
  });
});
