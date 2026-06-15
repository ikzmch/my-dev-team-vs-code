/**
 * The client end of the sidecar: an `Engine` that runs the real engine in a
 * child process. It owns no agent logic - it forwards each run over the channel,
 * folds the child's events back into `client.onEvent`, and services the engine's
 * inversions on this side of the boundary: a `tool-call` runs through the real
 * `client.toolHost` (so files, the shell, and the approval gate stay in the
 * editor), and a `plan-review` runs through the real `client.reviewPlan`. The
 * run's result is settled from the terminal `result` message, rethrowing the
 * same `RunFailedError`/`RunCancelledError` the in-process engine would have.
 *
 * It is transport-agnostic: it takes a `SidecarChannel`, so a unit test can wire
 * it straight to an in-process child runtime, and production wraps a forked
 * child (see `createForkedChannel`).
 */
import { fork } from 'node:child_process';
import {
  Engine,
  RunClient,
  RunHandle,
  RunFailedError,
  RunCancelledError,
} from '../protocol/engine';
import { RunRequest, Reply, ModelChoice } from '../protocol/types';
import { RuntimeConfig } from '../config/runtimeConfig';
import { SidecarChannel, ChildMessage, RunResult } from '../sidecar/transport';

interface RunState {
  client: RunClient;
  ac: AbortController;
  resolve: (reply: Reply) => void;
  reject: (err: unknown) => void;
  settled: boolean;
}

export class SidecarEngine implements Engine {
  readonly kind = 'sidecar';
  private runSeq = 0;
  private querySeq = 0;
  private readonly runs = new Map<string, RunState>();
  private readonly queries = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  /** Set once the child exits/crashes; further runs fail fast with this reason. */
  private closedReason: string | undefined;

  constructor(
    private readonly channel: SidecarChannel,
    private readonly getConfig: () => RuntimeConfig
  ) {
    channel.onMessage((msg) => this.handle(msg));
    channel.onClose((reason) => this.handleClose(reason));
    // Hand the engine its config before any run (env-var secrets ride in the
    // child's process environment, so only this non-secret config is sent).
    channel.post({ t: 'config', config: getConfig() });
  }

  /** Re-send the runtime config; call when the user changed a setting. */
  refreshConfig(): void {
    if (!this.closedReason) {
      this.channel.post({ t: 'config', config: this.getConfig() });
    }
  }

  dispose(): void {
    this.channel.dispose();
  }

  startRun(request: RunRequest, client: RunClient): RunHandle {
    const runId = `run-${this.runSeq++}`;
    const ac = new AbortController();
    let resolve!: (reply: Reply) => void;
    let reject!: (err: unknown) => void;
    const result = new Promise<Reply>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const state: RunState = { client, ac, resolve, reject, settled: false };
    this.runs.set(runId, state);

    if (this.closedReason) {
      state.settled = true;
      this.runs.delete(runId);
      reject(new RunFailedError(undefined, this.closedReason));
    } else {
      this.channel.post({ t: 'start', runId, request, canReviewPlan: !!client.reviewPlan });
    }

    return {
      result,
      cancel: () => {
        ac.abort(new RunCancelledError());
        if (!this.closedReason) {
          this.channel.post({ t: 'cancel', runId });
        }
      },
    };
  }

  async listModels(): Promise<ModelChoice[]> {
    try {
      return (await this.query('listModels')) as ModelChoice[];
    } catch {
      return [];
    }
  }

  async startupWarnings(): Promise<string[]> {
    try {
      return (await this.query('startupWarnings')) as string[];
    } catch {
      return [];
    }
  }

  private query(method: 'listModels' | 'startupWarnings'): Promise<unknown> {
    if (this.closedReason) {
      return Promise.reject(new Error(this.closedReason));
    }
    const queryId = `q-${this.querySeq++}`;
    return new Promise<unknown>((resolve, reject) => {
      this.queries.set(queryId, { resolve, reject });
      this.channel.post({ t: 'query', queryId, method });
    });
  }

  private handle(msg: ChildMessage): void {
    switch (msg.t) {
      case 'event':
        this.runs.get(msg.runId)?.client.onEvent(msg.event);
        return;
      case 'tool-call': {
        const state = this.runs.get(msg.runId);
        if (!state) {
          return;
        }
        state.client.toolHost.execute(msg.tool, msg.args, state.ac.signal, msg.runId).then(
          (result) =>
            this.channel.post({ t: 'tool-result', callId: msg.callId, ok: true, result }),
          (err) =>
            this.channel.post({
              t: 'tool-result',
              callId: msg.callId,
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            })
        );
        return;
      }
      case 'plan-review': {
        const review = this.runs.get(msg.runId)?.client.reviewPlan;
        if (!review) {
          return;
        }
        void review(msg.plan, msg.complexity).then((decision) =>
          this.channel.post({ t: 'plan-decision', runId: msg.runId, decision })
        );
        return;
      }
      case 'result':
        this.settleResult(msg.runId, msg.result);
        return;
      case 'query-result': {
        const q = this.queries.get(msg.queryId);
        if (!q) {
          return;
        }
        this.queries.delete(msg.queryId);
        if (msg.ok) {
          q.resolve(msg.value);
        } else {
          q.reject(new Error(msg.error));
        }
        return;
      }
    }
  }

  private settleResult(runId: string, result: RunResult): void {
    const state = this.runs.get(runId);
    if (!state || state.settled) {
      return;
    }
    state.settled = true;
    this.runs.delete(runId);
    if (result.ok) {
      state.resolve(result.reply);
    } else if (result.kind === 'cancelled') {
      state.reject(new RunCancelledError());
    } else if (result.kind === 'failed') {
      state.reject(new RunFailedError(result.step, result.message, result.hint));
    } else {
      state.reject(new Error(result.message));
    }
  }

  private handleClose(reason: string): void {
    this.closedReason = reason;
    for (const state of this.runs.values()) {
      if (!state.settled) {
        state.settled = true;
        state.reject(new RunFailedError(undefined, reason));
      }
    }
    this.runs.clear();
    for (const q of this.queries.values()) {
      q.reject(new Error(reason));
    }
    this.queries.clear();
  }
}

/**
 * A production channel that forks the bundled engine child (`dist/sidecar.js`)
 * and talks to it over `child_process` IPC. The child inherits the parent's
 * environment, so env-var API keys resolve there with nothing on the wire.
 */
export function createForkedChannel(scriptPath: string): SidecarChannel {
  const child = fork(scriptPath, [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  const messageHandlers: ((m: ChildMessage) => void)[] = [];
  const closeHandlers: ((reason: string) => void)[] = [];
  let closed = false;
  const close = (reason: string): void => {
    if (closed) {
      return;
    }
    closed = true;
    for (const h of closeHandlers) {
      h(reason);
    }
  };
  child.on('message', (m) => {
    for (const h of messageHandlers) {
      h(m as ChildMessage);
    }
  });
  child.on('exit', (code, signal) =>
    close(`The engine sidecar exited unexpectedly (${signal ?? `code ${code}`}).`)
  );
  child.on('error', (err) => close(`The engine sidecar could not start: ${err.message}`));
  return {
    post: (msg) => {
      if (!closed) {
        child.send(msg);
      }
    },
    onMessage: (h) => {
      messageHandlers.push(h);
    },
    onClose: (h) => {
      closeHandlers.push(h);
    },
    dispose: () => {
      closed = true;
      child.kill();
    },
  };
}
