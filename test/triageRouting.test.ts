import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the bundled backend config so we can drive agents.triage.model per test.
// The object is created in a hoisted block (vi.mock factories run before the
// module imports), and mutated in beforeEach / each test.
const { fakeBackend } = vi.hoisted(() => ({
  fakeBackend: {
    models: { disabledProviders: [] as string[], disabledModels: [] as string[] },
    providers: { ollama: {}, openai: {}, anthropic: {}, groq: {} },
    agents: { triage: { model: 'ollama' } },
  },
}));
vi.mock('../src/engine/config/backend', () => ({ backendConfig: fakeBackend }));

import { triageRouting, routeTriageModel } from '../src/engine/core/models';
import { agents } from '../src/engine/config/agents';
import { __reset } from './mocks/vscode';

beforeEach(() => {
  __reset();
  fakeBackend.models.disabledProviders = [];
  fakeBackend.models.disabledModels = [];
  fakeBackend.agents.triage.model = 'ollama';
});

describe('triageRouting', () => {
  it('defaults to the "ollama" provider: no pin, local candidates', () => {
    const { pin, candidates } = triageRouting();
    expect(pin).toBeUndefined();
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.every((m) => m.provider === 'ollama')).toBe(true);
    // Routed by the triage capability profile, the pick is a local model.
    expect(routeTriageModel(agents.triage.capabilities).provider).toBe('ollama');
  });

  it('pins an exact registered model id', () => {
    fakeBackend.agents.triage.model = 'anthropic-opus';
    const { pin } = triageRouting();
    expect(pin).toBe('anthropic-opus');
    // A pin wins outright, regardless of the triage capability weights.
    expect(routeTriageModel(agents.triage.capabilities).id).toBe('anthropic-opus');
  });

  it('routes by capability within a named provider', () => {
    fakeBackend.agents.triage.model = 'anthropic';
    const { pin, candidates } = triageRouting();
    expect(pin).toBeUndefined();
    expect(candidates.every((m) => m.provider === 'anthropic')).toBe(true);
    expect(routeTriageModel(agents.triage.capabilities).provider).toBe('anthropic');
  });

  it('falls back to local models for an unknown choice', () => {
    fakeBackend.agents.triage.model = 'not-a-real-thing';
    expect(triageRouting().candidates.every((m) => m.provider === 'ollama')).toBe(true);
  });

  it('falls back to local models when the named provider has nothing enabled', () => {
    fakeBackend.agents.triage.model = 'anthropic';
    fakeBackend.models.disabledProviders = ['anthropic'];
    expect(triageRouting().candidates.every((m) => m.provider === 'ollama')).toBe(true);
  });
});
