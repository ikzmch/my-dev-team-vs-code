import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { parseWithRepair, repairInstruction } from '../src/engine/core/repair';
import { settings } from '../src/config/settings';

const schema = z.object({ n: z.number() });

describe('repairInstruction', () => {
  it('names the failing field and asks for corrected JSON only', () => {
    const result = schema.safeParse({ n: 'not a number' });
    if (result.success) {
      throw new Error('expected the parse to fail');
    }
    const text = repairInstruction(result.error);
    expect(text).toContain('failed validation');
    expect(text).toContain('n');
    expect(text).toContain('corrected JSON');
  });
});

describe('parseWithRepair', () => {
  it('returns the first valid output without retrying', async () => {
    let calls = 0;
    const value = await parseWithRepair(schema, async () => {
      calls++;
      return { n: 1 };
    });
    expect(value).toEqual({ n: 1 });
    expect(calls).toBe(1);
  });

  it('retries with the validation error appended, then succeeds', async () => {
    const seen: Array<string | undefined> = [];
    const value = await parseWithRepair(schema, async (repair) => {
      seen.push(repair);
      return seen.length === 1 ? { n: 'bad' } : { n: 2 };
    });
    expect(value).toEqual({ n: 2 });
    // The first attempt gets no repair instruction; the retry gets the error.
    expect(seen[0]).toBeUndefined();
    expect(seen[1]).toContain('failed validation');
  });

  it('throws the zod error after the attempts are exhausted', async () => {
    let calls = 0;
    await expect(
      parseWithRepair(schema, async () => {
        calls++;
        return { n: 'bad' };
      })
    ).rejects.toBeInstanceOf(z.ZodError);
    // One initial attempt plus the configured number of repairs.
    expect(calls).toBe(1 + settings.structuredOutput.repairAttempts);
  });

  it('does not retry when repair is disabled (repairAttempts = 0)', async () => {
    const original = settings.structuredOutput.repairAttempts;
    settings.structuredOutput.repairAttempts = 0;
    try {
      let calls = 0;
      await expect(
        parseWithRepair(schema, async () => {
          calls++;
          return { n: 'bad' };
        })
      ).rejects.toThrow();
      expect(calls).toBe(1);
    } finally {
      settings.structuredOutput.repairAttempts = original;
    }
  });
});
