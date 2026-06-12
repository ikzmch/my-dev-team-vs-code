/**
 * The in-process implementation of the engine port (src/protocol/engine.ts):
 * the whole agent pipeline - triage, planner, answerer, executor, the model
 * router, every prompt - running inside the extension, exactly as before the
 * protocol existed. A Phase-B RemoteEngine implements the same interface by
 * forwarding the protocol over HTTP; the client cannot tell them apart,
 * which is what makes the `myDevTeam.engine` setting a safe switch.
 *
 * Everything in src/engine/ is implementation a future backend hides. The
 * boundary discipline: ui/, tools/, and client/ may import this file and the
 * protocol, never anything in engine/core or engine/config.
 */
import { RequestContext } from '@mastra/core/request-context';
import { Triage } from './core/triage';
import { Planner } from './core/planner';
import { Answerer } from './core/answerer';
import { Executor } from './core/executor';
import {
  createDevTeamWorkflow,
  abortSignalKey,
  replyProgressKey,
  stepIds,
  usageSinkKey,
  ReplyProgress,
  StepUsage,
} from './core/workflow';
import { agents, AgentName } from './config/agents';
import { selectModel } from './config/models';
import { settings } from '../config/settings';
import { messages } from '../config/messages';
import {
  ExecutionEvent,
  PROTOCOL_VERSION,
  Reply,
  ReplySchema,
  RunRequest,
  RunRequestSchema,
} from '../protocol/types';
import { RunEvent, RunStep } from '../protocol/events';
import { ToolHost } from '../protocol/toolContract';
import {
  Engine,
  RunClient,
  RunHandle,
  RunCancelledError,
  RunFailedError,
} from '../protocol/engine';

/** The models the router selects for the registered agents, deduplicated. */
export function routedModels(): string[] {
  const names = new Set<string>();
  for (const agent of Object.values(agents)) {
    names.add(selectModel(agent.capabilities).model);
  }
  return [...names];
}

/**
 * Translates the workflow's grow-only ReplyProgress snapshots into the
 * protocol's event stream. The mapping is exact: a client folding the events
 * back (protocol/events.ts ReplyFolder) reproduces each snapshot at the same
 * point, so rendering from events is pixel-identical to rendering from the
 * snapshots directly - the property that makes local and remote runs look
 * the same.
 */
export class ProgressTranslator {
  private triaged = false;
  private answerChars = 0;
  private executionSeen: ExecutionEvent[] = [];

  constructor(private readonly emit: (event: RunEvent) => void) {}

  push(progress: ReplyProgress): void {
    if (!this.triaged) {
      this.triaged = true;
      this.emit({ type: 'triaged', intent: progress.intent, reason: progress.reason });
    }
    // Plans stream as snapshots while they are being drafted; once execution
    // output exists the plan is final and already emitted.
    if (progress.plan && !progress.execution) {
      this.emit({ type: 'plan-snapshot', plan: progress.plan });
    }
    if (progress.answer !== undefined && progress.answer.length > this.answerChars) {
      this.emit({ type: 'answer-delta', text: progress.answer.slice(this.answerChars) });
      this.answerChars = progress.answer.length;
    }
    if (progress.execution) {
      // Transcripts are grow-only with only the last event still mutating, so
      // comparing from the previously-last event finds every change.
      const events = progress.execution.events;
      const start = Math.max(0, this.executionSeen.length - 1);
      for (let index = start; index < events.length; index++) {
        const event = events[index];
        if (
          index >= this.executionSeen.length ||
          JSON.stringify(event) !== JSON.stringify(this.executionSeen[index])
        ) {
          this.emit({ type: 'execution-event', index, event: { ...event } });
          this.executionSeen[index] = { ...event };
        }
      }
    }
  }
}

/**
 * Which protocol step (and which agent's routed model, for the Ollama hint) a
 * failed workflow step maps onto. Checked in pipeline-reverse order so the
 * deepest step that failed wins; an unattributable failure falls back to
 * triage, matching the pre-protocol error rendering.
 */
const failureMap: ReadonlyArray<{ stepId: string; step: RunStep; agent: AgentName }> = [
  { stepId: stepIds.execute, step: 'execute', agent: 'executor' },
  { stepId: stepIds.plan, step: 'plan', agent: 'planner' },
  { stepId: stepIds.answer, step: 'answer', agent: 'answerer' },
  { stepId: stepIds.triage, step: 'triage', agent: 'triage' },
];

function failureDetail(error: unknown): string {
  // Mastra serializes step errors to plain `{ message, … }` objects, so the
  // value here may be an Error, a serialized error, or anything thrown.
  return typeof error === 'object' && error !== null && 'message' in error
    ? String((error as { message: unknown }).message)
    : String(error);
}

function ollamaHint(agent: AgentName): string {
  const { model } = selectModel(agents[agent].capabilities);
  return messages.ollamaHint(settings.ollamaEndpoint, model);
}

function mapFailure(
  error: unknown,
  steps: Record<string, { status: string }>
): RunFailedError {
  const detail = failureDetail(error);
  for (const { stepId, step, agent } of failureMap) {
    if (steps[stepId]?.status === 'failed') {
      return new RunFailedError(step, detail, ollamaHint(agent));
    }
  }
  return new RunFailedError('triage', detail, ollamaHint('triage'));
}

