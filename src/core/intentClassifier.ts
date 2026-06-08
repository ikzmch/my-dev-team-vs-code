import { ChatTurn } from './types';
import { OllamaClient } from './ollama';

/**
 * Routing decision for a user request:
 *  - "oneshot": answer directly in a single model call, no planning needed.
 *  - "planning": decompose into steps, likely with tool calls.
 */
export type Intent = 'oneshot' | 'planning';

export interface IntentResult {
  intent: Intent;
  reason: string;
}

const SYSTEM_PROMPT = `You are an intent classifier for a coding assistant inside VS Code.

Read the user's most recent message and decide which path it should take.

Categories:
- "oneshot": a question or small request that can be answered directly without exploring the workspace or making coordinated changes. Examples:
  * "what does this regex match"
  * "explain how Promise.all works"
  * "what does this error mean"
  * "summarise this function"

- "planning": a task that needs file exploration, code edits, or multiple coordinated steps. Examples:
  * "add a new endpoint for users"
  * "refactor this module to use async/await"
  * "fix the failing test in foo.spec.ts"
  * "find all callers of X and update them"

Respond with ONLY a JSON object, no prose, no markdown fences:
{"intent": "oneshot" | "planning", "reason": "<one short sentence>"}`;

export class IntentClassifier {
  constructor(private readonly client: OllamaClient) {}

  async classify(prompt: string, _history: ChatTurn[]): Promise<IntentResult> {
    const raw = await this.client.chat(
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      { format: 'json', temperature: 0.1 }
    );
    return parseIntent(raw);
  }
}

function parseIntent(raw: string): IntentResult {
  // Some models still emit <think>...</think> even with think:false; strip it.
  const cleaned = raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

  try {
    const obj = JSON.parse(cleaned);
    if (obj && (obj.intent === 'oneshot' || obj.intent === 'planning')) {
      return {
        intent: obj.intent,
        reason:
          typeof obj.reason === 'string' && obj.reason.length > 0
            ? obj.reason
            : '(no reason given)',
      };
    }
  } catch {
    // Fall through to safe default.
  }

  // Safe default: assume planning so we never skip exploration when we
  // should have done it. The reason carries the raw response for debugging.
  return {
    intent: 'planning',
    reason: `Classifier returned unparseable response: ${cleaned.slice(0, 120)}`,
  };
}
