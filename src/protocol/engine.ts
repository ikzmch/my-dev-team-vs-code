/**
 * The engine port: the one interface the UI layer talks to. Two
 * implementations exist or are planned - the in-process LocalEngine
 * (src/engine/localEngine.ts) and a Phase-B RemoteEngine speaking this same
 * contract over HTTP - and a VS Code setting switches between them, so
 * nothing above this interface may depend on which one is running.
 */
import { Reply, RunRequest } from './types';
import { RunEvent, RunStep } from './events';
import { ToolHost } from './toolContract';

/**
 * What the client hands the engine for one run: where to deliver events and
 * who executes tools. `onEvent` must not throw into the engine - a rendering
 * problem must never fail the run it is only observing.
 */
export interface RunClient {
  onEvent(event: RunEvent): void;
  toolHost: ToolHost;
}

/** A started run. `result` settles exactly once; `cancel` is idempotent. */
export interface RunHandle {
  /**
   * The final validated reply. Rejects with `RunFailedError` when the run
   * failed, `RunCancelledError` when it was cancelled, or the raw error for
   * anything unexpected.
   */
  result: Promise<Reply>;
  /** Stop the run: abort model calls and in-flight tool executions. */
  cancel(): void;
}

export interface Engine {
  readonly kind: 'local' | 'remote';
  startRun(request: RunRequest, client: RunClient): RunHandle;
  /**
   * Activation-time health probe: human-readable warnings the UI should
   * surface (unreachable server, missing models), empty when all is well.
   * Must never throw and should answer quickly - it must not delay activation.
   */
  startupWarnings(): Promise<string[]>;
}

/**
 * The credentials a run carries to a remote engine. The LocalEngine ignores
 * them; Phase B attaches them as a header per request (never in the protocol
 * body), which is what makes per-request billing and rate limiting work.
 */
export type Credentials =
  | { kind: 'anonymous' }
  | { kind: 'bearer'; token: string };

/** Supplies credentials at request time (VS Code auth session, stored key...). */
export interface AuthProvider {
  getCredentials(): Promise<Credentials>;
}

/** A run that ended in a step failure. `hint` is engine-supplied troubleshooting text. */
export class RunFailedError extends Error {
  constructor(
    readonly step: RunStep | undefined,
    message: string,
    readonly hint?: string
  ) {
    super(message);
    this.name = 'RunFailedError';
  }
}

/** A run stopped by `RunHandle.cancel` before it could finish. */
export class RunCancelledError extends Error {
  constructor() {
    super('The run was cancelled.');
    this.name = 'RunCancelledError';
  }
}
