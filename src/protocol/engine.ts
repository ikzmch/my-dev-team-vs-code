/**
 * The engine port: the one interface the UI layer talks to. Two
 * implementations exist or are planned - the in-process LocalEngine
 * (src/engine/localEngine.ts) and a Phase-B RemoteEngine speaking this same
 * contract over HTTP - and a VS Code setting switches between them, so
 * nothing above this interface may depend on which one is running.
 */
import { Complexity, ModelChoice, Plan, PlanDecision, Reply, RunRequest } from './types';
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
  /**
   * The plan-approval seam: the engine calls this when a drafted plan needs the
   * user's verdict before executing (see the `myDevTeam.planApproval` setting),
   * and the client returns approve / cancel / revise. Like the ToolHost, the UI
   * lives entirely on the client - the engine only ever asks. Optional: a client
   * that does not implement it (or an engine that never gates) simply proceeds
   * to execution without a checkpoint, so the gate is purely additive.
   */
  reviewPlan?(plan: Plan, complexity: Complexity): Promise<PlanDecision>;
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
  readonly kind: 'local' | 'remote' | 'sidecar';
  startRun(request: RunRequest, client: RunClient): RunHandle;
  /**
   * Activation-time health probe: human-readable warnings the UI should
   * surface (unreachable server, missing models), empty when all is well.
   * Must never throw and should answer quickly - it must not delay activation.
   */
  startupWarnings(): Promise<string[]>;
  /**
   * The models the user may pick from in the `/model` picker, the "Auto"
   * choice first. The model registry is otherwise an engine internal; this is
   * the one place it is exposed, as user-facing choices (id, label, whether it
   * can run now). Must never throw.
   */
  listModels(): Promise<ModelChoice[]>;
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
