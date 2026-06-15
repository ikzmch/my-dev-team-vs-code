import { describe, it, expect, afterEach, vi } from 'vitest';
import { LocalEngine, LocalEngineAgents, modelSelection } from '../src/engine/localEngine';
import { agents } from '../src/engine/config/agents';
import { routeModel, ollamaEndpoint } from '../src/engine/core/models';
import { credentials } from '../src/config/credentials';
import {
  PROTOCOL_VERSION,
  Reply,
  RunRequest,
} from '../src/protocol/types';
import { RunEvent, ReplyFolder } from '../src/protocol/events';
import { ToolHost } from '../src/protocol/toolContract';
import {
  RunCancelledError,
  RunFailedError,
  RunClient,
} from '../src/protocol/engine';
import { __reset, __setConfig } from './mocks/vscode';
import { beforeEach } from 'vitest';

beforeEach(() => {
  __reset();
  // Routing must not depend on the developer's machine: a cloud key in the
  // environment would make Auto prefer that provider's model and change which
  // model the failure hints name. Clear them so Auto routes to Ollama here.
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.GROQ_API_KEY;
});

const hostStub: ToolHost = {
  tools: ['read', 'search', 'run', 'write', 'edit'],
  execute: async () => 'ok',
};

const aPlan = {
  summary: 'Add a feature',
  steps: [{ title: 'Find the file', detail: 'locate it' }],
};

const anExecution = {
  events: [
    { kind: 'tool' as const, tool: 'search', input: '*', result: 'src/a.ts' },
    { kind: 'text' as const, text: 'Done.' },
  ],
};

function fakes(overrides: Partial<LocalEngineAgents> = {}): LocalEngineAgents {
  return {
    triage: {
      classify: async () => ({ intent: 'planning', reason: 'steps' }),
    } as any,
    createPlanner: () => ({ plan: async () => aPlan } as any),
    createAnswerer: () => ({ answer: async () => 'It is 4.' } as any),
    createExecutor: () => ({ execute: async () => anExecution } as any),
    ...overrides,
  };
}

function request(overrides: Partial<RunRequest> = {}): RunRequest {
  return {
    protocolVersion: PROTOCOL_VERSION,
    prompt: 'add a feature',
    offeredTools: [...hostStub.tools],
    ...overrides,
  };
}

function client(events: RunEvent[]): RunClient {
  return { onEvent: (event) => events.push(event), toolHost: hostStub };
}

