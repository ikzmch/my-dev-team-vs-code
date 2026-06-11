import { describe, it, expect } from 'vitest';
import { resolveModel } from '../src/core/models';
import { selectModel } from '../src/config/models';
import { agents } from '../src/config/agents';

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
});
