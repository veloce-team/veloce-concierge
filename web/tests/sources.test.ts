import { describe, it, expect } from 'vitest';
import { resolveWebSource } from '../src/config/sources.js';

describe('resolveWebSource', () => {
  it('maps veloce_site → VELOCE_SITE', () => {
    expect(resolveWebSource('veloce_site')).toBe('VELOCE_SITE');
  });

  it('returns null for unknown source', () => {
    expect(resolveWebSource('phon')).toBe(null);
    expect(resolveWebSource('')).toBe(null);
  });
});
