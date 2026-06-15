/**
 * Provider wiring for the capability-based model router. The pure *scoring* -
 * which registered model best fits a set of capability weights - lives in
 * config/models.ts; this file adds the parts that need the runtime: which
 * models are actually usable (an Ollama model is assumed pulled; a cloud model
 * needs its API key), and turning the winning registry entry into an AI SDK
 * model instance for the configured endpoint/key.
 *
 * The providers themselves - their ids, labels, key requirements, and how to
 * build each one's AI SDK factory - live in the single provider registry
 * (config/providers.ts). This file only adds the runtime resolution: it reads
 * each provider's resolved config and feeds it to the descriptor's `build`.
 * Each endpoint/base URL is *resolved* as "backend override
 * (engine/config/backend.json) else user setting", so an operator can pin every
 * provider at a fixed gateway while the user setting fills in otherwise. Each
 * provider is built lazily and rebuilt when its configuration (resolved
 * endpoint, key, or base URL) changes, dropping the memoised model instances so
 * the next request talks to the new configuration without a reload.
 */
import { wrapLanguageModel } from 'ai';
import { rateLimitMiddleware } from './rateLimiter';
import {
  CapabilityScores,
  ModelInfo,
  modelById,
  modelRegistry,
  PROVIDER_PIN_PREFIX,
  ProviderName,
  providerPinOf,
  selectModel,
} from '../config/models';
import {
  providerDescriptor,
  providerDescriptors,
  providerIds,
  ProviderConfig,
  ProviderDescriptor,
  RoutedModel,
} from '../../config/providers';
import { Complexity } from '../../protocol/types';
import { settings } from '../../config/settings';
import { credentials } from '../../config/credentials';
import { backendConfig } from '../config/backend';

/** The AI SDK model type all providers produce (re-exported from the registry). */
export type { RoutedModel } from '../../config/providers';

/**
 * A provider's resolved endpoint override from the backend config: Ollama's
 * `endpoint` or a cloud provider's `baseUrl`, both stored under the provider's
 * id in `backend.json`. Undefined means "no override - fall back to the user
 * setting".
 */
function backendEndpointOverride(id: ProviderName): string | undefined {
  const entry = backendConfig.providers[id] as { endpoint?: string; baseUrl?: string };
  return entry.endpoint ?? entry.baseUrl;
}

/**
 * The Ollama server origin actually used: the backend override
 * (engine/config/backend.json) when set, else the user's
 * `myDevTeam.ollama.endpoint`. The single source the provider wiring, the
 * startup probe, and the error hints all read, so they can never disagree.
 */
export function ollamaEndpoint(): string {
  return backendEndpointOverride('ollama') ?? settings.ollamaEndpoint;
}

/**
 * A provider's resolved runtime config, fed to its descriptor's `build`: the
 * API key (keyless providers get none) and the resolved base URL (backend
 * override else user setting). For Ollama the base URL is the endpoint, which
 * always resolves to at least the default; for a cloud provider it may be
 * undefined (use the SDK's own endpoint).
 */
function resolveProviderConfig(descriptor: ProviderDescriptor): ProviderConfig {
  if (descriptor.keyless) {
    return { baseUrl: ollamaEndpoint() };
  }
  return {
    apiKey: credentials.apiKey(descriptor.id),
    baseUrl:
      backendEndpointOverride(descriptor.id) ??
      settings.providerBaseUrl(descriptor.baseUrlSetting),
  };
}

/** The config signature a provider was built from: a key or base-URL change rebuilds it. */
function providerSignature(config: ProviderConfig): string {
  return `${config.apiKey ?? ''}::${config.baseUrl ?? ''}`;
}

const instances = new Map<string, RoutedModel>();

/**
 * A lazily-built provider plus the configuration signature it was built from.
 * When the signature changes the provider is rebuilt and the memoised model
 * instances are dropped, so a key or endpoint change takes effect next run.
 */
interface ProviderCache {
  instance?: (model: string) => RoutedModel;
  builtFrom?: string;
}

