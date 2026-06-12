/**
 * The run event stream - the engine-to-client half of the protocol - and the
 * fold that rebuilds reply snapshots from it on the client.
 *
 * Events are the stable contract: a remote engine will serialize exactly
 * these over the wire (one SSE stream per run), and the LocalEngine emits the
 * same shapes in-process, so the client cannot tell the engines apart. Events
 * carry only user-visible content; deltas and per-event snapshots keep the
 * wire traffic linear in the reply size.
 */
import {
  ExecutionEvent,
  Intent,
  PartialPlan,
  Reply,
  ReplyProgress,
} from './types';

/**
 * The protocol's name for the stage a run is in, used by usage and error
 * events. Deliberately not the engine's internal step ids: those are
 * implementation detail and may change without a protocol bump.
 */
export type RunStep = 'triage' | 'plan' | 'answer' | 'execute';

/** The events an engine emits over the lifetime of one run, in order. */
export type RunEvent =
  /** Triage decided how to route the request. Always the first event. */
  | { type: 'triaged'; intent: Intent; reason: string }
  /**
   * The plan as drafted so far. Snapshots, not deltas: a partial plan is
   * small, and the partial-JSON stream it comes from revises fields in place.
   */
  | { type: 'plan-snapshot'; plan: PartialPlan }
  /** The next chunk of the streamed oneshot answer. */
  | { type: 'answer-delta'; text: string }
  /**
   * Transcript event `index` was appended or changed. Execution transcripts
   * are grow-only with only the last event still mutating (text grows, a tool
   * call gains its result), so re-sending one indexed event at a time keeps
   * the stream linear in the transcript size.
   */
  | { type: 'execution-event'; index: number; event: ExecutionEvent }
  /**
   * The engine asks the client to execute a tool and answer with a
   * `ToolResultMessage` (see toolContract.ts). Only a remote engine emits
   * this: the LocalEngine shares a process with the client and calls its
   * ToolHost directly. Defined now because the event list is the part of the
   * protocol that must not churn.
   */
  | { type: 'tool-call'; callId: string; tool: string; args: unknown }
  /**
   * Metering record for one step's model call: the billing seam. Token counts
   * are omitted when the underlying SDK did not report them; `model` is the
   * concrete model name locally and may be an opaque tier label remotely.
   */
  | {
      type: 'usage';
      step: RunStep;
      model?: string;
      inputTokens?: number;
      outputTokens?: number;
    }
  /** The run finished; `reply` is the complete validated result. */
  | { type: 'done'; reply: Reply }
  /**
   * The run failed. `step` names the stage when it is known; `hint` is an
   * optional engine-supplied troubleshooting line (the LocalEngine points at
   * Ollama and the routed model - knowledge only the engine has).
   */
  | { type: 'error'; step?: RunStep; message: string; hint?: string };

/**
 * Rebuilds grow-only `ReplyProgress` snapshots from the event stream, so the
 * client's renderer works on the same shape the engine's workflow produces
 * internally and local/remote runs render identically.
 *
 * `apply` returns the updated snapshot when the event changed what should be
 * rendered, and undefined for events that do not (usage, tool-call, and
 * anything arriving before the triage decision). The returned object is the
 * folder's live state: render it synchronously, do not retain it.
 */
export class ReplyFolder {
  private progress: ReplyProgress | undefined;

  apply(event: RunEvent): ReplyProgress | undefined {
    if (event.type === 'triaged') {
      this.progress = { intent: event.intent, reason: event.reason };
      return this.progress;
    }
    if (!this.progress) {
      return undefined;
    }
    switch (event.type) {
      case 'plan-snapshot':
        this.progress.plan = event.plan;
        return this.progress;
      case 'answer-delta':
        this.progress.answer = (this.progress.answer ?? '') + event.text;
        return this.progress;
      case 'execution-event': {
        const execution = (this.progress.execution ??= { events: [] });
        execution.events[event.index] = event.event;
        return this.progress;
      }
      case 'done':
        // The final validated reply supersedes whatever was folded so far.
        this.progress = { ...event.reply };
        return this.progress;
      default:
        return undefined;
    }
  }
}
