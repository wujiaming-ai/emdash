import { describe, expect, it } from 'vitest';
import { sessionUsageSchema } from './config';

describe('session usage wire compatibility', () => {
  it.each(['resolved', 'estimated', 'unknown'] as const)(
    'preserves %s provenance across serialization',
    (contextWindowSource) => {
      const usage = {
        contextUsed: 745000,
        contextSize: contextWindowSource === 'unknown' ? 0 : 1000000,
        contextWindowSource,
        cost: null,
      };
      expect(sessionUsageSchema.parse(JSON.parse(JSON.stringify(usage)))).toEqual(usage);
    }
  );

  it('accepts legacy persisted usage without adding an authoritative source', () => {
    const legacy = { contextUsed: 745000, contextSize: 200000, cost: null };
    expect(sessionUsageSchema.parse(legacy)).toEqual(legacy);
  });
});
