/**
 * The sidecar wire: the messages that cross between the client (parent) and the
 * engine host (child). This module imports no `vscode` and no Node-only APIs, so
 * both ends and the unit tests can use it. The shapes mirror the engine protocol
 * - run events, the `tool-call` and `plan-review` inversions, and the run result
 * - so the child is just the `LocalEngine` with its `RunClient` piped to the
 * parent (see sidecar/childRuntime.ts and client/sidecarEngine.ts).
 *
 * The Node client transports these as `child_process.fork` IPC messages
 * (`serialization: 'advanced'`, a real structured clone, no framing); they are
 * all plain JSON-serializable data, so a non-Node client (e.g. a future
 * JVM/Kotlin client) can instead frame them as newline-delimited JSON over a
 * stream without changing the contract - which `createStreamChannel`
 * (client/sidecarEngine.ts) does, over any writable/readable pair.
 */
import { RunRequest, Reply, Plan, PlanDecision, Complexity } from '../protocol/types';
import { RunEvent, RunStep } from '../protocol/events';
import { RuntimeConfig } from '../config/runtimeConfig';

/**
 * How a settled run is reported back, preserving the protocol's error shape so
 * the parent can rethrow the same `RunFailedError`/`RunCancelledError` the
 * in-process engine would have.
 */
export type RunResult =
  | { ok: true; reply: Reply }
  | { ok: false; kind: 'failed'; message: string; step?: RunStep; hint?: string }
  | { ok: false; kind: 'cancelled' }
  | { ok: false; kind: 'other'; message: string };

/** Messages the parent (client) sends to the child (engine host). */
export type ParentMessage =
  /** Inject/refresh the engine's runtime config (handshake, then on settings change). */
  | { t: 'config'; config: RuntimeConfig }
  /** Start a run. `canReviewPlan` mirrors whether the real client offers the
   * plan-approval seam, so the child only gates when the parent can answer. */
  | { t: 'start'; runId: string; request: RunRequest; canReviewPlan: boolean }
  /** Cancel a run. */
  | { t: 'cancel'; runId: string }
  /** Answer a `tool-call`: the tool's returned text, or the error it threw. */
  | { t: 'tool-result'; callId: string; ok: true; result: string }
  | { t: 'tool-result'; callId: string; ok: false; error: string }
  /** Answer a `plan-review` with the user's verdict, keyed by the review's id. */
  | { t: 'plan-decision'; reviewId: string; decision: PlanDecision }
  /** Ask the engine a one-shot question (the picker catalogue, startup warnings). */
  | { t: 'query'; queryId: string; method: 'listModels' | 'startupWarnings' };

/** Messages the child (engine host) sends back to the parent. */
export type ChildMessage =
  /**
   * The readiness handshake: posted once when the child's engine is constructed,
   * before any run. Carries the `PROTOCOL_VERSION` the child speaks and the
   * engine `kind`, so the parent can hold the first run until the child is up and
   * reject up front on a version mismatch (a stale `dist/sidecar.js`) instead of
   * mis-serialising mid-run.
   */
  | { t: 'ready'; protocolVersion: number; kind: string }
  /** A run event (the engine's `onEvent`), forwarded verbatim for rendering. */
  | { t: 'event'; runId: string; event: RunEvent }
  /** The engine asks the client to execute a tool and answer with a `tool-result`. */
  | { t: 'tool-call'; runId: string; callId: string; tool: string; args: unknown }
  /**
   * The engine asks the client to approve a plan and answer with a
   * `plan-decision`. `runId` finds the run's client; `reviewId` correlates the
   * resolver, so a run that issues more than one review never overwrites a
   * pending one (the way `callId` correlates a `tool-call`).
   */
  | { t: 'plan-review'; runId: string; reviewId: string; plan: Plan; complexity: Complexity }
  /** The run settled (its `result` promise resolved or rejected). */
  | { t: 'result'; runId: string; result: RunResult }
  /** A query answer. */
  | { t: 'query-result'; queryId: string; ok: true; value: unknown }
  | { t: 'query-result'; queryId: string; ok: false; error: string };

/**
 * The duplex channel the client end (`SidecarEngine`) talks over: it posts
 * parent messages and subscribes to child messages. Production wraps a forked
 * child's stdio (see client/sidecarEngine.ts); tests wire it straight to an
 * in-process child runtime, so the whole inversion is exercised with no process.
 */
export interface SidecarChannel {
  /** Send a message to the child. */
  post(msg: ParentMessage): void;
  /** Subscribe to messages from the child. */
  onMessage(handler: (msg: ChildMessage) => void): void;
  /** Called when the child exits/crashes unexpectedly, with a reason. */
  onClose(handler: (reason: string) => void): void;
  /** Tear the channel down (kill the child). */
  dispose(): void;
}
