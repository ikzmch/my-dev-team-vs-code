import { describe, it, expect } from 'vitest';
import { condenseThinking } from '../src/engine/core/thinking';

describe('condenseThinking', () => {
  it('returns the last non-empty line, trimmed', () => {
    expect(condenseThinking('first thought\nsecond thought', 200)).toBe('second thought');
    expect(condenseThinking('  padded  ', 200)).toBe('padded');
  });

  it('skips trailing blank lines so a growing buffer shows the current line', () => {
    expect(condenseThinking('reasoning here\n\n', 200)).toBe('reasoning here');
    expect(condenseThinking('a\n\nb\n', 200)).toBe('b');
  });

  it('handles CRLF line endings', () => {
    expect(condenseThinking('one\r\ntwo', 200)).toBe('two');
  });

  it('returns an empty string when nothing is printable yet', () => {
    expect(condenseThinking('', 200)).toBe('');
    expect(condenseThinking('   \n\n  ', 200)).toBe('');
  });

  it('caps an over-long line with an ellipsis', () => {
    expect(condenseThinking('x'.repeat(10), 4)).toBe('xxxx…');
    expect(condenseThinking('exact', 5)).toBe('exact');
  });
});