describe('LocalEngine.startRun', () => {
  it('resolves the validated reply and mirrors it as a done event', async () => {
    const events: RunEvent[] = [];
    const handle = new LocalEngine(fakes()).startRun(request(), client(events));

    const reply = await handle.result;
    expect(reply).toEqual({
      intent: 'planning',
      reason: 'steps',
      selection: modelSelection('planning'),
      plan: aPlan,
      execution: anExecution,
    });
    expect(events[0]).toEqual({ type: 'triaged', intent: 'planning', reason: 'steps' });
    // The model selection is emitted right after triage, in Auto mode here.
    expect(events[1]).toEqual({
      type: 'model-selected',
      selection: modelSelection('planning'),
    });
    expect(events[events.length - 1]).toEqual({ type: 'done', reply });
  });

  it('translates streamed snapshots into events a folder reproduces exactly', async () => {
    // The property the whole protocol hangs on: fold(translate(snapshots))
    // must equal the snapshots, so a client rendering from events renders
    // exactly what the old direct-sink wiring rendered.
    const planPartials = [
      { summary: 'Add' },
      { summary: 'Add a feature', steps: [{ title: 'Find the file' }] },
    ];
    const executionPartials = [
      { events: [{ kind: 'tool' as const, tool: 'search', input: '*' }] },
      {
        events: [
          { kind: 'tool' as const, tool: 'search', input: '*', result: 'src/a.ts' },
          { kind: 'text' as const, text: 'Done.' },
        ],
      },
    ];
    const engine = new LocalEngine(
      fakes({
        createPlanner: () =>
          ({
            plan: async (_p: string, onPartial?: (p: unknown) => void) => {
              for (const partial of planPartials) {
                onPartial?.(partial);
              }
              return aPlan;
            },
          } as any),
        createExecutor: () =>
          ({
            execute: async (_p: string, onPartial?: (p: unknown) => void) => {
              for (const partial of executionPartials) {
                onPartial?.(partial);
              }
              return anExecution;
            },
          } as any),
      })
    );

    const events: RunEvent[] = [];
    const reply = await engine.startRun(request(), client(events)).result;

    const folder = new ReplyFolder();
    let folded;
    for (const event of events) {
      folded = folder.apply(event) ?? folded;
    }
    expect(folded).toEqual({
      intent: 'planning',
      reason: 'steps',
      selection: modelSelection('planning'),
      plan: aPlan,
      execution: anExecution,
    });
    expect(reply.execution).toEqual(anExecution);

    // Execution changes arrive as indexed events: the open call, its
    // completion (same index re-sent), then the appended text event.
    const executionEvents = events.filter((e) => e.type === 'execution-event');
    expect(executionEvents).toEqual([
      { type: 'execution-event', index: 0, event: { kind: 'tool', tool: 'search', input: '*' } },
      {
        type: 'execution-event',
        index: 0,
        event: { kind: 'tool', tool: 'search', input: '*', result: 'src/a.ts' },
      },
      { type: 'execution-event', index: 1, event: { kind: 'text', text: 'Done.' } },
    ]);
  });

  it('emits summary snapshots after a file-changing run and folds them back', async () => {
    const executionWithWrite = {
      events: [
        { kind: 'tool' as const, tool: 'write', input: 'a.ts', result: 'Wrote a.ts (5 bytes).' },
        { kind: 'text' as const, text: 'Done.' },
      ],
    };
    const summaryPartials = [
      { whatShips: 'A feature' },
      { whatShips: 'A feature', howItsBuilt: 'a module', testsAndDocs: 'tests' },
    ];
    const summary = { whatShips: 'A feature', howItsBuilt: 'a module', testsAndDocs: 'tests' };
    const engine = new LocalEngine(
      fakes({
        createExecutor: () => ({ execute: async () => executionWithWrite } as any),
        createSummarizer: () =>
          ({
            summarize: async (_p: string, onPartial?: (s: unknown) => void) => {
              for (const partial of summaryPartials) {
                onPartial?.(partial);
              }
              return summary;
            },
          } as any),
      })
    );

    const events: RunEvent[] = [];
    const reply = await engine.startRun(request(), client(events)).result;

    expect(reply.summary).toEqual(summary);
    const summaryEvents = events.filter((e) => e.type === 'summary-snapshot');
    expect(summaryEvents).toEqual([
      { type: 'summary-snapshot', summary: summaryPartials[0] },
      { type: 'summary-snapshot', summary: summaryPartials[1] },
    ]);

    // Folding the whole stream reproduces the summary on the snapshot.
    const folder = new ReplyFolder();
    let folded;
    for (const event of events) {
      folded = folder.apply(event) ?? folded;
    }
    expect(folded?.summary).toEqual(summary);
  });

  it('emits answer deltas, not snapshots, for the oneshot path', async () => {
    const engine = new LocalEngine(
      fakes({
        triage: {
          classify: async () => ({ intent: 'oneshot', reason: 'simple' }),
        } as any,
        createAnswerer: () =>
          ({
            answer: async (_p: string, onPartial?: (text: string) => void) => {
              onPartial?.('It');
              onPartial?.('It is 4.');
              return 'It is 4.';
            },
          } as any),
      })
    );

    const events: RunEvent[] = [];
    await engine.startRun(request(), client(events)).result;

    expect(events.filter((e) => e.type === 'answer-delta')).toEqual([
      { type: 'answer-delta', text: 'It' },
      { type: 'answer-delta', text: ' is 4.' },
    ]);
  });

  it('forwards step usage reports as usage events', async () => {
    const engine = new LocalEngine(
      fakes({
        triage: {
          classify: async (_p: string, onUsage?: (u: unknown) => void) => {
            onUsage?.({ model: 'm1', inputTokens: 2, outputTokens: 3 });
            return { intent: 'oneshot', reason: 'simple' };
          },
        } as any,
        createAnswerer: () => ({ answer: async () => 'ok' } as any),
      })
    );

    const events: RunEvent[] = [];
    await engine.startRun(request(), client(events)).result;

    expect(events.filter((e) => e.type === 'usage')).toEqual([
      { type: 'usage', step: 'triage', model: 'm1', inputTokens: 2, outputTokens: 3 },
    ]);
  });

  it('pins the route from the request slash command without calling triage', async () => {
    let triageCalled = false;
    const engine = new LocalEngine(
      fakes({
        triage: {
          classify: async () => {
            triageCalled = true;
            return { intent: 'oneshot', reason: 'should not run' };
          },
        } as any,
      })
    );

    const events: RunEvent[] = [];
    const reply = await engine
      .startRun(request({ command: 'plan' }), client(events))
      .result;

    expect(triageCalled).toBe(false);
    // /plan stops after drafting: the reply carries the plan, no transcript.
    // The command supplies the complexity (moderate by default) since triage
    // is skipped.
    expect(reply).toEqual({
      intent: 'planning',
      complexity: 'moderate',
      reason: 'Requested via /plan.',
      selection: modelSelection('planning', undefined, 'moderate'),
      plan: aPlan,
    });
    expect(events[0]).toEqual({
      type: 'triaged',
      intent: 'planning',
      complexity: 'moderate',
      reason: 'Requested via /plan.',
    });
  });

  it('shadow-runs triage on a pinned command and emits the prediction', async () => {
    let triageCalled = false;
    const engine = new LocalEngine(
      fakes({
        triage: {
          classify: async () => {
            triageCalled = true;
            return { intent: 'oneshot', reason: 'would oneshot' };
          },
        } as any,
      })
    );

    const events: RunEvent[] = [];
    const reply = await engine
      .startRun(request({ command: 'plan', shadowTriage: true }), client(events))
      .result;

    expect(triageCalled).toBe(true);
    // The pinned /plan route still wins; triage only shadows.
    expect(reply.intent).toBe('planning');
    expect(events).toContainEqual({ type: 'triage-shadow', predicted: 'oneshot' });
  });

  it('binds the executor to the ToolHost the client handed in', async () => {
    let receivedHost: ToolHost | undefined;
    const engine = new LocalEngine(
      fakes({
        createExecutor: (host) => {
          receivedHost = host;
          return { execute: async () => anExecution } as any;
        },
      })
    );

    await engine.startRun(request(), client([])).result;
    expect(receivedHost).toBe(hostStub);
  });

  it('maps a failed step onto the protocol step with the Ollama hint', async () => {
    const engine = new LocalEngine(
      fakes({
        createPlanner: () =>
          ({
            plan: async () => {
              throw new Error('model not found');
            },
          } as any),
      })
    );

    const events: RunEvent[] = [];
    const outcome = engine.startRun(request(), client(events)).result;
    await expect(outcome).rejects.toBeInstanceOf(RunFailedError);
    const error = await outcome.catch((e) => e as RunFailedError);
    expect(error.step).toBe('plan');
    expect(error.message).toContain('model not found');
    expect(error.hint).toContain(ollamaEndpoint());
    expect(error.hint).toContain(routeModel(agents.planner.capabilities).model);

    // The failure is mirrored onto the event stream for streaming consumers.
    expect(events[events.length - 1]).toMatchObject({
      type: 'error',
      step: 'plan',
      message: expect.stringContaining('model not found'),
    });
  });

  it('maps a persistent rate limit onto the rate-limit hint', async () => {
    const engine = new LocalEngine(
      fakes({
        createPlanner: () =>
          ({
            plan: async () => {
              // Shape of a 429 that outlasted the retries (Mastra serialises it
              // to a plain message by the time the engine maps the failure).
              throw new Error('Rate limit reached for model, status code 429');
            },
          } as any),
      })
    );

    const outcome = engine.startRun(request(), client([])).result;
    const error = await outcome.catch((e) => e as RunFailedError);
    expect(error.step).toBe('plan');
    // Points at the throttle setting, not the API-key / Ollama hints.
    expect(error.hint).toContain('myDevTeam.provider.requestsPerMinute');
    expect(error.hint).not.toContain(ollamaEndpoint());
  });

  it('rejects a protocol version it does not speak', async () => {
    const handle = new LocalEngine(fakes()).startRun(
      request({ protocolVersion: 99 }),
      client([])
    );
    await expect(handle.result).rejects.toThrow(/version 99/);
  });

  it('cancel() rejects the result with RunCancelledError and no error event', async () => {
    let release: () => void = () => {};
    const engine = new LocalEngine(
      fakes({
        triage: {
          classify: () =>
            new Promise((resolve) => {
              release = () =>
                resolve({ intent: 'oneshot', reason: 'late' });
            }),
        } as any,
      })
    );

    const events: RunEvent[] = [];
    const handle = engine.startRun(request(), client(events));
    handle.cancel();
    release();

    await expect(handle.result).rejects.toBeInstanceOf(RunCancelledError);
    expect(events.filter((e) => e.type === 'error')).toEqual([]);
  });

  it('survives a client sink that throws', async () => {
    const engine = new LocalEngine(fakes());
    const handle = engine.startRun(request(), {
      toolHost: hostStub,
      onEvent: () => {
        throw new Error('broken sink');
      },
    });
    await expect(handle.result).resolves.toMatchObject({ intent: 'planning' });
  });

  it('reports a pinned model for the work agents but keeps triage local', async () => {
    const events: RunEvent[] = [];
    const reply = await new LocalEngine(fakes())
      .startRun(request({ model: 'anthropic-opus' }), client(events))
      .result;

    expect(reply.selection?.mode).toBe('pinned');
    expect(reply.selection?.models.find((m) => m.step === 'plan')?.id).toBe(
      'anthropic-opus'
    );
    expect(reply.selection?.models.find((m) => m.step === 'execute')?.id).toBe(
      'anthropic-opus'
    );
    // The pin never reaches triage - it stays on a local Ollama model.
    expect(reply.selection?.models.find((m) => m.step === 'triage')?.id).not.toBe(
      'anthropic-opus'
    );
  });

  it('reports a provider pin as provider mode and routes within it per agent', async () => {
    const events: RunEvent[] = [];
    const reply = await new LocalEngine(fakes())
      .startRun(request({ model: 'provider:anthropic' }), client(events))
      .result;

    expect(reply.selection?.mode).toBe('provider');
    expect(reply.selection?.provider).toBe('Anthropic');
    // The plan/execute models are Anthropic ones (ids start with "anthropic-").
    for (const step of ['plan', 'execute'] as const) {
      expect(reply.selection?.models.find((m) => m.step === step)?.id).toMatch(
        /^anthropic-/
      );
    }
    // Triage stays local.
    expect(reply.selection?.models.find((m) => m.step === 'triage')?.id).not.toMatch(
      /^anthropic-/
    );
  });
});

