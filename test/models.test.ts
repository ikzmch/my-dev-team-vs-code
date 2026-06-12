import { describe, it, expect, beforeEach } from 'vitest';
import { resolveModel } from '../src/core/models';
import { selectModel } from '../src/config/models';
import { agents } from '../src/config/agents';
import { __reset, __setConfig } from './mocks/vscode';

beforeEach(() => {
  __reset();
});

describe('resolveModel', () => {
  it('memoises the instance per registered model', () => {
    const first = resolveModel(agents.triage.capabilities);
    const second = resolveModel(agents.triage.capabilities);
    expect(second).toBe(first);
  });

  it('wires the instance for the model the selection picked', () => {
    for (const requirements of [
      agents.triage.capabilities,
      agents.planner.capabilities,
    ]) {
      const info = selectModel(requirements);
      // The AI SDK model exposes the provider-specific model id.
      expect(resolveModel(requirements).modelId).toBe(info.model);
    }
  });

  it('rewires the instance when the endpoint setting changes', () => {
    const before = resolveModel(agents.triage.capabilities);
    __setConfig('myDevTeam.ollama.endpoint', 'http://gpu-box:11434');
    const after = resolveModel(agents.triage.capabilities);
    // Same routed model, but a fresh instance wired to the new endpoint - a
    // memoised model must never outlive an endpoint change.
    expect(after).not.toBe(before);
    expect(after.modelId).toBe(before.modelId);
  });

  it('keeps memoising under the new endpoint after a change', () => {
    resolveModel(agents.triage.capabilities);
    __setConfig('myDevTeam.ollama.endpoint', 'http://gpu-box:11434');
    const first = resolveModel(agents.triage.capabilities);
    const second = resolveModel(agents.triage.capabilities);
    expect(second).toBe(first);
  });
});
