import { Agent } from '@mastra/core/agent';
import { z } from 'zod';
import { resolveModel } from './models';
import { readUsage, UsageReporter } from './usage';
import { agents } from '../config/agents';
import { selectModel } from '../config/models';
import { IntentSchema } from '../../protocol/types';

/**
 * Triage decision for a user request:
 *   - "oneshot":  answer directly in a single model call, no planning needed.
 *   - "planning": decompose into steps, likely with tool calls.
 *
 * The schema is the generation schema (its describe() strings steer the
 * model); the intent enum itself is the protocol's, so the engine cannot
 * produce a routing the protocol does not know.
 */
export const TriageSchema = z.object({
  intent: IntentSchema.describe(
    '"oneshot" when the deliverable is text in the chat; "planning" when the workspace should change - any file to create or modify, even one small file.'
  ),
  reason: z.string().describe('One short sentence explaining the choice.'),
});

export type TriageResult = z.infer<typeof TriageSchema>;

export class Triage {
  private readonly modelName = selectModel(agents.triage.capabilities).model;
  private readonly agent = new Agent({
    id: agents.triage.id,
    name: agents.triage.name,
    description: agents.triage.description,
    instructions: agents.triage.instructions,
    model: resolveModel(agents.triage.capabilities),
  });

  async classify(prompt: string, onUsage?: UsageReporter): Promise<TriageResult> {
    const result = await this.agent.generate(
      [{ role: 'user', content: prompt }],
      { structuredOutput: { schema: TriageSchema } }
    );
    const usage = await readUsage(result);
    if (usage) {
      onUsage?.({ model: this.modelName, ...usage });
    }
    // Validate rather than cast: a missing or malformed object fails here
    // with a schema error instead of rendering as "intent: undefined" later.
    return TriageSchema.parse(result.object);
  }
}
