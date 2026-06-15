/**
 * Condensing a reasoning model's raw chain of thought down to the single line
 * worth surfacing.
 *
 * Reasoning models (deepseek-r1, qwen-thinking, …) stream a verbose `<think>`
 * monologue ahead of their answer. Showing all of it would be the noise the
 * user is trying to avoid; instead the UI shows only the latest line, replaced
 * as the buffer grows, so they see the current thought without the whole
 * transcript. The reasoning is never kept past the run - it is a live status
 * signal, like a spinner, not part of the reply (see the `thinking` event in
 * protocol/events.ts). This keeps the engine's "important pieces" cheap: no
 * extra model call, just the last non-empty line of what the routed model
 * already emitted.
 */

/**
 * The one line worth showing from a reasoning buffer so far: its last non-empty
 * line, trimmed and capped at `maxChars` (an over-long line gets an ellipsis).
 * Returns '' when the buffer holds nothing printable yet, so callers can skip
 * emitting an empty status.
 */
export function condenseThinking(buffer: string, maxChars: number): string {
  let latest = '';
  for (const line of buffer.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed) {
      latest = trimmed;
    }
  }
  return latest.length > maxChars ? latest.slice(0, maxChars) + '…' : latest;
}
