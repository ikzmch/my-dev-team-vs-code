import { describe, it, expect, beforeEach } from 'vitest';
import {
  resolveModel,
  routeModel,
  localModels,
  availableModels,
  isModelAvailable,
} from '../src/engine/core/models';
import {
  selectModel,
  modelById,
  modelRegistry,
} from '../src/engine/config/models';
import { agents } from '../src/engine/config/agents';
import { credentials } from '../src/config/credentials';
import { __reset, __setConfig } from './mocks/vscode';

beforeEach(() => {
  __reset();
});

describe('selectModel', () => {
  it('returns a pinned model outright, ignoring weights and candidates', () => {
    const pinned = selectModel(agents.triage.capabilities, 'anthropic-opus', localModels());
    expect(pinned.id).toBe('anthropic-opus');
  });

  it('falls back to the best weighted fit for "auto" or an unknown pin', () => {
    const auto = selectModel(agents.executor.capabilities, 'auto', localModels());
    const unknown = selectModel(agents.executor.capabilities, 'nope', localModels());
    // Among the local models, the coding-heavy executor profile picks the coder.
    expect(auto.id).toBe('qwen3-coder');
    expect(unknown.id).toBe('qwen3-coder');
  });

  it('restricts the weighted choice to the candidate list', () => {
    const only8b = selectModel(agents.executor.capabilities, undefined, [
      modelById('qwen3-8b')!,
    ]);
    expect(only8b.id).toBe('qwen3-8b');
  });

  it('a provider pin routes by weight within that provider only', () => {
    const exec = selectModel(agents.executor.capabilities, 'provider:anthropic');
    const answer = selectModel(agents.answerer.capabilities, 'provider:anthropic');
    // Every choice is an Anthropic model, but the per-agent pick can differ.
    expect(exec.provider).toBe('anthropic');
    expect(answer.provider).toBe('anthropic');
    expect(exec.id).toBe('anthropic-opus'); // coding-heavy profile
  });

  it('a provider pin ignores the candidate list and availability', () => {
    // Pinning openai still picks an openai model even though only qwen is a
    // candidate and no key is configured (it bypasses availability, like a
    // model pin - the run then fails with a key hint if the key is missing).
    const picked = selectModel(agents.planner.capabilities, 'provider:openai', [
      modelById('qwen3-8b')!,
    ]);
    expect(picked.provider).toBe('openai');
  });

  it('an unknown provider pin degrades to the candidate weighted fit', () => {
    const picked = selectModel(agents.planner.capabilities, 'provider:nope', localModels());
    expect(picked.provider).toBe('ollama');
  });
});

describe('availability', () => {
  it('treats every Ollama model as available and a cloud model only when keyed', () => {
    for (const info of modelRegistry) {
      expect(isModelAvailable(info)).toBe(
        info.provider === 'ollama' ? true : credentials.has(info.provider)
      );
    }
  });

  it('localModels is exactly the Ollama-provider subset of the registry', () => {
    expect(localModels().every((m) => m.provider === 'ollama')).toBe(true);
    expect(localModels()).toHaveLength(
      modelRegistry.filter((m) => m.provider === 'ollama').length
    );
  });

  it('availableModels never includes a cloud model without its key', () => {
    for (const info of availableModels()) {
      if (info.provider !== 'ollama') {
        expect(credentials.has(info.provider)).toBe(true);
      }
    }
  });
});

describe('resolveModel', () => {
  it('memoises the instance per registered model', () => {
    const first = resolveModel(agents.triage.capabilities, undefined, localModels());
    const second = resolveModel(agents.triage.capabilities, undefined, localModels());
    expect(second).toBe(first);
  });

  it('wires the instance for the model the route picked', () => {
    for (const requirements of [agents.triage.capabilities, agents.planner.capabilities]) {
      const info = routeModel(requirements, undefined, localModels());
      // The AI SDK model exposes the provider-specific model id.
      expect(resolveModel(requirements, undefined, localModels()).modelId).toBe(info.model);
    }
  });

  it('wires the pinned model when one is given', () => {
    expect(resolveModel(agents.triage.capabilities, 'anthropic-opus').modelId).toBe(
      'claude-opus-4-8'
    );
  });

  it('rewires the instance when the endpoint setting changes', () => {
    const before = resolveModel(agents.triage.capabilities, undefined, localModels());
    __setConfig('myDevTeam.ollama.endpoint', 'http://gpu-box:11434');
    const after = resolveModel(agents.triage.capabilities, undefined, localModels());
    // Same routed model, but a fresh instance wired to the new endpoint - a
    // memoised model must never outlive an endpoint change.
    expect(after).not.toBe(before);
    expect(after.modelId).toBe(before.modelId);
  });

  it('keeps memoising under the new endpoint after a change', () => {
    resolveModel(agents.triage.capabilities, undefined, localModels());
    __setConfig('myDevTeam.ollama.endpoint', 'http://gpu-box:11434');
    const first = resolveModel(agents.triage.capabilities, undefined, localModels());
    const second = resolveModel(agents.triage.capabilities, undefined, localModels());
    expect(second).toBe(first);
  });
});
