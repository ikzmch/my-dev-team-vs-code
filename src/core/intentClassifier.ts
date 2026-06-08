import { Agent } from '@mastra/core/agent';
import { z } from 'zod';
import { models } from './models';
import { prompts } from '../config/prompts';

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

export class IntentClassifier {
  private readonly agent = new Agent({
    id: 'intent-classifier',
    name: 'Intent Classifier',
    instructions: prompts.intentClassifier,
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
