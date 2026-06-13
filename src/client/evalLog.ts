/**
 * The telemetry/eval sink: a local, opt-in JSONL store for the run signal the
 * chat surface produces for free - one record per finished run (route,
 * per-step model + token usage, outcome) and one per 👍/👎 feedback click,
 * paired by run id. The point is measurability: with the log on, a routing or
 * prompt change can be judged against real feedback per token spent.
 *
 * Privacy by construction: records carry no prompt text, no attachment or
 * file contents, and no reply text - only routing labels, model names, token
 * counts, and outcomes. Storing is opt-in (`myDevTeam.telemetry.evalLog`,
 * default off) and the file never leaves the machine: it lives in the
 * extension's global storage as one JSON object per line, ready for offline
 * eval tooling. This is a client seam like the Approver: whichever engine
 * runs, the signal is collected (and gated) here.
 */
import * as vscode from 'vscode';
import { InputBreakdown } from '../protocol/events';
import { Intent } from '../protocol/types';
import { settings } from '../config/settings';

/** Metering for one step's model call, from the run's protocol usage events. */
export interface UsageEntry {
  step: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  /** Output tokens spent on hidden reasoning, when the model reports them. */
  reasoningTokens?: number;
  /** Input tokens served from a prompt cache, when the provider reports them. */
  cachedInputTokens?: number;
  /** The provider's own total, when given. */
  totalTokens?: number;
  /** True when the counts are a length-based estimate, not SDK-reported. */
  estimated?: boolean;
  /** Estimated split of the input tokens by prompt section (plan/answer/execute). */
  inputBreakdown?: InputBreakdown;
  /** True when this call was a self-repair retry after the first output failed validation. */
  repaired?: boolean;
}

/** How a run ended, as the chat handler saw it. */
export type RunOutcome = 'ok' | 'error' | 'cancelled';

/** One finished run: the route taken, what it cost, and how it ended. */
export interface RunRecord {
  record: 'run';
  ts: string;
  runId: string;
  /** The turn's slash command; empty for a plain prompt. */
  command?: string;
  /** The triage route (oneshot | planning); absent when triage never ran. */
  intent?: string;
  outcome: RunOutcome;
  /** The protocol step that failed, when the outcome is an error. */
  errorStep?: string;
  usage: UsageEntry[];
  /**
   * Stable id of the chat conversation this run belongs to, so runs of one
   * thread can be grouped to watch input tokens grow turn over turn. Absent on
   * records written before the field existed.
   */
  conversationId?: string;
  /** Wall-clock duration of the run in milliseconds, as the client measured it. */
  durationMs?: number;
  /**
   * On a pinned run with shadow triage on, what triage would have decided. With
   * the pinned route in `command`/`intent`, this is the signal for scoring
   * triage; absent on non-pinned runs and when shadow triage was off.
   */
  triagePredicted?: Intent;
}

/** One 👍/👎 click, paired with its run through the chat result metadata. */
export interface FeedbackRecord {
  record: 'feedback';
  ts: string;
  kind: 'helpful' | 'unhelpful';
  runId?: string;
  command?: string;
  intent?: string;
}

export type EvalRecord = RunRecord | FeedbackRecord;

/** File the records are appended to, inside the extension's global storage. */
export const EVAL_LOG_FILENAME = 'eval-log.jsonl';

export class EvalLog {
  private readonly directory: vscode.Uri;
  private readonly file: vscode.Uri;
  /** Serializes appends so concurrent records cannot interleave the read-modify-write. */
  private queue: Promise<void> = Promise.resolve();

  constructor(storageDirectory: vscode.Uri) {
    this.directory = storageDirectory;
    this.file = vscode.Uri.joinPath(storageDirectory, EVAL_LOG_FILENAME);
  }

  /** Append one run record. Resolves once written; never rejects. */
  recordRun(record: Omit<RunRecord, 'record' | 'ts'>): Promise<void> {
    return this.append({ record: 'run', ts: new Date().toISOString(), ...record });
  }

  /** Append one feedback record. Resolves once written; never rejects. */
  recordFeedback(record: Omit<FeedbackRecord, 'record' | 'ts'>): Promise<void> {
    return this.append({ record: 'feedback', ts: new Date().toISOString(), ...record });
  }

  /**
   * Read back every stored record, oldest first, for offline analysis (the
   * "Show Token Usage" command rolls these up). A missing file (the log was
   * never written, or the setting is off) yields an empty list; a malformed
   * line is skipped so one bad write never hides the rest of the history.
   */
  async readRecords(): Promise<EvalRecord[]> {
    let text: string;
    try {
      text = new TextDecoder().decode(await vscode.workspace.fs.readFile(this.file));
    } catch {
      return [];
    }
    const records: EvalRecord[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) {
        continue;
      }
      try {
        records.push(JSON.parse(line) as EvalRecord);
      } catch {
        // A truncated or corrupt line: skip it, keep the rest.
      }
    }
    return records;
  }

  private append(record: EvalRecord): Promise<void> {
    // The opt-in gate: with the setting off (the default) nothing is stored.
    // Read live per record, so flipping the setting needs no reload.
    if (!settings.telemetry.evalLogEnabled) {
      return Promise.resolve();
    }
    // A failed write loses one record, never the chain and never the caller:
    // telemetry must not be able to break the chat turn it is measuring.
    this.queue = this.queue.then(() => this.write(record)).catch(() => {});
    return this.queue;
  }

  private async write(record: EvalRecord): Promise<void> {
    await vscode.workspace.fs.createDirectory(this.directory);
    let existing = '';
    try {
      existing = new TextDecoder().decode(
        await vscode.workspace.fs.readFile(this.file)
      );
    } catch {
      // First record: the file does not exist yet.
    }
    const line = JSON.stringify(record) + '\n';
    let next = existing + line;
    const cap = settings.telemetry.evalLogMaxChars;
    if (next.length > cap) {
      // Drop whole oldest lines until the log fits the cap again. A single
      // record larger than the whole cap is kept alone: truncating it would
      // corrupt the JSONL, and dropping it must not take the history with it.
      const cut = next.indexOf('\n', next.length - cap);
      next = cut >= 0 ? next.slice(cut + 1) : next;
      if (next.length === 0) {
        next = line;
      }
    }
    await vscode.workspace.fs.writeFile(this.file, new TextEncoder().encode(next));
  }
}
