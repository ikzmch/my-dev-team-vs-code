/**
 * Provider wiring for the capability-based model router. The pure *scoring* -
 * which registered model best fits a set of capability weights - lives in
 * config/models.ts; this file adds the parts that need the runtime: which
 * models are actually usable (an Ollama model is assumed pulled; a cloud model
 * needs its API key), and turning the winning registry entry into an AI SDK
 * model instance for the configured endpoint/key.
 *
 * Four providers are wired:
 *   - ollama:    local, keyless, from `settings.ollamaEndpoint`.
 *   - openai:    needs `credentials.openaiApiKey`; optional `settings.openaiBaseUrl`.
 *   - anthropic: needs `credentials.anthropicApiKey`; optional `settings.anthropicBaseUrl`.
 *   - groq:      needs `credentials.groqApiKey`; optional `settings.groqBaseUrl`.
 * Each provider is built lazily and rebuilt when its configuration (endpoint,
 * key, or base URL) changes, dropping the memoised model instances so the next
 * request talks to the new configuration without a reload.
 */
import { wrapLanguageModel } from 'ai';
import { createOllama } from 'ollama-ai-provider-v2';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGroq } from '@ai-sdk/groq';
import { rateLimitMiddleware } from './rateLimiter';
import {
  CapabilityScores,
  ModelInfo,
  modelRegistry,
  ProviderName,
  selectModel,
} from '../config/models';
import { settings } from '../../config/settings';
import { credentials } from '../../config/credentials';

/** The AI SDK model type all providers produce. */
export type RoutedModel = ReturnType<ReturnType<typeof createOllama>>;

const instances = new Map<string, RoutedModel>();

/**
 * A lazily-built provider plus the configuration signature it was built from.
 * When the signature changes the provider is rebuilt and the memoised model
 * instances are dropped, so a key or endpoint change takes effect next run.
 */
interface ProviderCache {
  signature: () => string;
  build: () => (model: string) => RoutedModel;
  instance?: (model: string) => RoutedModel;
  builtFrom?: string;
}

const providers: Record<ProviderName, ProviderCache> = {
  ollama: {
    signature: () => settings.ollamaEndpoint,
    build: () => {
      const ollama = createOllama({ baseURL: `${settings.ollamaEndpoint}/api` });
      return (model) => ollama(model);
    },
  },
  openai: {
    signature: () => `${credentials.openaiApiKey ?? ''}::${settings.openaiBaseUrl ?? ''}`,
    build: () => {
      const openai = createOpenAI({
        apiKey: credentials.openaiApiKey,
        ...(settings.openaiBaseUrl ? { baseURL: settings.openaiBaseUrl } : {}),
      });
      return (model) => openai(model) as RoutedModel;
    },
  },
  anthropic: {
    signature: () =>
      `${credentials.anthropicApiKey ?? ''}::${settings.anthropicBaseUrl ?? ''}`,
    build: () => {
      const anthropic = createAnthropic({
        apiKey: credentials.anthropicApiKey,
        ...(settings.anthropicBaseUrl ? { baseURL: settings.anthropicBaseUrl } : {}),
      });
      return (model) => anthropic(model) as RoutedModel;
    },
  },
  groq: {
    signature: () => `${credentials.groqApiKey ?? ''}::${settings.groqBaseUrl ?? ''}`,
    build: () => {
      const groq = createGroq({
        apiKey: credentials.groqApiKey,
        ...(settings.groqBaseUrl ? { baseURL: settings.groqBaseUrl } : {}),
      });
      return (model) => groq(model) as RoutedModel;
    },
  },
};

/** The provider factory for `name`, rebuilt when its configuration changed. */
function providerFactory(name: ProviderName): (model: string) => RoutedModel {
  const cache = providers[name];
  const signature = cache.signature();
  if (!cache.instance || cache.builtFrom !== signature) {
    cache.instance = cache.build();
    cache.builtFrom = signature;
    instances.clear();
  }
  return cache.instance;
}

/** Whether a registered model can actually run now: Ollama always (assumed
 * pulled), a cloud model only when its API key is configured. */
export function isModelAvailable(info: ModelInfo): boolean {
  switch (info.provider) {
    case 'ollama':
      return true;
    case 'openai':
      return credentials.has('openai');
    case 'anthropic':
      return credentials.has('anthropic');
    case 'groq':
      return credentials.has('groq');
  }
}

/** The models Auto may route to right now (Ollama plus any keyed cloud models). */
export function availableModels(): ModelInfo[] {
  return modelRegistry.filter(isModelAvailable);
}

/** The local Ollama models - the only candidates triage ever routes among. */
export function localModels(): ModelInfo[] {
  return modelRegistry.filter((m) => m.provider === 'ollama');
}

/**
 * The registry entry an agent will use: a `pin` naming a registered model wins
 * outright (the user asked for it, even if its key is missing - the run then
 * fails with a helpful hint); otherwise the best weighted fit among
 * `candidates` (defaults to the currently-available models, so Auto never
 * routes to a cloud model whose key is not set).
 */
export function routeModel(
  requirements: CapabilityScores,
  pin?: string,
  candidates: readonly ModelInfo[] = availableModels()
): ModelInfo {
  return selectModel(requirements, pin, candidates);
}

/**
 * Memoisation key for a wired instance: the registry id plus the provider's
 * current configuration signature, so a memoised model can never outlive a key
 * or endpoint change (a changed signature also clears the cache in
 * providerFactory, so this is belt-and-braces).
 */
function instanceKey(info: ModelInfo): string {
  return `${providers[info.provider].builtFrom ?? ''}::${info.id}`;
}

/**
 * Resolve a capability requirement profile to a ready-to-use AI SDK model
 * instance, honouring an optional pin and candidate restriction (see
 * routeModel).
 */
export function resolveModel(
  requirements: CapabilityScores,
  pin?: string,
  candidates?: readonly ModelInfo[]
): RoutedModel {
  const info = routeModel(requirements, pin, candidates);
  const factory = providerFactory(info.provider);
  const key = instanceKey(info);
  let model = instances.get(key);
  if (!model) {
    // Wrap every wired model in the rate limiter: it throttles to the
    // configured RPM and retries a provider 429 after the suggested delay. The
    // middleware reads its settings live, so the wrapped instance can be
    // memoised even though the limit can change between requests.
    model = wrapLanguageModel({
      model: factory(info.model),
      middleware: rateLimitMiddleware(info.provider),
    }) as RoutedModel;
    instances.set(key, model);
  }
  return model;
}