describe('modelSelection complexity', () => {
  const entryId = (sel: ReturnType<typeof modelSelection>, step: string) =>
    sel.models.find((m) => m.step === step)!.id;

  it('sizes the executor by the plan complexity (the 4th arg), not triage', () => {
    // Same planner judgement, different triage guess: the executor is the same.
    const a = modelSelection('planning', undefined, 'simple', 'complex');
    const b = modelSelection('planning', undefined, 'complex', 'complex');
    expect(entryId(a, 'execute')).toBe(entryId(b, 'execute'));
    // A different planner judgement moves the executor model.
    const simplePlan = modelSelection('planning', undefined, 'simple', 'simple');
    expect(entryId(simplePlan, 'execute')).not.toBe(entryId(a, 'execute'));
  });

  it('falls back to the triage complexity for the executor before a plan exists', () => {
    // The streamed model-selected event (emitted right after triage) has only
    // triage's tier; it must match what a plan of the same tier would route to.
    const byTriage = modelSelection('planning', undefined, 'complex');
    const byPlan = modelSelection('planning', undefined, 'simple', 'complex');
    expect(entryId(byTriage, 'execute')).toBe(entryId(byPlan, 'execute'));
  });

  it('sizes the planner by the triage complexity, independent of the plan complexity', () => {
    // The plan entry tracks the 3rd arg (triage) and ignores the 4th (plan).
    const a = modelSelection('planning', undefined, 'simple', 'simple');
    const b = modelSelection('planning', undefined, 'simple', 'complex');
    expect(entryId(a, 'plan')).toBe(entryId(b, 'plan'));
  });

  it('ignores complexity on the oneshot route (no executor runs)', () => {
    const answer = modelSelection('oneshot', undefined, 'complex');
    expect(answer.models.some((m) => m.step === 'execute')).toBe(false);
  });

  it('reports auto when a pinned model is disabled (hard-blocked)', () => {
    // Pinning anthropic-opus would normally be mode "pinned"; disabling it drops
    // the pin so the reported mode and the routed model both become Auto.
    const pinned = modelSelection('oneshot', 'anthropic-opus');
    expect(pinned.mode).toBe('pinned');
    __setConfig('myDevTeam.disabledModels', ['anthropic-opus']);
    const blocked = modelSelection('oneshot', 'anthropic-opus');
    expect(blocked.mode).toBe('auto');
    expect(blocked.models.find((m) => m.step === 'answer')!.id).not.toBe('anthropic-opus');
  });

  it('reports auto when a pinned provider is disabled', () => {
    __setConfig('myDevTeam.disabledProviders', ['anthropic']);
    const blocked = modelSelection('oneshot', 'provider:anthropic');
    expect(blocked.mode).toBe('auto');
    expect(blocked.provider).toBeUndefined();
  });
});

