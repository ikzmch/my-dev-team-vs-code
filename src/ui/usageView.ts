/**
 * The "Show Token Usage" command: roll the stored eval log up into a markdown
 * report (overall total, then breakdowns by model, route, and day) and open it
 * in an editor. The report reads the eval log, so it is only populated when
 * `myDevTeam.telemetry.evalLog` is on; with no recorded runs it shows a short
 * note pointing at that setting. Rendering is a pure function of the rollup,
 * separate from the command, so it is unit-testable without vscode.
 */
import * as vscode from 'vscode';
import { EvalLog } from '../client/evalLog';
import {
  FeedbackUsage,
  InputSource,
  TokenSummary,
  UsageBucket,
  UsageRollup,
  cacheHitRate,
  estimatedShare,
  formatTokenCount,
  rollupUsage,
} from '../client/usageStats';
import { messages } from '../config/messages';

/** Command id the status-bar counter and the palette use to open the report. */
export const SHOW_USAGE_COMMAND_ID = 'myDevTeam.showUsage';

/** One line summing a TokenSummary, noting when it includes estimates. */
function summaryLine(summary: TokenSummary): string {
  const estimate = summary.hasEstimates ? ' _(includes estimates)_' : '';
  return (
    `**${formatTokenCount(summary.totalTokens)}** tokens ` +
    `(${formatTokenCount(summary.inputTokens)} in / ` +
    `${formatTokenCount(summary.outputTokens)} out) across ` +
    `${summary.calls} model call${summary.calls === 1 ? '' : 's'}${estimate}.`
  );
}

/** A markdown table for one breakdown; empty string when there are no buckets. */
function bucketTable(heading: string, label: string, buckets: UsageBucket[]): string {
  if (buckets.length === 0) {
    return '';
  }
  const rows = buckets
    .map(
      (b) =>
        `| ${b.key} | ${formatTokenCount(b.usage.totalTokens)} | ` +
        `${formatTokenCount(b.usage.inputTokens)} | ` +
        `${formatTokenCount(b.usage.outputTokens)} | ${b.usage.calls} |`
    )
    .join('\n');
  return (
    `\n## ${heading}\n\n` +
    `| ${label} | Total | In | Out | Calls |\n` +
    '| --- | ---: | ---: | ---: | ---: |\n' +
    `${rows}\n`
  );
}

/** Input-to-output token ratio as "N.N : 1"; degrades when one side is empty. */
function ratioLabel(input: number, output: number): string {
  if (output <= 0) {
    return input > 0 ? 'all input' : 'n/a';
  }
  return `${(input / output).toFixed(1)} : 1`;
}

/** A 0..1 fraction as a whole-percent label. */
function percentLabel(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

/** One side of the value-per-token line: total and average tokens per run. */
function feedbackSide(emoji: string, side: FeedbackUsage['helpful']): string {
  if (side.runs === 0) {
    return `${emoji} no rated runs`;
  }
  const average = side.usage.totalTokens / side.runs;
  return (
    `${emoji} ${formatTokenCount(side.usage.totalTokens)} over ${side.runs} ` +
    `run${side.runs === 1 ? '' : 's'} (avg ${formatTokenCount(average)})`
  );
}

/**
 * The bullet list scoring the things the design cares about: prompt weight
 * (input/output ratio), prefix-cache reuse, how soft the figures are
 * (estimated share), reasoning overhead when any, and value per token (tokens
 * behind 👍 vs 👎).
 */
function highlights(rollup: UsageRollup): string {
  const o = rollup.overall;
  const lines = [
    `- **Input / output:** ${formatTokenCount(o.inputTokens)} in / ` +
      `${formatTokenCount(o.outputTokens)} out (${ratioLabel(o.inputTokens, o.outputTokens)})`,
    `- **Prompt cache hits:** ${formatTokenCount(o.cachedInputTokens)} of ` +
      `${formatTokenCount(o.inputTokens)} input tokens (${percentLabel(cacheHitRate(o))})`,
    `- **Estimated counts:** ${o.estimatedCalls} of ${o.calls} ` +
      `call${o.calls === 1 ? '' : 's'} (${percentLabel(estimatedShare(o))}); ` +
      'figures marked `~` are approximate',
    `- **Value per token:** ${feedbackSide('👍', rollup.feedback.helpful)}; ` +
      `${feedbackSide('👎', rollup.feedback.unhelpful)}`,
  ];
  if (o.reasoningTokens > 0) {
    lines.splice(
      2,
      0,
      `- **Reasoning tokens:** ${formatTokenCount(o.reasoningTokens)} of ` +
        `${formatTokenCount(o.outputTokens)} output (${percentLabel(
          o.outputTokens > 0 ? o.reasoningTokens / o.outputTokens : 0
        )})`
    );
  }
  return `\n## Highlights\n\n${lines.join('\n')}\n`;
}

/** Human labels for the prompt-section sources, in the breakdown's key order. */
const SOURCE_LABELS: Record<string, string> = {
  instructions: 'Project instructions',
  history: 'Conversation history',
  preamble: 'Command preamble',
  prompt: 'Your prompt',
  attachments: 'Attachments',
  plan: 'Drafted plan',
};

/**
 * The estimated input-tokens-by-source table: what the prompt weight is spent
 * on (instructions, history, attachments, ...), so a user can see what to trim.
 * Empty when no run carried a breakdown (e.g. only oneshot runs with no
 * attachments or instructions).
 */
function inputSourceTable(sources: InputSource[]): string {
  if (sources.length === 0) {
    return '';
  }
  const total = sources.reduce((sum, s) => sum + s.tokens, 0);
  const rows = sources
    .map(
      (s) =>
        `| ${SOURCE_LABELS[s.source] ?? s.source} | ${formatTokenCount(s.tokens)} | ` +
        `${percentLabel(total > 0 ? s.tokens / total : 0)} |`
    )
    .join('\n');
  return (
    '\n## Input by source (estimated)\n\n' +
    '| Source | Tokens | Share |\n| --- | ---: | ---: |\n' +
    `${rows}\n`
  );
}

/** Render a usage rollup to the report's markdown. Exported for tests. */
export function renderUsageReport(rollup: UsageRollup): string {
  return (
    messages.usage.reportHeader(rollup.runs) +
    `\n${summaryLine(rollup.overall)}\n` +
    highlights(rollup) +
    inputSourceTable(rollup.inputBySource) +
    bucketTable('By step', 'Step', rollup.byStep) +
    bucketTable('By model', 'Model', rollup.byModel) +
    bucketTable('By route', 'Route', rollup.byRoute) +
    bucketTable('By day', 'Day (UTC)', rollup.byDay)
  );
}

/** Open the token-usage report built from the eval log as a markdown document. */
export async function runShowUsageCommand(evalLog: EvalLog): Promise<void> {
  const records = await evalLog.readRecords();
  const rollup = rollupUsage(records);
  const content = rollup.runs === 0 ? messages.usage.empty : renderUsageReport(rollup);
  const doc = await vscode.workspace.openTextDocument({
    language: 'markdown',
    content,
  });
  await vscode.window.showTextDocument(doc, { preview: false });
}
