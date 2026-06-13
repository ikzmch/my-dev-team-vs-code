/**
 * Token-usage extraction for the protocol's usage events (the billing seam).
 * SDK-reported counts are preferred; when the underlying SDK exposes none, a
 * cheap length-based estimate stands in so statistics have no holes - flagged
 * `estimated` so analysis can separate measured from estimated. Either path is
 * best-effort by design: metering must never fail or slow down the run it is
 * measuring, so estimation only ever counts string lengths.
 */

/**
 * Token counts for one model call. Every field is optional: a side is omitted
 * when neither the SDK reported it nor an estimate covers it. The first two are
 * the headline counts; the rest are reported only when the SDK exposes them.
 */
export interface TokenCounts {
  inputTokens?: number;
  outputTokens?: number;
  /** Output tokens spent on hidden reasoning, when the model reports them. */
  reasoningTokens?: number;
  /** Input tokens served from a prompt cache, when the provider reports them. */
  cachedInputTokens?: number;
  /** The provider's own total, when given (not necessarily input + output). */
  totalTokens?: number;
  /** True when the counts are a length-based estimate, not SDK-reported. */
  estimated?: boolean;
}

/** What an agent reports per model call: the routed model plus the counts. */
export type AgentUsage = { model: string } & TokenCounts;

/** Receives one agent's usage report. Must not throw. */
export type UsageReporter = (usage: AgentUsage) => void;

function asCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

/**
 * Read token counts out of an SDK usage object, accepting both the current
 * AI SDK names (inputTokens/outputTokens/reasoningTokens/cachedInputTokens/
 * totalTokens) and the legacy ones (promptTokens/completionTokens). Only the
 * fields actually present are included; undefined when none are.
 */
export function extractTokenCounts(raw: unknown): TokenCounts | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const value = raw as Record<string, unknown>;
  const inputTokens = asCount(value.inputTokens) ?? asCount(value.promptTokens);
  const outputTokens =
    asCount(value.outputTokens) ?? asCount(value.completionTokens);
  const reasoningTokens = asCount(value.reasoningTokens);
  const cachedInputTokens =
    asCount(value.cachedInputTokens) ?? asCount(value.cachedPromptTokens);
  const totalTokens = asCount(value.totalTokens);
  const counts: TokenCounts = {};
  if (inputTokens !== undefined) counts.inputTokens = inputTokens;
  if (outputTokens !== undefined) counts.outputTokens = outputTokens;
  if (reasoningTokens !== undefined) counts.reasoningTokens = reasoningTokens;
  if (cachedInputTokens !== undefined) counts.cachedInputTokens = cachedInputTokens;
  if (totalTokens !== undefined) counts.totalTokens = totalTokens;
  return Object.keys(counts).length > 0 ? counts : undefined;
}

/**
 * Read token counts off a generate result or a (fully drained) stream output.
 * `usage` may be a plain object or a promise depending on the call shape, and
 * may be absent entirely; every failure mode degrades to undefined.
 */
export async function readUsage(output: unknown): Promise<TokenCounts | undefined> {
  if (typeof output !== 'object' || output === null) {
    return undefined;
  }
  const source = output as { usage?: unknown; totalUsage?: unknown };
  try {
    return (
      extractTokenCounts(await source.usage) ??
      extractTokenCounts(await source.totalUsage)
    );
  } catch {
    return undefined;
  }
}

/**
 * The common rule-of-thumb token estimate: about four characters per token.
 * Deliberately crude - it only fills in for a provider that reports nothing,
 * and the `estimated` flag keeps these counts out of any measured-only view.
 */
export function estimateTokens(text: string): number {
  return text.length === 0 ? 0 : Math.ceil(text.length / 4);
}

/** A length-based estimate for one call's prompt and reply, flagged estimated. */
export function estimateTokenCounts(promptText: string, replyText: string): TokenCounts {
  return {
    inputTokens: estimateTokens(promptText),
    outputTokens: estimateTokens(replyText),
    estimated: true,
  };
}

/**
 * The counts an agent reports for one call: the SDK's when it exposes any,
 * otherwise a length-based estimate over the prompt and reply, so every model
 * call contributes a usage record rather than silently leaving a gap.
 */
export async function resolveTokenCounts(
  output: unknown,
  promptText: string,
  replyText: string
): Promise<TokenCounts> {
  return (await readUsage(output)) ?? estimateTokenCounts(promptText, replyText);
}
