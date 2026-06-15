import { describe, it, expect, vi } from 'vitest';
import { SidecarEngine } from '../src/client/sidecarEngine';
import { createChildRuntime } from '../src/sidecar/childRuntime';
import { SidecarChannel, ParentMessage, ChildMessage } from '../src/sidecar/transport';
import {
  Engine,
  RunClient,
  RunHandle,
  RunFailedError,
  RunCancelledError,
} from '../src/protocol/engine';
import { RunRequest, Reply, ModelChoice, PlanDecision, Plan } from '../src/protocol/types';
import { RuntimeConfig } from '../src/config/runtimeConfig';

/**
 * Wire a SidecarEngine to a child runtime hosting `engine`, entirely in-process
 * (no fork), so the full message round trip and the tool/plan inversions are
 * exercised without spawning anything. Parent posts reach the child handler;
 * child posts reach the SidecarEngine's message handler.
 */
function connect(engine: Engine): { sidecar: SidecarEngine; configs: RuntimeConfig[] } {
  const configs: RuntimeConfig[] = [];
  let onChildMessage: (m: ChildMessage) => void = () => {};
  const childHandle = createChildRuntime(
    (m: ChildMessage) => onChildMessage(m),
    () => engine
  );
  const channel: SidecarChannel = {
    post: (m: ParentMessage) => {
      if (m.t === 'config') {
        configs.push(m.config);
      }
      childHandle(m);
    },
    onMessage: (h) => {
      onChildMessage = h;
    },
    onClose: () => {},
    dispose: () => {},
  };
  const getConfig = (): RuntimeConfig => ({
    ollamaEndpoint: undefined,
    providerBaseUrls: {},
    disabledProviders: [],
    disabledModels: [],
    triageModel: '',
    complexityRoutingEnabled: true,
    requestsPerMinute: undefined,
    toolSnippetLines: 5,
    planApproval: 'auto',
    thinkingShowInChat: true,
    summaryShowInChat: true,
  });
  return { sidecar: new SidecarEngine(channel, getConfig), configs };
}

const REPLY = { intent: 'planning', reason: 'r', answer: 'done' } as unknown as Reply;

function request(): RunRequest {
  return { protocolVersion: 1, prompt: 'hi', offeredTools: ['read'] } as RunRequest;
}

/** A controllable engine for the child to host. */
class FakeEngine implements Engine {
  readonly kind = 'local';
  constructor(
    private readonly run: (request: RunRequest, client: RunClient) => Promise<Reply>
  ) {}
  startRun(req: RunRequest, client: RunClient): RunHandle {
    const controller = new AbortController();
    const result = this.run(req, { ...client });
    return { result, cancel: () => controller.abort() };
  }
  async listModels(): Promise<ModelChoice[]> {
    return [{ id: 'auto', label: 'Auto', available: true } as ModelChoice];
  }
  async startupWarnings(): Promise<string[]> {
    return ['ollama down'];
  }
}

describe('sidecar round trip', () => {
  it('injects the runtime config to the child on connect', () => {
    const { configs } = connect(new FakeEngine(async () => REPLY));
    expect(configs).toHaveLength(1);
    expect(configs[0].planApproval).toBe('auto');
  });

  it('streams events and settles the result with the reply', async () => {
    const engine = new FakeEngine(async (_req, client) => {
      client.onEvent({ type: 'triaged', intent: 'planning', reason: 'r' });
      client.onEvent({ type: 'answer-delta', text: 'hello' });
      client.onEvent({ type: 'done', reply: REPLY });
      return REPLY;
    });
    const { sidecar } = connect(engine);
    const events: string[] = [];
    const handle = sidecar.startRun(request(), {
      onEvent: (e) => events.push(e.type),
      toolHost: { tools: [], execute: async () => '' },
    });
    await expect(handle.result).resolves.toEqual(REPLY);
    expect(events).toEqual(['triaged', 'answer-delta', 'done']);
  });

  it('inverts a tool call through the client toolHost', async () => {
    const execute = vi.fn(async (tool: string) => `ran:${tool}`);
    const engine = new FakeEngine(async (_req, client) => {
      const out = await client.toolHost.execute('read', { path: 'a.ts' });
      client.onEvent({ type: 'answer-delta', text: out });
      return REPLY;
    });
    const { sidecar } = connect(engine);
    const deltas: string[] = [];
    const handle = sidecar.startRun(request(), {
      onEvent: (e) => {
        if (e.type === 'answer-delta') deltas.push(e.text);
      },
      toolHost: { tools: ['read'], execute },
    });
    await handle.result;
    // The engine's tool call ran on the client side and the result came back.
    expect(execute).toHaveBeenCalledWith('read', { path: 'a.ts' }, expect.anything(), expect.any(String));
    expect(deltas).toEqual(['ran:read']);
  });

  it('inverts a plan review through the client reviewPlan', async () => {
    const reviewPlan = vi.fn(async (): Promise<PlanDecision> => ({ kind: 'approve' }));
    const engine = new FakeEngine(async (_req, client) => {
      const decision = await client.reviewPlan!({ summary: 's', steps: [] } as unknown as Plan, 'complex');
      client.onEvent({ type: 'answer-delta', text: decision.kind });
      return REPLY;
    });
    const { sidecar } = connect(engine);
    const deltas: string[] = [];
    const handle = sidecar.startRun(request(), {
      onEvent: (e) => {
        if (e.type === 'answer-delta') deltas.push(e.text);
      },
      toolHost: { tools: [], execute: async () => '' },
      reviewPlan,
    });
    await handle.result;
    expect(reviewPlan).toHaveBeenCalledWith(expect.objectContaining({ summary: 's' }), 'complex');
    expect(deltas).toEqual(['approve']);
  });

  it('does not offer the plan-review seam when the client lacks it', async () => {
    const engine = new FakeEngine(async (_req, client) => {
      expect(client.reviewPlan).toBeUndefined();
      return REPLY;
    });
    const { sidecar } = connect(engine);
    const handle = sidecar.startRun(request(), {
      onEvent: () => {},
      toolHost: { tools: [], execute: async () => '' },
    });
    await expect(handle.result).resolves.toEqual(REPLY);
  });

  it('rethrows a RunFailedError with its step and hint preserved', async () => {
    const engine = new FakeEngine(async () => {
      throw new RunFailedError('plan', 'model not found', 'pull the model');
    });
    const { sidecar } = connect(engine);
    const handle = sidecar.startRun(request(), {
      onEvent: () => {},
      toolHost: { tools: [], execute: async () => '' },
    });
    const err = await handle.result.catch((e) => e as RunFailedError);
    expect(err).toBeInstanceOf(RunFailedError);
    expect(err.step).toBe('plan');
    expect(err.hint).toBe('pull the model');
  });

  it('rethrows a RunCancelledError', async () => {
    const engine = new FakeEngine(async () => {
      throw new RunCancelledError();
    });
    const { sidecar } = connect(engine);
    const handle = sidecar.startRun(request(), {
      onEvent: () => {},
      toolHost: { tools: [], execute: async () => '' },
    });
    await expect(handle.result).rejects.toBeInstanceOf(RunCancelledError);
  });

  it('round-trips listModels and startupWarnings', async () => {
    const { sidecar } = connect(new FakeEngine(async () => REPLY));
    await expect(sidecar.listModels()).resolves.toEqual([
      { id: 'auto', label: 'Auto', available: true },
    ]);
    await expect(sidecar.startupWarnings()).resolves.toEqual(['ollama down']);
  });
});
