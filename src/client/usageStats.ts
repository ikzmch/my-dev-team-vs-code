/**
 * Pure aggregation over the eval log's token usage - no I/O, so it is the same
 * function whether it runs over a single run's live usage (the in-chat line
 * and the status-bar session total) or over the whole stored log (the "Show
 * Token Usage" report). Keeping it free of vscode and the file system is what
 * makes it trivially unit-testable.
 */
import { EvalRecord, UsageEntry } from './evalLog';

/** Summed token counts plus how many model calls contributed them. */
export interface TokenSummary {
  inputTokens: number;
  outputTokens: number;
  /** inputTokens + outputTokens; the single number the surfaces headline. */
  totalTokens: number;
  /** Output tokens spent on hidden reasoning, summed across the calls. */
  reasoningTokens: number;
  /** Input tokens served from a prompt cache, summed across the calls. */
  cachedInputTokens: number;
  /** Model calls summed (one per usage entry). */
  calls: number;
  /** Of those calls, how many were length-based estimates rather than measured. */
  estimatedCalls: number;
  /** True when any contributing entry was a length-based estimate. */
  hasEstimates: boolean;
}

/** A zero summary, the identity the folds start from. */
export function emptySummary(): TokenSummary {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    reasoningTokens: 0,
    cachedInputTokens: 0,
    calls: 0,
    estimatedCalls: 0,
    hasEstimates: false,
  };
}

/** Fold one usage entry into a summary in place; returns the same summary. */
export function addEntry(into: TokenSummary, entry: UsageEntry): TokenSummary {
  into.inputTokens += entry.inputTokens ?? 0;
  into.outputTokens += entry.outputTokens ?? 0;
  into.reasoningTokens += entry.reasoningTokens ?? 0;
  into.cachedInputTokens += entry.cachedInputTokens ?? 0;
  into.totalTokens = into.inputTokens + into.outputTokens;
  into.calls += 1;
  if (entry.estimated) {
    into.estimatedCalls += 1;
    into.hasEstimates = true;
  }
  return into;
}

/** Sum a list of per-call usage entries (e.g. one run's steps) into a summary. */
export function sumUsage(entries: readonly UsageEntry[]): TokenSummary {
  return entries.reduce(addEntry, emptySummary());
}

/** Add the right summary into the left in place; returns the left. */
export function addSummary(into: TokenSummary, other: TokenSummary): TokenSummary {
  into.inputTokens += other.inputTokens;
  into.outputTokens += other.outputTokens;
  into.reasoningTokens += other.reasoningTokens;
  into.cachedInputTokens += other.cachedInputTokens;
  into.totalTokens = into.inputTokens + into.outputTokens;
  into.calls += other.calls;
  into.estimatedCalls += other.estimatedCalls;
  into.hasEstimates = into.hasEstimates || other.hasEstimates;
  return into;
}

/**
 * Share of an aggregate's input tokens that came from a prompt cache (0..1).
 * Scores the design's "lead with the stable prefix" bet: a near-zero rate over
 * a real workload means the prefix cache is not being reused. Zero when there
 * are no input tokens to hit a cache.
 */
export function cacheHitRate(summary: TokenSummary): number {
  return summary.inputTokens > 0
    ? summary.cachedInputTokens / summary.inputTokens
    : 0;
}

/**
 * Share of an aggregate's model calls whose counts were estimated, not measured
 * (0..1). A high value means the figures are soft and a real tokenizer would
 * be worth adding; near zero means the heuristic fallback rarely fires.
 */
export function estimatedShare(summary: TokenSummary): number {
  return summary.calls > 0 ? summary.estimatedCalls / summary.calls : 0;
}

/** One labelled bucket of a breakdown (by model, route, or day). */
export interface UsageBucket {
  key: string;
  usage: TokenSummary;
}

