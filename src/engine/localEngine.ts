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
import { Summarizer } from './core/summarizer';
import {
  createDevTeamWorkflow,
  abortSignalKey,
  planReviewKey,
  replyProgressKey,
  stepIds,
  usageSinkKey,
  thinkingSinkKey,
  triageShadowKey,
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
import {
  routeModel,
  routeTriageModel,
  isModelAvailable,
  isModelEnabled,
  isProviderEnabled,
  effectivePin,
  ollamaEndpoint,
} from './core/models';
import { isRateLimited } from './core/rateLimiter';
import { limits } from '../config/limits';
import { messages } from '../config/messages';
import {
  Complexity,
  ComplexitySchema,
  DynamicToolDef,
  ExecutionEvent,
  Intent,
  PartialSummary,
  ModelChoice,
  ModelSelection,
  Plan,
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
 * routes per `myDevTeam.triage.model` (the backend triage config when unset,
 * Ollama by default); like the other agents, only an Ollama choice is an Ollama
 * tag to probe, so a non-Ollama triage/work model is simply left out.
 */
export function routedModels(): string[] {
  const names = new Set<string>();
  const addIfOllama = (info: ModelInfo) => {
    if (info.provider === 'ollama') {
      names.add(info.model);
    }
  };
  addIfOllama(routeTriageModel(agents.triage.capabilities));
  addIfOllama(routeModel(agents.answerer.capabilities));
  // The planner and the executor are both sized by complexity now, so a run can
  // route either to a different Ollama tag per tier; probe all of them so the
  // startup check warns about any that is not pulled.
  for (const complexity of ComplexitySchema.options) {
    addIfOllama(routeModel(agents.planner.capabilities, undefined, undefined, complexity));
    addIfOllama(routeModel(agents.executor.capabilities, undefined, undefined, complexity));
  }
  return [...names];
}

/**
 * Which model each step will use for this run, for the protocol's
 * `model-selected` event and the reply's `selection`. Deterministic from the
 * route and the user's pin, so the streamed event and the final reply always
 * agree. Triage follows `myDevTeam.triage.model` (a local Ollama model by
 * default), not the work pin; the work agents honour the pin (or, in Auto, the
 * best available model). Only the steps the route will run are listed: triage
 * always, then plan+execute, or answer.
 */
export function modelSelection(
  intent: Intent,
  modelPin?: string,
  // Two tiers, because the planner and executor are now sized differently: the
  // planner by triage's pre-exploration guess, the executor by the planner's
  // post-exploration judgement. `planComplexity` is known only after the plan
  // is drafted, so the streamed model-selected event (emitted right after
  // triage) passes only `triageComplexity` and the final reply's selection -
  // computed once the run finishes - corrects the executor entry.
  triageComplexity?: Complexity,
  planComplexity?: Complexity
): ModelSelection {
  // A disabled pin is hard-blocked to Auto, so the reported mode is derived from
  // the *effective* pin - the same value routeModel routes on - keeping the
  // model-selected event and reply honest about what actually ran.
  const pin = effectivePin(modelPin);
  // pinned (a model id) > provider (a "provider:<name>" pin) > auto.
  const providerPin = providerPinOf(pin);
  const mode: ModelSelection['mode'] = modelById(pin)
    ? 'pinned'
    : providerPin
    ? 'provider'
    : 'auto';
  const entry = (step: string, info: ModelInfo) => ({
    step,
    id: info.id,
    label: info.label,
  });
  const models = [entry('triage', routeTriageModel(agents.triage.capabilities))];
  if (intent === 'planning') {
    // The planner is sized by triage's complexity, the executor by the
    // planner's (falling back to triage's until the plan is drafted) - matching
    // the tiers the draft-plan and execute steps build their agents with.
    models.push(
      entry('plan', routeModel(agents.planner.capabilities, modelPin, undefined, triageComplexity))
    );
    models.push(
      entry(
        'execute',
        routeModel(
          agents.executor.capabilities,
          modelPin,
          undefined,
          planComplexity ?? triageComplexity
        )
      )
    );
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
  private summarySeen: string | undefined;

  /**
   * `selectionFor` (when given) maps the decided route and complexity to the
   * run's model selection, so the translator can emit `model-selected` right
   * after the first `triaged` - the route decides which steps run and the
   * complexity sizes the executor's model.
   */
  constructor(
    private readonly emit: (event: RunEvent) => void,
    private readonly selectionFor?: (
      intent: Intent,
      triageComplexity?: Complexity,
      planComplexity?: Complexity
    ) => ModelSelection
  ) {}

  push(progress: ReplyProgress): void {
    if (!this.triaged) {
      this.triaged = true;
      this.emit({
        type: 'triaged',
        intent: progress.intent,
        reason: progress.reason,
        ...(progress.complexity ? { complexity: progress.complexity } : {}),
      });
      if (this.selectionFor) {
        this.emit({
          type: 'model-selected',
          selection: this.selectionFor(progress.intent, progress.complexity),
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
    // The summary streams in as small grow-only snapshots once execution is
    // done; emit each new one (deduplicated, so a re-pushed identical snapshot
    // does not produce a redundant event).
    if (progress.summary) {
      const json = JSON.stringify(progress.summary);
      if (json !== this.summarySeen) {
        this.summarySeen = json;
        this.emit({ type: 'summary-snapshot', summary: progress.summary as PartialSummary });
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
 * used. A persistent rate limit (a 429 that outlasted the retries) points at
 * the throttle setting; otherwise an Ollama model points at the server + tag to
 * pull and a cloud model at its missing/invalid API key. Triage routes per
 * `myDevTeam.triage.model`, so its hint can point at a cloud key too.
 */
function failureHint(agent: AgentName, modelPin?: string, error?: unknown): string {
  const info =
    agent === 'triage'
      ? routeTriageModel(agents.triage.capabilities)
      : routeModel(agents[agent].capabilities, modelPin);
  if (isRateLimited(error)) {
    return messages.rateLimitHint(info.label);
  }
  return info.provider === 'ollama'
    ? messages.ollamaHint(ollamaEndpoint(), info.model)
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
      return new RunFailedError(step, detail, failureHint(agent, modelPin, error));
    }
  }
  return new RunFailedError('triage', detail, failureHint('triage', modelPin, error));
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
  /**
   * Built per run with the request's pin, plus the complexity triage decided -
   * which sizes the planner's model, so it is supplied when the draft-plan step
   * runs, not at run setup (mirroring the executor).
   */
  createPlanner: (modelPin?: string, complexity?: Complexity) => Planner;
  createAnswerer: (modelPin?: string) => Answerer;
  /**
   * Built per run with the request's pin and ToolHost, plus the complexity the
   * triage step decided - which sizes the executor's model, so it is supplied
   * when the execute step runs, not at run setup. The execute step also passes
   * the run's resolved skill bodies so the executor's `skill` tool can serve them.
   */
  createExecutor: (
    toolHost: ToolHost,
    modelPin?: string,
    complexity?: Complexity,
    skillBodies?: ReadonlyMap<string, string>,
    dynamicTools?: readonly DynamicToolDef[]
  ) => Executor;
  /**
   * Built per run with the request's pin to recap an executed plan. Optional so
   * a test agent set that does not exercise the summary can leave it out; the
   * execute step then simply produces no summary.
   */
  createSummarizer?: (modelPin?: string) => Summarizer;
}

function defaultAgents(): LocalEngineAgents {
  return {
    triage: new Triage(),
    createPlanner: (modelPin, complexity) => new Planner(modelPin, complexity),
    createAnswerer: (modelPin) => new Answerer(modelPin),
    createExecutor: (toolHost, modelPin, complexity, skillBodies, dynamicTools) =>
      new Executor(toolHost, modelPin, complexity, skillBodies, dynamicTools),
    createSummarizer: (modelPin) => new Summarizer(modelPin),
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
      // Triage ignores it (it follows its own myDevTeam.triage.model); the work
      // agents are built per run with it, since the pin changes which model they wire.
      const modelPin = input.model;
      const selectionFor = (
        intent: Intent,
        triageComplexity?: Complexity,
        planComplexity?: Complexity
      ) => modelSelection(intent, modelPin, triageComplexity, planComplexity);

      // The work agents are bound to this run's pin; the executor also to its
      // ToolHost. It is passed as a factory because its model is sized by the
      // request's complexity, decided inside the run. Workflow assembly is plain
      // object composition, cheap per run.
      const createSummarizer = this.agents.createSummarizer;
      const workflow = createDevTeamWorkflow(
        this.agents.triage,
        (complexity) => this.agents.createPlanner(modelPin, complexity),
        this.agents.createAnswerer(modelPin),
        (complexity, skillBodies) =>
          this.agents.createExecutor(
            client.toolHost,
            modelPin,
            complexity,
            skillBodies,
            input.dynamicTools
          ),
        createSummarizer ? () => createSummarizer(modelPin) : undefined
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
      // Thinking is a side-channel like usage: forwarded straight to the event
      // stream, never folded into a reply snapshot. The UI shows it as
      // transient progress and drops it when the run produces real output.
      requestContext.set(thinkingSinkKey, (line: string) =>
        emit({ type: 'thinking', text: line })
      );
      requestContext.set(triageShadowKey, (predicted: Intent) =>
        emit({ type: 'triage-shadow', predicted })
      );
      // The plan-approval seam: hand the workflow a handle on the client's
      // reviewPlan, when it offered one. Absent, the draft-plan step never
      // gates and runs straight through - so the gate is purely additive.
      if (client.reviewPlan) {
        requestContext.set(planReviewKey, (plan: Plan, complexity: Complexity) =>
          client.reviewPlan!(plan, complexity)
        );
      }

      let outcome;
      try {
        outcome = await run.start({
          inputData: {
            prompt: input.prompt,
            instructions: input.instructions,
            attachments: input.attachments,
            history: input.history,
            skills: input.skills,
            command: input.command,
            shadowTriage: input.shadowTriage,
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
        // The executor entry is now corrected to the planner's complexity (the
        // streamed model-selected event only had triage's estimate).
        return {
          ...reply,
          selection: selectionFor(reply.intent, reply.complexity, reply.plan?.complexity),
        };
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
      const res = await fetch(`${ollamaEndpoint()}/api/tags`, {
        signal: AbortSignal.timeout(limits.startupProbeTimeoutMs),
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
   *
   * When no agent routes to Ollama at all (e.g. triage and the work agents all
   * resolve to a cloud provider), Ollama is not needed for this configuration,
   * so the probe is skipped entirely and the server's reachability is never
   * mentioned - a fully cloud setup must not warn about an Ollama server it does
   * not use.
   */
  async startupWarnings(): Promise<string[]> {
    const routed = routedModels();
    if (routed.length === 0) {
      return [];
    }
    const installed = await this.installedOllamaTags();
    if (!installed) {
      return [messages.startup.unreachable(ollamaEndpoint())];
    }
    const missing = routed.filter(
      (model) => !LocalEngine.ollamaInstalled(model, installed)
    );
    return missing.length > 0 ? [messages.startup.missingModels(missing)] : [];
  }

  /**
   * The models the `/model` picker offers: "Auto" first, then every registered
   * model with whether it can run now. An Ollama model is available when it is
   * pulled (probed once here; if the server is unreachable we cannot tell, so
   * we report it available rather than hide it); a cloud model when its API
   * key is set. A model/provider disabled at either layer (the backend floor or
   * the user's settings) is flagged `disabled` and reported unavailable, so the
   * picker shows it greyed out rather than letting the user pin something that
   * is hard-blocked from running.
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
    // registered models, available when any of its models can run now. A
    // disabled provider is flagged and never available.
    const providers = [...new Set(modelRegistry.map((m) => m.provider))];
    const providerChoices: ModelChoice[] = providers.map((provider: ProviderName) => {
      const disabled = !isProviderEnabled(provider);
      return {
        id: `${PROVIDER_PIN_PREFIX}${provider}`,
        label: messages.model.providerLabel(providerLabels[provider]),
        description: messages.model.providerDescription(providerLabels[provider]),
        available:
          !disabled && modelRegistry.some((m) => m.provider === provider && available(m)),
        ...(disabled ? { disabled: true } : {}),
      };
    });
    const models = modelRegistry.map((info) => {
      const disabled = !isModelEnabled(info);
      return {
        id: info.id,
        label: info.label,
        description: info.description,
        available: !disabled && available(info),
        ...(disabled ? { disabled: true } : {}),
      };
    });
    return [auto, ...providerChoices, ...models];
  }
}