/** One cache slot per registered provider, keyed by id. */
const providerCaches: Record<ProviderName, ProviderCache> = Object.fromEntries(
  providerDescriptors.map((d) => [d.id, {} as ProviderCache])
) as Record<ProviderName, ProviderCache>;

/** The provider factory for `name`, rebuilt when its configuration changed. */
function providerFactory(name: ProviderName): (model: string) => RoutedModel {
  const cache = providerCaches[name];
  const descriptor = providerDescriptor(name);
  const config = resolveProviderConfig(descriptor);
  const signature = providerSignature(config);
  if (!cache.instance || cache.builtFrom !== signature) {
    cache.instance = descriptor.build(config);
    cache.builtFrom = signature;
    instances.clear();
  }
  return cache.instance;
}

/** Whether a registered model can actually run now: a keyless provider's model
 * always (Ollama, assumed pulled), a cloud model only when its API key is set. */
export function isModelAvailable(info: ModelInfo): boolean {
  return providerDescriptor(info.provider).keyless || credentials.has(info.provider);
}

/**
 * Whether a provider is enabled, unioning the two disable layers: the backend
 * floor (the operator's `backend.json`, unbypassable) and the user's
 * `myDevTeam.disabledProviders` setting. A disabled provider's models never run,
 * even when pinned (see `effectivePin`).
 */
export function isProviderEnabled(provider: ProviderName): boolean {
  return (
    !backendConfig.models.disabledProviders.includes(provider) &&
    !settings.disabledProviders.includes(provider)
  );
}

/**
 * Whether a registered model is enabled: its provider must be enabled, and the
 * model's own id must not be disabled at either layer (the backend floor or the
 * user's `myDevTeam.disabledModels`). Orthogonal to `isModelAvailable` (whether
 * its API key is set) - a model must be both enabled and available to run.
 */
export function isModelEnabled(info: ModelInfo): boolean {
  return (
    isProviderEnabled(info.provider) &&
    !backendConfig.models.disabledModels.includes(info.id) &&
    !settings.disabledModels.includes(info.id)
  );
}

/**
 * Resolve a user's model pin against the disable layers, so a hard-blocked pin
 * never runs. A pin naming a disabled model, or a `provider:<name>` pin naming a
 * disabled provider, is dropped (returns undefined), so the run falls back to
 * Auto among the enabled models rather than honouring the choice. "auto", an
 * unknown id, or no pin passes through unchanged - and an enabled provider pin
 * stays a provider pin (its individually-disabled members are excluded later by
 * the `isModelEnabled` predicate handed to `selectModel`).
 */
export function effectivePin(pin?: string): string | undefined {
  if (pin === undefined) {
    return undefined;
  }
  const pinned = modelById(pin);
  if (pinned) {
    return isModelEnabled(pinned) ? pin : undefined;
  }
  if (pin.startsWith(PROVIDER_PIN_PREFIX)) {
    const provider = providerPinOf(pin);
    // A provider pin naming an unknown provider already degrades to Auto; one
    // naming a disabled provider is hard-blocked the same way.
    return provider && isProviderEnabled(provider) ? pin : undefined;
  }
  return pin;
}

/** The models Auto may route to right now (Ollama plus any keyed cloud models),
 * minus anything disabled at either layer. */
export function availableModels(): ModelInfo[] {
  return modelRegistry.filter((m) => isModelAvailable(m) && isModelEnabled(m));
}

/** The local Ollama models, minus anything disabled at either layer. The
 * default candidate pool for triage (the "ollama" provider choice). */
export function localModels(): ModelInfo[] {
  return modelRegistry.filter((m) => m.provider === 'ollama' && isModelEnabled(m));
}

/** The provider names the registry knows, in a stable order. */
const providerNames: readonly ProviderName[] = providerIds;

