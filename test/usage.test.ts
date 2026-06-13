import { describe, it, expect } from 'vitest';
import {
  estimateTokenCounts,
  estimateTokens,
  extractTokenCounts,
  readUsage,
  resolveTokenCounts,
} from '../src/engine/core/usage';

describe('extractTokenCounts', () => {
  it('reads the current AI SDK token names', () => {
    expect(extractTokenCounts({ inputTokens: 10, outputTokens: 4 })).toEqual({
      inputTokens: 10,
      outputTokens: 4,
    });
  });

  it('accepts the legacy prompt/completion names', () => {
    expect(extractTokenCounts({ promptTokens: 3, completionTokens: 5 })).toEqual({
      inputTokens: 3,
      outputTokens: 5,
    });
  });

  it('includes reasoning, cached-input, and total when present', () => {
    expect(
      extractTokenCounts({
        inputTokens: 100,
        outputTokens: 20,
        reasoningTokens: 8,
        cachedInputTokens: 64,
        totalTokens: 128,
      })
    ).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      reasoningTokens: 8,
      cachedInputTokens: 64,
      totalTokens: 128,
    });
  });

  it('omits fields that are absent rather than emitting undefined keys', () => {
    expect(extractTokenCounts({ inputTokens: 9 })).toEqual({ inputTokens: 9 });
  });

  it('ignores non-numeric and negative values', () => {
    expect(
      extractTokenCounts({ inputTokens: -1, outputTokens: 'x', reasoningTokens: NaN })
    ).toBeUndefined();
  });

  it('returns undefined for non-objects and empty usage', () => {
    expect(extractTokenCounts(null)).toBeUndefined();
    expect(extractTokenCounts('nope')).toBeUndefined();
    expect(extractTokenCounts({})).toBeUndefined();
  });
});

describe('readUsage', () => {
  it('awaits a promised usage object', async () => {
    expect(await readUsage({ usage: Promise.resolve({ inputTokens: 5 }) })).toEqual({
      inputTokens: 5,
    });
  });

  it('falls back to totalUsage when usage is empty', async () => {
    expect(await readUsage({ usage: {}, totalUsage: { outputTokens: 7 } })).toEqual({
      outputTokens: 7,
    });
  });

  it('degrades a rejecting usage promise to undefined', async () => {
    expect(await readUsage({ usage: Promise.reject(new Error('x')) })).toBeUndefined();
  });
});

describe('estimateTokens', () => {
  it('is zero for empty text and ~chars/4 otherwise', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });
});

describe('estimateTokenCounts', () => {
  it('flags the counts as estimated', () => {
    const counts = estimateTokenCounts('abcd', 'abcdefgh');
    expect(counts).toEqual({ inputTokens: 1, outputTokens: 2, estimated: true });
  });
});

describe('resolveTokenCounts', () => {
  it('prefers SDK-reported counts and does not flag them estimated', async () => {
    const counts = await resolveTokenCounts(
      { usage: { inputTokens: 11, outputTokens: 7 } },
      'a long prompt that would estimate differently',
      'a reply'
    );
    expect(counts).toEqual({ inputTokens: 11, outputTokens: 7 });
    expect(counts.estimated).toBeUndefined();
  });

  it('estimates from the prompt and reply when the SDK reports nothing', async () => {
    const counts = await resolveTokenCounts({}, 'abcd', 'abcdefgh');
    expect(counts).toEqual({ inputTokens: 1, outputTokens: 2, estimated: true });
  });
});
