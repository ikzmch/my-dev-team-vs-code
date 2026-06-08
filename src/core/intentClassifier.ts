import { Agent } from '@mastra/core/agent';
import { z } from 'zod';
import { models } from './models';

/**
 * Routing decision for a user request:
 *   - "oneshot":  answer directly in a single model call, no planning needed.
 *   - "planning": decompose into steps, likely with tool calls.
 */
export const IntentSchema = z.object({
  intent: z
    .enum(['oneshot', 'planning'])
    .describe(
      '"oneshot" for direct answers; "planning" for multi-step / file-touching work.'
    ),
  reason: z.string().describe('One short sentence explaining the choice.'),
});

export type IntentResult = z.infer<typeof IntentSchema>;

const INSTRUCTIONS = `You are an intent classifier for a coding assistant inside VS Code.

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

Respond with a JSON object matching the provided schema.`;

export class IntentClassifier {
  private readonly agent = new Agent({
    id: 'intent-classifier',
    name: 'Intent Classifier',
    instructions: INSTRUCTIONS,
    model: models.intent,
  });

  async classify(prompt: string): Promise<IntentResult> {
    const result = await this.agent.generate(
      [{ role: 'user', content: prompt }],
      { structuredOutput: { schema: IntentSchema } }
    );
    return result.object as IntentResult;
  }
}