/**
 * Token usage of the runs that drew a 👍 or a 👎, paired by run id - the
 * "value per token" view: how much each kind of outcome cost. `runs` counts the
 * matched feedback clicks (a run with no usage in the log, or a click with no
 * run id, is skipped so the averages stay meaningful).
 */
export interface FeedbackUsage {
  helpful: { runs: number; usage: TokenSummary };
  unhelpful: { runs: number; usage: TokenSummary };
}

/** Estimated input tokens attributed to one prompt section, summed across runs. */
export interface InputSource {
  source: string;
  tokens: number;
}

/** Wall-clock time over the runs that recorded a duration. */
export interface SpeedStats {
  /** Runs whose record carried a duration. */
  runsTimed: number;
  /** Their summed wall-clock time, in milliseconds. */
  totalMs: number;
}

/**
 * Shadow-triage agreement: of the pinned (slash-command) runs that recorded
 * what triage would have decided, how often it matched the pinned route, and
 * the token cost of the runs where it did not (the misroute-cost view).
 */
export interface TriageShadowStats {
  runs: number;
  agreed: number;
  agreedTokens: number;
  disagreedTokens: number;
}

/**
 * Conversation context growth: across threads with more than one run, the
 * average input tokens of the first vs the last run - does the prompt balloon
 * as history accumulates? Only multi-run conversations count (growth needs two
 * points); runs with no conversation id are ignored.
 */
export interface ContextGrowth {
  conversations: number;
  firstInputAvg: number;
  lastInputAvg: number;
}

/** A whole-log rollup: the overall total plus the standard breakdowns. */
export interface UsageRollup {
  overall: TokenSummary;
  /** Finished runs counted (run records, not model calls). */
  runs: number;
  byModel: UsageBucket[];
  byStep: UsageBucket[];
  byRoute: UsageBucket[];
  byDay: UsageBucket[];
  /** Estimated input tokens by prompt section, sorted by tokens descending. */
  inputBySource: InputSource[];
  feedback: FeedbackUsage;
  speed: SpeedStats;
  triageShadow: TriageShadowStats;
  contextGrowth: ContextGrowth;
}

/** Turn a key->summary map into buckets sorted by total tokens, descending. */
function toBuckets(map: Map<string, TokenSummary>): UsageBucket[] {
  return [...map.entries()]
    .map(([key, usage]) => ({ key, usage }))
    .sort((a, b) => b.usage.totalTokens - a.usage.totalTokens);
}

function bucketFor(map: Map<string, TokenSummary>, key: string): TokenSummary {
  let summary = map.get(key);
  if (!summary) {
    summary = emptySummary();
    map.set(key, summary);
  }
  return summary;
}

/**
 * Roll up every run record's per-step usage into an overall total and three
 * breakdowns: by model, by triage route, and by calendar day (UTC). Feedback
 * records carry no usage and are ignored.
 */
