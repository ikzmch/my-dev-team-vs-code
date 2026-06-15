import { describe, it, expect } from 'vitest';
import { lineDiff } from '../src/tools/diff';

describe('lineDiff', () => {
  it('counts a brand-new file as all additions', () => {
    expect(lineDiff('', 'a\nb\nc')).toEqual({ added: 3, removed: 0 });
  });

  it('counts a deletion to empty as all removals', () => {
    expect(lineDiff('a\nb', '')).toEqual({ added: 0, removed: 2 });
  });

  it('reports nothing for an identical file', () => {
    expect(lineDiff('a\nb\nc', 'a\nb\nc')).toEqual({ added: 0, removed: 0 });
  });

  it('counts a one-line modification as one added and one removed', () => {
    expect(lineDiff('a\nb\nc', 'a\nB\nc')).toEqual({ added: 1, removed: 0 + 1 });
  });

  it('counts a pure insertion in the middle', () => {
    expect(lineDiff('a\nc', 'a\nb\nc')).toEqual({ added: 1, removed: 0 });
  });

  it('counts a pure deletion in the middle', () => {
    expect(lineDiff('a\nb\nc', 'a\nc')).toEqual({ added: 0, removed: 1 });
  });

  it('counts a replaced block on both sides', () => {
    expect(lineDiff('a\nb\nc\nd', 'a\nX\nY\nd')).toEqual({ added: 2, removed: 2 });
  });

  it('ignores a line-ending-only change (CRLF vs LF)', () => {
    expect(lineDiff('a\nb', 'a\r\nb')).toEqual({ added: 0, removed: 0 });
  });
});
