import { describe, it, expect } from 'vitest';
import { resolveWebSource, resolveWebSourceLabel } from '../src/config/sources.js';

describe('resolveWebSource', () => {
  it('maps veloce_site → VELOCE_SITE', () => {
    expect(resolveWebSource('veloce_site')).toBe('VELOCE_SITE');
  });

  it('maps maxbot_pro → MAXBOT_PRO', () => {
    expect(resolveWebSource('maxbot_pro')).toBe('MAXBOT_PRO');
  });

  it('returns null for unknown source', () => {
    expect(resolveWebSource('phon')).toBe(null);
    expect(resolveWebSource('')).toBe(null);
  });
});

describe('resolveWebSourceLabel', () => {
  it('maps veloce_site → veloce.team', () => {
    expect(resolveWebSourceLabel('veloce_site')).toBe('veloce.team');
  });

  it('maps maxbot_pro → MaxBot Pro', () => {
    expect(resolveWebSourceLabel('maxbot_pro')).toBe('MaxBot Pro');
  });

  it('returns null for unknown source', () => {
    expect(resolveWebSourceLabel('unknown')).toBe(null);
    expect(resolveWebSourceLabel('')).toBe(null);
  });
});