/**
 * How the triage agent is routed. The user's `myDevTeam.triage.model` wins when
 * set; otherwise the build's `backend.json` `agents.triage.model` floor (the
 * "ollama" provider by default). This mirrors how the work agents' model is
 * chosen - user-controlled, with the backend providing only the default and the
 * unbypassable disable layers (applied via the candidate pools and `routeModel`,
 * so triage can never reach a provider/model the operator disabled).
 *
 * The chosen value is interpreted leniently: "auto" routes among all available
 * models; a registered model id pins that exact model; a provider - written as
 * the `provider:<name>` pin (matching `myDevTeam.model`) or a bare provider name
 * (the backend config's vocabulary) - routes by capability among that provider's
 * enabled models; anything else (an unknown name, or a provider with nothing
 * enabled) falls back to the local models. Returned as the `(pin, candidates)`
 * inputs the normal router takes, so triage reuses the same scoring and disable
 * rules as every other agent.
 */
export function triageRouting(): { pin?: string; candidates: readonly ModelInfo[] } {
  const choice = settings.triageModel || backendConfig.agents.triage.model;
  if (choice === 'auto') {
    return { candidates: availableModels() };
  }
  if (modelById(choice)) {
    return { pin: choice, candidates: availableModels() };
  }
  const provider = choice.startsWith(PROVIDER_PIN_PREFIX)
    ? providerPinOf(choice)
    : (providerNames as readonly string[]).includes(choice)
      ? (choice as ProviderName)
      : undefined;
  if (provider) {
    const pool = modelRegistry.filter((m) => m.provider === provider && isModelEnabled(m));
    if (pool.length > 0) {
      return { candidates: pool };
    }
  }
  return { candidates: localModels() };
}

/** The registry entry triage will use, honouring the backend triage config. */
export function routeTriageModel(requirements: CapabilityScores): ModelInfo {
  const { pin, candidates } = triageRouting();
  return routeModel(requirements, pin, candidates);
}

/** The wired AI SDK instance triage will use, honouring the backend triage config. */
export function resolveTriageModel(requirements: CapabilityScores): RoutedModel {
  const { pin, candidates } = triageRouting();
  return resolveModel(requirements, pin, candidates);
}

/**
 * The registry entry an agent will use: a `pin` naming a registered model wins
 * outright (the user asked for it, even if its key is missing - the run then
 * fails with a helpful hint); otherwise the best weighted fit among
 * `candidates` (defaults to the currently-available models, so Auto never
 * routes to a cloud model whose key is not set).
 *
 * `complexity` (only the executor passes one) narrows the pool to the request's
 * tier before scoring - but only when `myDevTeam.complexityRouting` is on, the
 * gate read live here so every caller (the executor and the engine's
 * model-selection mirror) honours it identically.
 */
export function routeModel(
  requirements: CapabilityScores,
  pin?: string,
  candidates: readonly ModelInfo[] = availableModels(),
  complexity?: Complexity
): ModelInfo {
  const tier = settings.complexityRoutingEnabled ? complexity : undefined;
  // A disabled pin is dropped to Auto, and the predicate also drops a disabled
  // member of an (otherwise enabled) pinned provider's pool - so disabling is an
  // unbypassable hard block however the model would have been reached.
  return selectModel(requirements, effectivePin(pin), candidates, tier, isModelEnabled);
}

/**
 * Memoisation key for a wired instance: the registry id plus the provider's
 * current configuration signature, so a memoised model can never outlive a key
 * or endpoint change (a changed signature also clears the cache in
 * providerFactory, so this is belt-and-braces).
 */
function instanceKey(info: ModelInfo): string {
  return `${providerCaches[info.provider].builtFrom ?? ''}::${info.id}`;
}

/**
 * Resolve a capability requirement profile to a ready-to-use AI SDK model
 * instance, honouring an optional pin and candidate restriction (see
 * routeModel).
 */
export function resolveModel(
  requirements: CapabilityScores,
  pin?: string,
  candidates?: readonly ModelInfo[],
  complexity?: Complexity
): RoutedModel {
  const info = routeModel(requirements, pin, candidates, complexity);
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
