/**
 * Semantic model router. Each role maps to an AI SDK model so the agent can
 * use cheap/local models for routing decisions and capable (paid) models for
 * execution. Swap providers per role here without touching agent code.
 *
 *   intent  - classify the user's request (cheap, local, deterministic)
 *   plan    - draft a step-by-step plan for non-trivial tasks
 *
 * To plug in other providers, e.g.:
 *   import { createAnthropic } from '@ai-sdk/anthropic';
 *   const anthropic = createAnthropic({ apiKey: ... });
 *   plan: anthropic('claude-haiku-4-5'),
 */
import { createOllama } from 'ollama-ai-provider-v2';

const ollama = createOllama();

export const models = {
  intent: ollama('qwen3:8b'),
  plan: ollama('qwen3:8b'),
} as const;

export type Role = keyof typeof models;
