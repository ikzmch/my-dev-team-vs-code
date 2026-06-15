/**
 * The engine side of the sidecar: it hosts an `Engine` (the `LocalEngine` in
 * production) and translates the sidecar messages into engine calls. It is the
 * mirror of `client/sidecarEngine.ts` - whatever that posts, this handles, and
 * vice versa. It imports no `vscode` (the whole point of the runtime-config and
 * env-only-secrets work), so it runs in a plain Node child.
 *
 * The inversions are wired here: the run's `ToolHost` is a proxy that posts a
 * `tool-call` and resolves when the parent answers with a `tool-result`, and the
 * `reviewPlan` seam posts a `plan-review` and resolves on the `plan-decision` -
 * so an engine running in the child can only ever *ask* the client to touch the
 * workspace or approve a plan, exactly as in-process.
 */
import {
  Engine,
  RunClient,
  RunHandle,
  RunFailedError,
  RunCancelledError,
} from '../protocol/engine';
import { ToolHost } from '../protocol/toolContract';
import { RunRequest, PlanDecision, PROTOCOL_VERSION } from '../protocol/types';
import { setRuntimeConfig } from '../config/runtimeConfig';
import { ParentMessage, ChildMessage, RunResult } from './transport';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Translate a failed run's error into the wire's `RunResult`, preserving the error shape. */
function failureResult(err: unknown): RunResult {
  if (err instanceof RunCancelledError) {
    return { ok: false, kind: 'cancelled' };
  }
  if (err instanceof RunFailedError) {
    return { ok: false, kind: 'failed', message: err.message, step: err.step, hint: err.hint };
  }
  return { ok: false, kind: 'other', message: errorMessage(err) };
}

/**
 * Build the child's message handler. `post` sends a message to the parent;
 * `makeEngine` constructs the engine to host (production passes
 * `() => new LocalEngine()`, tests pass a fake). Returns the function that
 * processes each parent message.
 */
export function createChildRuntime(
  post: (msg: ChildMessage) => void,
  makeEngine: () => Engine
): (msg: ParentMessage) => void {
  const engine = makeEngine();
  // The readiness handshake: tell the parent the engine is up, which protocol it
  // speaks, and its kind. Deferred to a microtask so the parent (which subscribes
  // to messages as it constructs its channel) has its handler in place first -
  // in the forked case the child starts asynchronously anyway, but the in-process
  // test harness wires the two ends in the same tick.
  queueMicrotask(() =>
    post({ t: 'ready', protocolVersion: PROTOCOL_VERSION, kind: engine.kind })
  );
  const runs = new Map<string, RunHandle>();
  // Each pending inversion remembers its `runId` so a run that settles (or whose
  // parent answer never arrives) can clean up the promises it left waiting,
  // rather than leaking them.
  const toolCalls = new Map<
    string,
    { runId: string; resolve: (result: string) => void; reject: (err: Error) => void }
  >();
  const planReviews = new Map<
    string,
    { runId: string; resolve: (decision: PlanDecision) => void }
  >();
  let callSeq = 0;
  let reviewSeq = 0;

  /**
   * Settle a run: forget its handle and reject any tool call still awaiting a
   * `tool-result` (the parent already settled the run, so no answer is coming),
   * and drop any pending plan review so its resolver does not leak.
   */
  function settleRun(runId: string): void {
    runs.delete(runId);
    for (const [callId, pending] of toolCalls) {
      if (pending.runId === runId) {
        toolCalls.delete(callId);
        pending.reject(new RunCancelledError());
      }
    }
    for (const [reviewId, pending] of planReviews) {
      if (pending.runId === runId) {
        planReviews.delete(reviewId);
      }
    }
  }

  function startRun(runId: string, request: RunRequest, canReviewPlan: boolean): void {
    const toolHost: ToolHost = {
      tools: request.offeredTools,
      execute: (tool, args, signal) =>
        new Promise<string>((resolve, reject) => {
          const callId = `${runId}#${callSeq++}`;
          toolCalls.set(callId, { runId, resolve, reject });
          if (signal) {
            const onAbort = () => {
              if (toolCalls.delete(callId)) {
                reject(signal.reason instanceof Error ? signal.reason : new Error('Aborted'));
              }
            };
            if (signal.aborted) {
              onAbort();
              return;
            }
            signal.addEventListener('abort', onAbort, { once: true });
          }
          post({ t: 'tool-call', runId, callId, tool, args });
        }),
    };

    const client: RunClient = {
      onEvent: (event) => post({ t: 'event', runId, event }),
      toolHost,
      ...(canReviewPlan
        ? {
            reviewPlan: (plan, complexity) =>
              new Promise<PlanDecision>((resolve) => {
                const reviewId = `${runId}~${reviewSeq++}`;
                planReviews.set(reviewId, { runId, resolve });
                post({ t: 'plan-review', runId, reviewId, plan, complexity });
              }),
          }
        : {}),
    };

    let handle: RunHandle;
    try {
      handle = engine.startRun(request, client);
    } catch (err) {
      settleRun(runId);
      post({ t: 'result', runId, result: failureResult(err) });
      return;
    }
    runs.set(runId, handle);
    handle.result.then(
      (reply) => {
        settleRun(runId);
        post({ t: 'result', runId, result: { ok: true, reply } });
      },
      (err) => {
        settleRun(runId);
        post({ t: 'result', runId, result: failureResult(err) });
      }
    );
  }

  return (msg: ParentMessage): void => {
    switch (msg.t) {
      case 'config':
        setRuntimeConfig(msg.config);
        return;
      case 'start':
        startRun(msg.runId, msg.request, msg.canReviewPlan);
        return;
      case 'cancel':
        runs.get(msg.runId)?.cancel();
        return;
      case 'tool-result': {
        const pending = toolCalls.get(msg.callId);
        if (!pending) {
          return;
        }
        toolCalls.delete(msg.callId);
        if (msg.ok) {
          pending.resolve(msg.result);
        } else {
          pending.reject(new Error(msg.error));
        }
        return;
      }
      case 'plan-decision': {
        const pending = planReviews.get(msg.reviewId);
        if (pending) {
          planReviews.delete(msg.reviewId);
          pending.resolve(msg.decision);
        }
        return;
      }
      case 'query': {
        const answer =
          msg.method === 'listModels' ? engine.listModels() : engine.startupWarnings();
        answer.then(
          (value) => post({ t: 'query-result', queryId: msg.queryId, ok: true, value }),
          (err) => post({ t: 'query-result', queryId: msg.queryId, ok: false, error: errorMessage(err) })
        );
        return;
      }
    }
  };
}
