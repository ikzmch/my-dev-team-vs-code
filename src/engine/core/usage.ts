/**
 * Token-usage extraction for the protocol's usage events (the billing seam).
 * Emission is best-effort by design: counts are reported when the underlying
 * SDK exposes them on a result or stream and silently omitted when it does
 * not - metering must never fail or slow down the run it is measuring.
 */

/** Token counts for one model call; either side may be missing. */
export interface TokenCounts {
  inputTokens?: number;
  outputTokens?: number;
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
 * AI SDK names (inputTokens/outputTokens) and the legacy ones
 * (promptTokens/completionTokens). Undefined when neither side is present.
 */
export function extractTokenCounts(raw: unknown): TokenCounts | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const value = raw as Record<string, unknown>;
  const inputTokens = asCount(value.inputTokens) ?? asCount(value.promptTokens);
  const outputTokens =
    asCount(value.outputTokens) ?? asCount(value.completionTokens);
  if (inputTokens === undefined && outputTokens === undefined) {
    return undefined;
  }
  return { inputTokens, outputTokens };
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
