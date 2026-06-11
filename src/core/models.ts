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

const ollama = createOllama();

/** The AI SDK model type all providers produce. */
export type RoutedModel = ReturnType<typeof ollama>;

const factories: Record<ProviderName, (model: string) => RoutedModel> = {
  ollama: (model) => ollama(model),
};

const instances = new Map<string, RoutedModel>();

/**
 * Resolve a capability requirement profile (an agent's `capabilities`
 * frontmatter) to a ready-to-use AI SDK model instance.
 */
export function resolveModel(requirements: CapabilityScores): RoutedModel {
  const info = selectModel(requirements);
  let model = instances.get(info.id);
  if (!model) {
    model = factories[info.provider](info.model);
    instances.set(info.id, model);
  }
  return model;
}