/** Shape of the Ollama `GET /api/tags` response, as far as the probe reads it. */
interface TagsResponse {
  models?: Array<{ name?: string; model?: string }>;
}

/**
 * The agents the LocalEngine runs the workflow with. Injectable so tests can
 * drive the engine with scripted fakes; the default set is the real, routed
 * agents. The executor is a factory because it is bound to the run's ToolHost.
 */
export interface LocalEngineAgents {
  triage: Triage;
  planner: Planner;
  answerer: Answerer;
  createExecutor: (toolHost: ToolHost) => Executor;
}

function defaultAgents(): LocalEngineAgents {
  return {
    triage: new Triage(),
    planner: new Planner(),
    answerer: new Answerer(),
    createExecutor: (toolHost) => new Executor(toolHost),
  };
}

export class LocalEngine implements Engine {
  readonly kind = 'local' as const;
  private readonly agents: LocalEngineAgents;

  constructor(agentSet?: LocalEngineAgents) {
    this.agents = agentSet ?? defaultAgents();
  }

  startRun(request: RunRequest, client: RunClient): RunHandle {
    const abort = new AbortController();
    let cancelled = false;
    let activeRun: { cancel(): unknown } | undefined;

    // Event delivery must never throw into the run: the engine is producing,
    // the client is only watching.
    const emit = (event: RunEvent) => {
      try {
        client.onEvent(event);
      } catch {
        // A broken sink loses events, never the run.
      }
    };

    const result = (async (): Promise<Reply> => {
      const input = RunRequestSchema.parse(request);
      if (input.protocolVersion !== PROTOCOL_VERSION) {
        throw new RunFailedError(
          undefined,
          `Protocol version ${input.protocolVersion} is not supported (this engine speaks ${PROTOCOL_VERSION}).`
        );
      }

      // The executor is bound to this run's ToolHost; everything else is
      // shared. Workflow assembly is plain object composition, cheap per run.
      const workflow = createDevTeamWorkflow(
        this.agents.triage,
        this.agents.planner,
        this.agents.answerer,
        this.agents.createExecutor(client.toolHost)
      );
      const run = await workflow.createRun();
      activeRun = run;
      if (cancelled) {
        throw new RunCancelledError();
      }

      const translator = new ProgressTranslator(emit);
      const requestContext = new RequestContext();
      requestContext.set(abortSignalKey, abort.signal);
      requestContext.set(replyProgressKey, (progress: ReplyProgress) =>
        translator.push(progress)
      );
      requestContext.set(usageSinkKey, (usage: StepUsage) =>
        emit({ type: 'usage', ...usage })
      );

      let outcome;
      try {
        outcome = await run.start({
          inputData: {
            prompt: input.prompt,
            attachments: input.attachments,
            history: input.history,
          },
          requestContext,
        });
      } catch (err) {
        if (cancelled) {
          throw new RunCancelledError();
        }
        throw err;
      }

      if (cancelled || (outcome.status as string) === 'canceled') {
        throw new RunCancelledError();
      }
      if (outcome.status === 'success') {
        // Parse rather than cast: the protocol schema is the promise the
        // engine makes to every client, local or remote.
        return ReplySchema.parse(outcome.result);
      }
      if (outcome.status === 'failed') {
        throw mapFailure(outcome.error, outcome.steps);
      }
      throw new RunFailedError(
        undefined,
        `The run ended with unexpected status "${outcome.status}".`
      );
    })();

    // Mirror the outcome onto the event stream, so a consumer watching only
    // events sees the same ending the result promise reports.
    const reported = result
      .then((reply) => {
        emit({ type: 'done', reply });
        return reply;
      })
      .catch((err) => {
        if (!(err instanceof RunCancelledError)) {
          emit({
            type: 'error',
            step: err instanceof RunFailedError ? err.step : undefined,
            message: err instanceof Error ? err.message : String(err),
            hint: err instanceof RunFailedError ? err.hint : undefined,
          });
        }
        throw err;
      });

    return {
      result: reported,
      cancel: () => {
        cancelled = true;
        abort.abort();
        void activeRun?.cancel();
      },
    };
  }

  /**
   * Ping the configured Ollama endpoint and report (never show - surfacing is
   * the UI's job) whether the server is unreachable or any router-selected
   * model is not pulled, instead of letting the first run be what fails.
   */
  async startupWarnings(): Promise<string[]> {
    const endpoint = settings.ollamaEndpoint;

    let installed: Set<string>;
    try {
      const res = await fetch(`${endpoint}/api/tags`, {
        signal: AbortSignal.timeout(settings.startupProbeTimeoutMs),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const tags = (await res.json()) as TagsResponse;
      installed = new Set(
        (tags.models ?? [])
          .flatMap((m) => [m.name, m.model])
          .filter((n): n is string => typeof n === 'string')
      );
    } catch {
      return [messages.startup.unreachable(endpoint)];
    }

    // Ollama reports untagged pulls as "<model>:latest", so accept that alias.
    const missing = routedModels().filter(
      (model) => !installed.has(model) && !installed.has(`${model}:latest`)
    );
    return missing.length > 0 ? [messages.startup.missingModels(missing)] : [];
  }
}
