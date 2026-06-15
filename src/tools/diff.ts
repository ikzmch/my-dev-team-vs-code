// A tiny line-level diff, just enough to count git-style additions and
// removals for the per-turn change summary. It computes a longest-common-
// subsequence of lines: every line of `before` not on the LCS is a removal,
// every line of `after` not on the LCS is an addition - the same counts
// `git diff --numstat` reports.

/** Added/removed line counts between two file revisions. */
export interface LineDelta {
  added: number;
  removed: number;
}

/**
 * Above this many cells the LCS table would cost too much for what is only a
 * summary line, so the (already prefix/suffix-trimmed) middle is treated as a
 * wholesale replacement: every remaining `before` line removed, every
 * remaining `after` line added. An over-count on a pathological full rewrite is
 * an acceptable trade for a bounded cost; ordinary edits never reach it.
 */
const MAX_LCS_CELLS = 4_000_000;

/** Split into lines for diffing, normalising CRLF so a line-ending-only change counts as nothing. */
function toLines(text: string): string[] {
  if (text === '') {
    return [];
  }
  return text.replace(/\r\n/g, '\n').split('\n');
}

/** Length of the longest common subsequence of two line arrays. */
function lcsLength(a: string[], b: string[]): number {
  // One rolling row instead of the full table: only the length is needed.
  let prev = new Array<number>(b.length + 1).fill(0);
  let curr = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

/**
 * Count added and removed lines between `before` and `after`. A brand-new file
 * (`before` empty) is all additions; a deletion to empty is all removals.
 */
export function lineDiff(before: string, after: string): LineDelta {
  const beforeLines = toLines(before);
  const afterLines = toLines(after);

  // Trim the shared head and tail first: typical edits change a small middle,
  // so this keeps the LCS table small (and makes an unchanged file free).
  let head = 0;
  while (
    head < beforeLines.length &&
    head < afterLines.length &&
    beforeLines[head] === afterLines[head]
  ) {
    head++;
  }
  let tail = 0;
  while (
    tail < beforeLines.length - head &&
    tail < afterLines.length - head &&
    beforeLines[beforeLines.length - 1 - tail] === afterLines[afterLines.length - 1 - tail]
  ) {
    tail++;
  }

  const beforeMid = beforeLines.slice(head, beforeLines.length - tail);
  const afterMid = afterLines.slice(head, afterLines.length - tail);
  if (beforeMid.length === 0 || afterMid.length === 0) {
    // One side of the changed region is empty: a pure insertion or deletion.
    return { added: afterMid.length, removed: beforeMid.length };
  }

  const common =
    beforeMid.length * afterMid.length > MAX_LCS_CELLS
      ? 0
      : lcsLength(beforeMid, afterMid);
  return { added: afterMid.length - common, removed: beforeMid.length - common };
}
