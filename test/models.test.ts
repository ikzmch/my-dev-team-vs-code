import { describe, it, expect, beforeEach } from 'vitest';
import {
  resolveModel,
  routeModel,
  localModels,
  availableModels,
  isModelAvailable,
  isModelEnabled,
  isProviderEnabled,
  effectivePin,
  ollamaEndpoint,
} from '../src/engine/core/models';
import { settings, defaults } from '../src/config/settings';
import {
  selectModel,
  tierPool,
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

describe('selectModel with an isEnabled predicate', () => {
  it('drops a disabled model from a provider-pin pool', () => {
    const enabled = (m: { id: string }) => m.id !== 'anthropic-opus';
    const picked = selectModel(
      agents.executor.capabilities,
      'provider:anthropic',
      undefined,
      undefined,
      enabled
    );
    expect(picked.provider).toBe('anthropic');
    expect(picked.id).not.toBe('anthropic-opus');
  });

  it('falls through a disabled pinned model to the candidate weighted fit', () => {
    const enabled = (m: { id: string }) => m.id !== 'anthropic-opus';
    const picked = selectModel(
      agents.executor.capabilities,
      'anthropic-opus',
      localModels(),
      undefined,
      enabled
    );
    // The disabled pin is ignored, so it routes among the (local) candidates.
    expect(picked.provider).toBe('ollama');
  });

  it('throws when every candidate is disabled', () => {
    expect(() =>
      selectModel(agents.executor.capabilities, undefined, localModels(), undefined, () => false)
    ).toThrow(/disabled/);
  });
});

describe('disabling (user layer via settings)', () => {
  it('isProviderEnabled / isModelEnabled honour the disabled-provider list', () => {
    __setConfig('myDevTeam.disabledProviders', ['ollama']);
    expect(isProviderEnabled('ollama')).toBe(false);
    // A disabled provider disables its models too.
    expect(isModelEnabled(modelById('qwen3-8b')!)).toBe(false);
    expect(isProviderEnabled('anthropic')).toBe(true);
  });

  it('isModelEnabled honours the disabled-model list', () => {
    __setConfig('myDevTeam.disabledModels', ['qwen3-coder']);
    expect(isModelEnabled(modelById('qwen3-coder')!)).toBe(false);
    expect(isModelEnabled(modelById('qwen3-8b')!)).toBe(true);
  });

  it('effectivePin drops a disabled model pin and a disabled provider pin', () => {
    __setConfig('myDevTeam.disabledModels', ['qwen3-coder']);
    __setConfig('myDevTeam.disabledProviders', ['anthropic']);
    expect(effectivePin('qwen3-coder')).toBeUndefined();
    expect(effectivePin('provider:anthropic')).toBeUndefined();
    // An enabled choice (and Auto) passes through unchanged.
    expect(effectivePin('qwen3-8b')).toBe('qwen3-8b');
    expect(effectivePin('auto')).toBe('auto');
  });

  it('availableModels and localModels exclude a disabled model', () => {
    __setConfig('myDevTeam.disabledModels', ['qwen3-coder']);
    expect(localModels().some((m) => m.id === 'qwen3-coder')).toBe(false);
    expect(availableModels().some((m) => m.id === 'qwen3-coder')).toBe(false);
  });

  it('routeModel hard-blocks a disabled pin, falling back to Auto', () => {
    __setConfig('myDevTeam.disabledModels', ['qwen3-coder']);
    const picked = routeModel(agents.executor.capabilities, 'qwen3-coder', localModels());
    expect(picked.id).not.toBe('qwen3-coder');
    expect(picked.provider).toBe('ollama');
  });
});

describe('resolved provider endpoints', () => {
  it('falls back to the built-in localhost when neither user nor deployment set one', () => {
    // The shipped backend.json sets no default and the user has set nothing, so
    // the resolved Ollama endpoint is the built-in localhost default.
    expect(settings.ollamaEndpoint).toBeUndefined();
    expect(ollamaEndpoint()).toBe(defaults.ollamaEndpoint);
  });

  it('lets the user Ollama endpoint setting win (over the deployment default)', () => {
    // The user's setting wins; with the shipped (empty) backend default this is
    // the value used. The user-wins-over-a-set-default precedence is the `??`
    // order in ollamaEndpoint(); the backend default parsing is covered by the
    // schema tests.
    __setConfig('myDevTeam.ollama.endpoint', 'http://gpu-box:11434');
    expect(ollamaEndpoint()).toBe('http://gpu-box:11434');
  });

  it('reads a cloud provider base URL from its descriptor setting key', () => {
    // The generic settings accessor the provider wiring uses (per descriptor
    // baseUrlSetting); unset is undefined (defer to the deployment default), set
    // returns the normalised URL and wins over the default.
    expect(settings.providerBaseUrl('openai.baseUrl')).toBeUndefined();
    __setConfig('myDevTeam.openai.baseUrl', 'https://gateway.example.com/');
    expect(settings.providerBaseUrl('openai.baseUrl')).toBe('https://gateway.example.com');
  });
});

describe('tierPool', () => {
  const byTier = (tier: string) => modelRegistry.filter((m) => m.tier === tier);

  it('keeps only the matching tier when the pool has it', () => {
    const picked = tierPool(modelRegistry, 'simple');
    expect(picked.length).toBe(byTier('simple').length);
    expect(picked.every((m) => m.tier === 'simple')).toBe(true);
  });

  it('falls back to the nearest available tier when the exact one is absent', () => {
    // A pool of only moderate + complex models, asked for simple, narrows to the
    // nearest available (moderate), not the strongest (complex).
    const pool = [modelById('qwen3-14b')!, modelById('qwen3-coder')!];
    const picked = tierPool(pool, 'simple');
    expect(picked.every((m) => m.tier === 'moderate')).toBe(true);
  });

  it('breaks a distance tie toward the cheaper tier', () => {
    // simple (distance 1) and complex (distance 1) are equidistant from a
    // moderate request; the cheaper tier wins.
    const pool = [modelById('qwen3-8b')!, modelById('qwen3-coder')!];
    const picked = tierPool(pool, 'moderate');
    expect(picked.every((m) => m.tier === 'simple')).toBe(true);
  });
});

describe('selectModel with complexity', () => {
  it('sizes the model to the request tier for one capability profile', () => {
    const simple = selectModel(agents.executor.capabilities, undefined, localModels(), 'simple');
    const moderate = selectModel(agents.executor.capabilities, undefined, localModels(), 'moderate');
    const complex = selectModel(agents.executor.capabilities, undefined, localModels(), 'complex');
    expect(simple.tier).toBe('simple');
    expect(moderate.tier).toBe('moderate');
    // The coding-heavy executor profile picks the local coder at the top tier.
    expect(complex.id).toBe('qwen3-coder');
  });

  it('narrows a provider pin to the request tier', () => {
    const simple = selectModel(agents.executor.capabilities, 'provider:anthropic', undefined, 'simple');
    const complex = selectModel(agents.executor.capabilities, 'provider:anthropic', undefined, 'complex');
    expect(simple.id).toBe('anthropic-haiku');
    expect(complex.id).toBe('anthropic-opus');
  });

  it('a model pin bypasses the tier filter', () => {
    const pinned = selectModel(
      agents.executor.capabilities,
      'anthropic-opus',
      localModels(),
      'simple'
    );
    expect(pinned.id).toBe('anthropic-opus');
  });
});

describe('routeModel complexity gate', () => {
  it('applies the request tier when complexityRouting is on (the default)', () => {
    const picked = routeModel(agents.executor.capabilities, undefined, localModels(), 'simple');
    expect(picked.tier).toBe('simple');
  });

  it('ignores complexity when complexityRouting is off', () => {
    __setConfig('myDevTeam.complexityRouting', false);
    const picked = routeModel(agents.executor.capabilities, undefined, localModels(), 'simple');
    // Capability routing alone picks the coder, regardless of the simple tier.
    expect(picked.id).toBe('qwen3-coder');
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
