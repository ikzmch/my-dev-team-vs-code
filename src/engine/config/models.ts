/**
 * Registered model catalogue and capability-based selection. Each model the
 * router may pick from is described by a `.md` file in ./models: frontmatter
 * carries the structured fields (id, provider, provider-specific model name,
 * and capability scores) and the markdown body is a human-facing note on what
 * the model is good for.
 *
 * Capability scores rate how good a model is at a capability (0–1). Agents
 * declare the same capabilities as *weights* — how much that capability
 * matters to them (see agents.ts) — and `selectModel` picks the registered
 * model with the highest weighted score. Selection is pure configuration
 * logic; turning the winner into an AI SDK instance is provider wiring and
 * lives in core/models.ts.
 *
 * To register a new model, drop a `.md` file into ./models — the glob import
 * below discovers it at build time. Only register models that are actually
 * available (e.g. pulled in Ollama) — selection assumes every registered
 * model can run.
 */
import { z } from 'zod';
import { parseFrontmatter } from './frontmatter';
import modelFiles from 'glob:./models/*.md';

/** The capability vocabulary models are scored on and agents weight. */
export const capabilityNames = [
  'reasoning',
  'coding',
  'classification',
  'planning',
  'speed',
  'structured-output',
] as const;

export type Capability = (typeof capabilityNames)[number];

/**
 * Capability → number in [0,1]. On a model it is a score (how good the model
 * is); on an agent it is a weight (how much the agent cares).
 */
export type CapabilityScores = Partial<Record<Capability, number>>;

export const CapabilityScoresSchema = z
  .partialRecord(z.enum(capabilityNames), z.number().min(0).max(1))
  .refine((scores) => Object.keys(scores).length > 0, {
    message: 'At least one capability must be given.',
  });

const ModelFrontmatterSchema = z.object({
  /** Stable registry id, also the memoisation key for wired instances. */
  id: z.string(),
  /**
   * User-facing display name shown in the model picker and the "which model
   * ran" line - the one place the protocol exposes a concrete model identity.
   */
  label: z.string(),
  /** Which provider hosts the model (see the factories in core/models.ts). */
  provider: z.enum(['ollama', 'openai', 'anthropic']),
  /** Provider-specific model name, e.g. the Ollama tag or the API model id. */
  model: z.string(),
  /** How good this model is at each capability, 0–1. */
  capabilities: CapabilityScoresSchema,
});

export interface ModelInfo extends z.infer<typeof ModelFrontmatterSchema> {
  /** Human-facing note on the model's strengths (the markdown body). */
  description: string;
}

export type ProviderName = ModelInfo['provider'];

function loadModel(raw: string): ModelInfo {
  const { data, body } = parseFrontmatter(raw);
  return { ...ModelFrontmatterSchema.parse(data), description: body.trim() };
}

/**
 * Parse a set of model config files into registry entries, rejecting
 * duplicate ids: the id is the memoisation key for wired instances, so two
 * entries sharing one would silently alias each other.
 */
export function loadModels(files: readonly string[]): ModelInfo[] {
  const models = files.map(loadModel);
  const seen = new Set<string>();
  for (const info of models) {
    if (seen.has(info.id)) {
      throw new Error(`Duplicate model id "${info.id}" in config/models.`);
    }
    seen.add(info.id);
  }
  return models;
}

/** All models the router may select, in filename order (ties go first). */
export const modelRegistry: readonly ModelInfo[] = loadModels(modelFiles);

/**
 * The sentinel a client sends (or omits) to let the capability router pick per
 * agent, rather than pinning one model. Anything that is not a registered id
 * is treated the same way, so an unknown pin (version skew) degrades to Auto.
 */
export const AUTO_MODEL = 'auto';

/**
 * Prefix marking a choice that pins a *provider* rather than a single model:
 * e.g. "provider:anthropic" routes the work agents to the best Anthropic model
 * per agent, instead of one fixed model. The catalogue (Engine.listModels)
 * emits these alongside Auto and the individual models.
 */
export const PROVIDER_PIN_PREFIX = 'provider:';

/** User-facing display names for the registry's providers. */
export const providerLabels: Record<ProviderName, string> = {
  ollama: 'Ollama',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
};

/** The registered model with this id, or undefined for "auto"/unknown ids. */
export function modelById(id: string | undefined): ModelInfo | undefined {
  return id === undefined ? undefined : modelRegistry.find((m) => m.id === id);
}

/**
 * The provider a "provider:<name>" pin names, or undefined when the pin is not
 * a provider pin (or names a provider with no registered models, so it can
 * degrade to Auto rather than route among nothing).
 */
export function providerPinOf(pin: string | undefined): ProviderName | undefined {
  if (!pin || !pin.startsWith(PROVIDER_PIN_PREFIX)) {
    return undefined;
  }
  const name = pin.slice(PROVIDER_PIN_PREFIX.length) as ProviderName;
  return modelRegistry.some((m) => m.provider === name) ? name : undefined;
}

/** Weighted fit of a model for a requirement profile: Σ weight × score. */
export function scoreModel(info: ModelInfo, requirements: CapabilityScores): number {
  let total = 0;
  for (const [capability, weight] of Object.entries(requirements)) {
    total += weight * (info.capabilities[capability as Capability] ?? 0);
  }
  return total;
}

/**
 * Pick the model for a requirement profile. A `pin` naming a registered model
 * overrides the router and returns that model outright - the user asked for
 * it, even if it is not in `candidates`. A `provider:<name>` pin narrows the
 * choice to that provider's models (all of them, like a model pin bypassing
 * availability) and routes by weight within it. "auto", an unknown id, or no
 * pin falls back to the highest weighted fit among `candidates` (the whole
 * registry by default; the caller passes a narrower set to keep Auto from
 * routing to a model that cannot run - see core/models.ts).
 */
export function selectModel(
  requirements: CapabilityScores,
  pin?: string,
  candidates: readonly ModelInfo[] = modelRegistry
): ModelInfo {
  const pinned = modelById(pin);
  if (pinned) {
    return pinned;
  }
  const provider = providerPinOf(pin);
  const pool = provider
    ? modelRegistry.filter((m) => m.provider === provider)
    : candidates;
  let best: ModelInfo | undefined;
  let bestScore = -Infinity;
  for (const info of pool) {
    const score = scoreModel(info, requirements);
    if (score > bestScore) {
      best = info;
      bestScore = score;
    }
  }
  if (!best) {
    throw new Error('No models are available to select from.');
  }
  return best;
}
