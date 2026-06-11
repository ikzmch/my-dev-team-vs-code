/**
 * Model selection per semantic role — which model id each role uses and on
 * which provider. This is the configuration half of the router; the wiring
 * that turns these ids into AI SDK model instances lives in core/models.ts.
 * Swap a role onto a different model (or, later, a paid provider) here.
 */
export const modelConfig = {
  /** Triage the user's request (cheap, local, deterministic). */
  triage: { provider: 'ollama', model: 'qwen3:8b' },
  /** Draft a step-by-step plan for non-trivial tasks. */
  plan: { provider: 'ollama', model: 'qwen3:8b' },
} as const;

export type ModelRole = keyof typeof modelConfig;
