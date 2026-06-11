/**
 * Semantic model router. Each role maps to an AI SDK model so the agent can
 * use cheap/local models for routing decisions and capable (paid) models for
 * execution. The *selection* (which model id per role) is configuration and
 * lives in config/modelConfig.ts; this file only wires those ids onto provider
 * instances. Change the model per role there, not here.
 *
 * To plug in other providers, e.g.:
 *   import { createAnthropic } from '@ai-sdk/anthropic';
 *   const anthropic = createAnthropic({ apiKey: ... });
 *   plan: anthropic(modelConfig.plan.model),
 */
import { createOllama } from 'ollama-ai-provider-v2';
import { modelConfig } from '../config/modelConfig';

const ollama = createOllama();

export const models = {
  triage: ollama(modelConfig.triage.model),
  plan: ollama(modelConfig.plan.model),
} as const;

export type Role = keyof typeof models;