export function rollupUsage(records: readonly EvalRecord[]): UsageRollup {
  const overall = emptySummary();
  const byModel = new Map<string, TokenSummary>();
  const byStep = new Map<string, TokenSummary>();
  const byRoute = new Map<string, TokenSummary>();
  const byDay = new Map<string, TokenSummary>();
  const inputBySource = new Map<string, number>();
  // One summary per run, so a later feedback click can be charged the tokens
  // its run actually spent (the value-per-token join below).
  const runUsage = new Map<string, TokenSummary>();
  const speed: SpeedStats = { runsTimed: 0, totalMs: 0 };
  const triageShadow: TriageShadowStats = {
    runs: 0,
    agreed: 0,
    agreedTokens: 0,
    disagreedTokens: 0,
  };
  // Per-conversation list of (ts, input tokens) for the context-growth fold.
  const byConversation = new Map<string, { ts: string; input: number }[]>();
  let runs = 0;
  for (const record of records) {
    if (record.record !== 'run') {
      continue;
    }
    runs += 1;
    const day = record.ts.slice(0, 10);
    const route = record.command || record.intent || 'unknown';
    const perRun = emptySummary();
    for (const entry of record.usage) {
      addEntry(overall, entry);
      addEntry(bucketFor(byModel, entry.model ?? 'unknown'), entry);
      addEntry(bucketFor(byStep, entry.step), entry);
      addEntry(bucketFor(byRoute, route), entry);
      addEntry(bucketFor(byDay, day), entry);
      addEntry(perRun, entry);
      for (const [source, tokens] of Object.entries(entry.inputBreakdown ?? {})) {
        if (typeof tokens === 'number') {
          inputBySource.set(source, (inputBySource.get(source) ?? 0) + tokens);
        }
      }
    }
    runUsage.set(record.runId, perRun);

    if (typeof record.durationMs === 'number') {
      speed.runsTimed += 1;
      speed.totalMs += record.durationMs;
    }
    // Shadow triage only on pinned (slash-command) runs that recorded a
    // prediction; `intent` holds the pinned route the prediction is scored
    // against.
    if (record.command && record.triagePredicted !== undefined) {
      triageShadow.runs += 1;
      if (record.triagePredicted === record.intent) {
        triageShadow.agreed += 1;
        triageShadow.agreedTokens += perRun.totalTokens;
      } else {
        triageShadow.disagreedTokens += perRun.totalTokens;
      }
    }
    if (record.conversationId) {
      const thread = byConversation.get(record.conversationId) ?? [];
      thread.push({ ts: record.ts, input: perRun.inputTokens });
      byConversation.set(record.conversationId, thread);
    }
  }

  let conversations = 0;
  let firstInputSum = 0;
  let lastInputSum = 0;
  for (const thread of byConversation.values()) {
    if (thread.length < 2) {
      continue;
    }
    const ordered = [...thread].sort((a, b) => a.ts.localeCompare(b.ts));
    conversations += 1;
    firstInputSum += ordered[0].input;
    lastInputSum += ordered[ordered.length - 1].input;
  }
  const contextGrowth: ContextGrowth = {
    conversations,
    firstInputAvg: conversations > 0 ? firstInputSum / conversations : 0,
    lastInputAvg: conversations > 0 ? lastInputSum / conversations : 0,
  };

  const feedback: FeedbackUsage = {
    helpful: { runs: 0, usage: emptySummary() },
    unhelpful: { runs: 0, usage: emptySummary() },
  };
  for (const record of records) {
    if (record.record !== 'feedback') {
      continue;
    }
    const usage = record.runId ? runUsage.get(record.runId) : undefined;
    if (!usage) {
      // A click on a run that left no usage in the log (or carried no run id)
      // cannot be charged any tokens, so it would only skew the average.
      continue;
    }
    const bucket = record.kind === 'helpful' ? feedback.helpful : feedback.unhelpful;
    bucket.runs += 1;
    addSummary(bucket.usage, usage);
  }

  return {
    overall,
    runs,
    byModel: toBuckets(byModel),
    byStep: toBuckets(byStep),
    byRoute: toBuckets(byRoute),
    byDay: toBuckets(byDay).sort((a, b) => a.key.localeCompare(b.key)),
    inputBySource: [...inputBySource.entries()]
      .map(([source, tokens]) => ({ source, tokens }))
      .sort((a, b) => b.tokens - a.tokens),
    feedback,
    speed,
    triageShadow,
    contextGrowth,
  };
}

/**
 * Compact token count for the surfaces: exact under 1 000, then one-decimal
 * "k"/"M" (e.g. 1234 -> "1.2k", 2000000 -> "2.0M"). Negative or non-finite
 * inputs render as "0".
 */
export function formatTokenCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) {
    return '0';
  }
  if (n < 1000) {
    return String(Math.round(n));
  }
  if (n < 1_000_000) {
    return `${(n / 1000).toFixed(1)}k`;
  }
  return `${(n / 1_000_000).toFixed(1)}M`;
}
