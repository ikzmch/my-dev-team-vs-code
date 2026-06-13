import { describe, it, expect } from 'vitest';
import { LocalEngine, LocalEngineAgents } from '../src/engine/localEngine';
import { agents } from '../src/engine/config/agents';
import { selectModel } from '../src/engine/config/models';
import { settings } from '../src/config/settings';
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
import { __reset } from './mocks/vscode';
import { beforeEach } from 'vitest';

beforeEach(() => {
  __reset();
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
    planner: { plan: async () => aPlan } as any,
    answerer: { answer: async () => 'It is 4.' } as any,
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
      plan: aPlan,
      execution: anExecution,
    });
    expect(events[0]).toEqual({ type: 'triaged', intent: 'planning', reason: 'steps' });
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
        planner: {
          plan: async (_p: string, onPartial?: (p: unknown) => void) => {
            for (const partial of planPartials) {
              onPartial?.(partial);
            }
            return aPlan;
          },
        } as any,
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

  it('emits answer deltas, not snapshots, for the oneshot path', async () => {
    const engine = new LocalEngine(
      fakes({
        triage: {
          classify: async () => ({ intent: 'oneshot', reason: 'simple' }),
        } as any,
        answerer: {
          answer: async (_p: string, onPartial?: (text: string) => void) => {
            onPartial?.('It');
            onPartial?.('It is 4.');
            return 'It is 4.';
          },
        } as any,
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
        answerer: { answer: async () => 'ok' } as any,
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
    expect(reply).toEqual({
      intent: 'planning',
      reason: 'Requested via /plan.',
      plan: aPlan,
    });
    expect(events[0]).toEqual({
      type: 'triaged',
      intent: 'planning',
      reason: 'Requested via /plan.',
    });
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
        planner: {
          plan: async () => {
            throw new Error('model not found');
          },
        } as any,
      })
    );

    const events: RunEvent[] = [];
    const outcome = engine.startRun(request(), client(events)).result;
    await expect(outcome).rejects.toBeInstanceOf(RunFailedError);
    const error = await outcome.catch((e) => e as RunFailedError);
    expect(error.step).toBe('plan');
    expect(error.message).toContain('model not found');
    expect(error.hint).toContain(settings.ollamaEndpoint);
    expect(error.hint).toContain(selectModel(agents.planner.capabilities).model);

    // The failure is mirrored onto the event stream for streaming consumers.
    expect(events[events.length - 1]).toMatchObject({
      type: 'error',
      step: 'plan',
      message: expect.stringContaining('model not found'),
    });
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
});