describe('LocalEngine.listModels', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('lists Auto first, then every registered model with availability', async () => {
    // Unreachable Ollama: we cannot tell what is pulled, so local models are
    // reported available rather than hidden.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('down');
      })
    );
    const choices = await new LocalEngine(fakes()).listModels();

    expect(choices[0].id).toBe('auto');
    expect(choices[0].available).toBe(true);
    // One "best available" entry per provider, available when any of its
    // models can run now (Ollama always; cloud when keyed).
    expect(choices.find((c) => c.id === 'provider:ollama')?.available).toBe(true);
    expect(choices.find((c) => c.id === 'provider:anthropic')?.available).toBe(
      credentials.has('anthropic')
    );
    expect(choices.find((c) => c.id === 'qwen3-coder')?.available).toBe(true);
    // A cloud model is available exactly when its key is configured.
    expect(choices.find((c) => c.id === 'anthropic-opus')?.available).toBe(
      credentials.has('anthropic')
    );
    expect(choices.find((c) => c.id === 'openai-gpt41')?.available).toBe(
      credentials.has('openai')
    );
  });

  it('marks a disabled provider and its models as disabled and unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('down');
      })
    );
    __setConfig('myDevTeam.disabledProviders', ['anthropic']);
    const choices = await new LocalEngine(fakes()).listModels();

    const provider = choices.find((c) => c.id === 'provider:anthropic');
    expect(provider?.disabled).toBe(true);
    expect(provider?.available).toBe(false);
    const opus = choices.find((c) => c.id === 'anthropic-opus');
    expect(opus?.disabled).toBe(true);
    expect(opus?.available).toBe(false);
    // An enabled model carries no disabled flag.
    expect(choices.find((c) => c.id === 'qwen3-coder')?.disabled).toBeUndefined();
  });

  it('marks a single disabled model without touching its provider', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('down');
      })
    );
    __setConfig('myDevTeam.disabledModels', ['qwen3-coder']);
    const choices = await new LocalEngine(fakes()).listModels();

    expect(choices.find((c) => c.id === 'qwen3-coder')?.disabled).toBe(true);
    expect(choices.find((c) => c.id === 'qwen3-coder')?.available).toBe(false);
    expect(choices.find((c) => c.id === 'provider:ollama')?.disabled).toBeUndefined();
  });
});
