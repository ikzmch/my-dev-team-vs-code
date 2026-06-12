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
  /** Which provider hosts the model (see the factories in core/models.ts). */
  provider: z.enum(['ollama']),
  /** Provider-specific model name, e.g. the Ollama tag to run. */
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

/** Weighted fit of a model for a requirement profile: Σ weight × score. */
export function scoreModel(info: ModelInfo, requirements: CapabilityScores): number {
  let total = 0;
  for (const [capability, weight] of Object.entries(requirements)) {
    total += weight * (info.capabilities[capability as Capability] ?? 0);
  }
  return total;
}

/** Pick the registered model that best fits the given capability weights. */
export function selectModel(requirements: CapabilityScores): ModelInfo {
  let best: ModelInfo | undefined;
  let bestScore = -Infinity;
  for (const info of modelRegistry) {
    const score = scoreModel(info, requirements);
    if (score > bestScore) {
      best = info;
      bestScore = score;
    }
  }
  if (!best) {
    throw new Error('No models are registered.');
  }
  return best;
}
