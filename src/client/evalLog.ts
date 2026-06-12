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
import { settings } from '../config/settings';

/** Metering for one step's model call, from the run's protocol usage events. */
export interface UsageEntry {
  step: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
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
    let next = existing + JSON.stringify(record) + '\n';
    const cap = settings.telemetry.evalLogMaxChars;
    if (next.length > cap) {
      // Drop whole oldest lines until the log fits the cap again.
      const cut = next.indexOf('\n', next.length - cap);
      next = cut >= 0 ? next.slice(cut + 1) : next;
    }
    await vscode.workspace.fs.writeFile(this.file, new TextEncoder().encode(next));
  }
}
