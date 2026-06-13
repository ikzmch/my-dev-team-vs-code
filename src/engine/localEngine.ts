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
import {
  AUTO_MODEL,
  PROVIDER_PIN_PREFIX,
  modelById,
  modelRegistry,
  providerLabels,
  providerPinOf,
  ModelInfo,
  ProviderName,
} from './config/models';
import { routeModel, localModels, isModelAvailable } from './core/models';
import { settings } from '../config/settings';
import { messages } from '../config/messages';
import {
  ExecutionEvent,
  Intent,
  ModelChoice,
  ModelSelection,
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

/**
 * The Ollama models the router selects for the registered agents under Auto
 * routing, deduplicated - the set the startup probe checks are pulled. Triage
 * always routes among the local models; the other agents route among the
 * available models, so a cloud model they pick (when its key is set) is simply
 * not an Ollama tag to check and is left out.
 */
export function routedModels(): string[] {
  const names = new Set<string>();
  names.add(routeModel(agents.triage.capabilities, undefined, localModels()).model);
  for (const name of ['planner', 'answerer', 'executor'] as const) {
    const info = routeModel(agents[name].capabilities);
    if (info.provider === 'ollama') {
      names.add(info.model);
    }
  }
  return [...names];
}

/**
 * Which model each step will use for this run, for the protocol's
 * `model-selected` event and the reply's `selection`. Deterministic from the
 * route and the user's pin, so the streamed event and the final reply always
 * agree. Triage is always a local Ollama model; the work agents honour the
 * pin (or, in Auto, the best available model). Only the steps the route will
 * run are listed: triage always, then plan+execute, or answer.
 */
export function modelSelection(intent: Intent, modelPin?: string): ModelSelection {
  // pinned (a model id) > provider (a "provider:<name>" pin) > auto.
  const providerPin = providerPinOf(modelPin);
  const mode: ModelSelection['mode'] = modelById(modelPin)
    ? 'pinned'
    : providerPin
    ? 'provider'
    : 'auto';
  const entry = (step: string, info: ModelInfo) => ({
    step,
    id: info.id,
    label: info.label,
  });
  const models = [
    entry('triage', routeModel(agents.triage.capabilities, undefined, localModels())),
  ];
  if (intent === 'planning') {
    models.push(entry('plan', routeModel(agents.planner.capabilities, modelPin)));
    models.push(entry('execute', routeModel(agents.executor.capabilities, modelPin)));
  } else {
    models.push(entry('answer', routeModel(agents.answerer.capabilities, modelPin)));
  }
  return providerPin
    ? { mode, provider: providerLabels[providerPin], models }
    : { mode, models };
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

  /**
   * `selectionFor` (when given) maps the decided route to the run's model
   * selection, so the translator can emit `model-selected` right after the
   * first `triaged` - the route is what decides which steps run.
   */
  constructor(
    private readonly emit: (event: RunEvent) => void,
    private readonly selectionFor?: (intent: Intent) => ModelSelection
  ) {}

  push(progress: ReplyProgress): void {
    if (!this.triaged) {
      this.triaged = true;
      this.emit({ type: 'triaged', intent: progress.intent, reason: progress.reason });
      if (this.selectionFor) {
        this.emit({
          type: 'model-selected',
          selection: this.selectionFor(progress.intent),
        });
      }
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

/**
 * The troubleshooting hint for a failed agent, naming the model it actually
 * used. An Ollama model points at the server + tag to pull; a cloud model
 * points at its missing/invalid API key. Triage always uses a local model.
 */
function failureHint(agent: AgentName, modelPin?: string): string {
  const info =
    agent === 'triage'
      ? routeModel(agents.triage.capabilities, undefined, localModels())
      : routeModel(agents[agent].capabilities, modelPin);
  return info.provider === 'ollama'
    ? messages.ollamaHint(settings.ollamaEndpoint, info.model)
    : messages.cloudKeyHint(info.label, info.provider);
}

function mapFailure(
  error: unknown,
  steps: Record<string, { status: string }>,
  modelPin?: string
): RunFailedError {
  const detail = failureDetail(error);
  for (const { stepId, step, agent } of failureMap) {
    if (steps[stepId]?.status === 'failed') {
      return new RunFailedError(step, detail, failureHint(agent, modelPin));
    }
  }
  return new RunFailedError('triage', detail, failureHint('triage', modelPin));
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
  /** Triage is shared across runs - it never honours the model pin. */
  triage: Triage;
  /** Built per run with the request's model pin (planner/answerer/executor honour it). */
  createPlanner: (modelPin?: string) => Planner;
  createAnswerer: (modelPin?: string) => Answerer;
  createExecutor: (toolHost: ToolHost, modelPin?: string) => Executor;
}

function defaultAgents(): LocalEngineAgents {
  return {
    triage: new Triage(),
    createPlanner: (modelPin) => new Planner(modelPin),
    createAnswerer: (modelPin) => new Answerer(modelPin),
    createExecutor: (toolHost, modelPin) => new Executor(toolHost, modelPin),
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

      // The user's per-run model choice ("auto"/absent lets the router pick).
      // Triage ignores it (always local); the work agents are built per run
      // with it, since the pin changes which model they wire.
      const modelPin = input.model;
      const selectionFor = (intent: Intent) => modelSelection(intent, modelPin);

      // The work agents are bound to this run's pin; the executor also to its
      // ToolHost. Workflow assembly is plain object composition, cheap per run.
      const workflow = createDevTeamWorkflow(
        this.agents.triage,
        this.agents.createPlanner(modelPin),
        this.agents.createAnswerer(modelPin),
        this.agents.createExecutor(client.toolHost, modelPin)
      );
      const run = await workflow.createRun();
      activeRun = run;
      if (cancelled) {
        throw new RunCancelledError();
      }

      const translator = new ProgressTranslator(emit, selectionFor);
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
            instructions: input.instructions,
            attachments: input.attachments,
            history: input.history,
            command: input.command,
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
        // engine makes to every client, local or remote. The selection is
        // attached here (deterministic from the route), matching the
        // model-selected event the translator already emitted.
        const reply = ReplySchema.parse(outcome.result);
        return { ...reply, selection: selectionFor(reply.intent) };
      }
      if (outcome.status === 'failed') {
        throw mapFailure(outcome.error, outcome.steps, modelPin);
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
   * The set of Ollama tags installed on the configured server, or undefined
   * when the server could not be reached. Ollama reports untagged pulls as
   * "<model>:latest", so both the tag and its `:latest` alias are stored.
   */
  private async installedOllamaTags(): Promise<Set<string> | undefined> {
    try {
      const res = await fetch(`${settings.ollamaEndpoint}/api/tags`, {
        signal: AbortSignal.timeout(settings.startupProbeTimeoutMs),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const tags = (await res.json()) as TagsResponse;
      return new Set(
        (tags.models ?? [])
          .flatMap((m) => [m.name, m.model])
          .filter((n): n is string => typeof n === 'string')
      );
    } catch {
      return undefined;
    }
  }

  /** Whether `model` (or its ":latest" alias) is in the installed tag set. */
  private static ollamaInstalled(model: string, installed: Set<string>): boolean {
    return installed.has(model) || installed.has(`${model}:latest`);
  }

  /**
   * Ping the configured Ollama endpoint and report (never show - surfacing is
   * the UI's job) whether the server is unreachable or any Auto-routed local
   * model is not pulled, instead of letting the first run be what fails. Cloud
   * models are not Ollama tags, so they are not probed here.
   */
  async startupWarnings(): Promise<string[]> {
    const installed = await this.installedOllamaTags();
    if (!installed) {
      return [messages.startup.unreachable(settings.ollamaEndpoint)];
    }
    const missing = routedModels().filter(
      (model) => !LocalEngine.ollamaInstalled(model, installed)
    );
    return missing.length > 0 ? [messages.startup.missingModels(missing)] : [];
  }

  /**
   * The models the `/model` picker offers: "Auto" first, then every registered
   * model with whether it can run now. An Ollama model is available when it is
   * pulled (probed once here; if the server is unreachable we cannot tell, so
   * we report it available rather than hide it); a cloud model when its API
   * key is set.
   */
  async listModels(): Promise<ModelChoice[]> {
    const installed = await this.installedOllamaTags();
    const auto: ModelChoice = {
      id: AUTO_MODEL,
      label: messages.model.autoLabel,
      description: messages.model.autoDescription,
      available: true,
    };
    const available = (info: ModelInfo): boolean =>
      info.provider === 'ollama'
        ? installed === undefined || LocalEngine.ollamaInstalled(info.model, installed)
        : isModelAvailable(info);
    // One "best available within this provider" choice per provider that has
    // registered models, available when any of its models can run now.
    const providers = [...new Set(modelRegistry.map((m) => m.provider))];
    const providerChoices: ModelChoice[] = providers.map((provider: ProviderName) => ({
      id: `${PROVIDER_PIN_PREFIX}${provider}`,
      label: messages.model.providerLabel(providerLabels[provider]),
      description: messages.model.providerDescription(providerLabels[provider]),
      available: modelRegistry.some((m) => m.provider === provider && available(m)),
    }));
    const models = modelRegistry.map((info) => ({
      id: info.id,
      label: info.label,
      description: info.description,
      available: available(info),
    }));
    return [auto, ...providerChoices, ...models];
  }
}
