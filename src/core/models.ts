/**
 * Provider wiring for the capability-based model router. The *selection* —
 * which registered model best fits a set of capability weights — is pure
 * configuration logic and lives in config/models.ts; this file only turns the
 * winning registry entry into an AI SDK model instance, memoised per registry
 * id so agents sharing a model share the instance.
 *
 * To plug in another provider, add it to the registry's provider enum and a
 * factory here, e.g.:
 *   import { createAnthropic } from '@ai-sdk/anthropic';
 *   const anthropic = createAnthropic({ apiKey: ... });
 *   ...factories: { ollama: ..., anthropic: (model) => anthropic(model) }
 */
import { createOllama } from 'ollama-ai-provider-v2';
import {
  CapabilityScores,
  ProviderName,
  selectModel,
} from '../config/models';
import { settings } from '../config/settings';

type OllamaProvider = ReturnType<typeof createOllama>;

/** The AI SDK model type all providers produce. */
export type RoutedModel = ReturnType<OllamaProvider>;

const instances = new Map<string, RoutedModel>();

let ollama: OllamaProvider | undefined;
let ollamaEndpoint: string | undefined;

/**
 * The Ollama provider, built lazily from the configured endpoint
 * (`settings.ollamaEndpoint`, the same value the error hints show). When the
 * user changes the setting the provider is rebuilt and the memoised model
 * instances are dropped, so the next request talks to the new endpoint
 * without a reload.
 */
function ollamaProvider(): OllamaProvider {
  const endpoint = settings.ollamaEndpoint;
  if (!ollama || ollamaEndpoint !== endpoint) {
    ollama = createOllama({ baseURL: `${endpoint}/api` });
    ollamaEndpoint = endpoint;
    instances.clear();
  }
  return ollama;
}

const factories: Record<ProviderName, (model: string) => RoutedModel> = {
  ollama: (model) => ollamaProvider()(model),
};

/**
 * Memoisation key for a wired instance. The endpoint is part of the key so a
 * memoised model can never outlive an endpoint change: a new endpoint always
 * misses, runs the factory, and the factory drops the stale entries.
 */
function instanceKey(id: string): string {
  return `${settings.ollamaEndpoint}::${id}`;
}

/**
 * Resolve a capability requirement profile (an agent's `capabilities`
 * frontmatter) to a ready-to-use AI SDK model instance.
 */
export function resolveModel(requirements: CapabilityScores): RoutedModel {
  const info = selectModel(requirements);
  const key = instanceKey(info.id);
  let model = instances.get(key);
  if (!model) {
    model = factories[info.provider](info.model);
    instances.set(key, model);
  }
  return model;
}
