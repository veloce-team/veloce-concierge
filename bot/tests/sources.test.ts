import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SOURCE_ID,
  START_PARAM_TO_SOURCE_ID,
  resolveSourceId,
} from '../src/config/sources.js';

describe('resolveSourceId', () => {
  it('без параметра → DEFAULT_SOURCE_ID, known=true', () => {
    expect(resolveSourceId(undefined)).toEqual({
      sourceId: DEFAULT_SOURCE_ID,
      known: true,
    });
  });

  it('известные start_param → маппинг, known=true', () => {
    for (const key of Object.keys(START_PARAM_TO_SOURCE_ID)) {
      const out = resolveSourceId(key);
      expect(out.sourceId).toBe(START_PARAM_TO_SOURCE_ID[key]);
      expect(out.known).toBe(true);
    }
  });

  it('site — алиас veloce (тот же External ID)', () => {
    expect(resolveSourceId('site').sourceId).toBe(resolveSourceId('veloce').sourceId);
  });

  it('неизвестный start_param → DEFAULT_SOURCE_ID, known=false', () => {
    expect(resolveSourceId('whatever-unknown')).toEqual({
      sourceId: DEFAULT_SOURCE_ID,
      known: false,
    });
  });
});
