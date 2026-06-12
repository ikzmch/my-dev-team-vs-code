import { Agent } from '@mastra/core/agent';
import { z } from 'zod';
import { resolveModel } from './models';
import { agents } from '../config/agents';

/**
 * Triage decision for a user request:
 *   - "oneshot":  answer directly in a single model call, no planning needed.
 *   - "planning": decompose into steps, likely with tool calls.
 */
export const TriageSchema = z.object({
  intent: z
    .enum(['oneshot', 'planning'])
    .describe(
      '"oneshot" for direct answers; "planning" for multi-step / file-touching work.'
    ),
  reason: z.string().describe('One short sentence explaining the choice.'),
});

export type TriageResult = z.infer<typeof TriageSchema>;

export class Triage {
  private readonly agent = new Agent({
    id: agents.triage.id,
    name: agents.triage.name,
    description: agents.triage.description,
    instructions: agents.triage.instructions,
    model: resolveModel(agents.triage.capabilities),
  });

  async classify(prompt: string): Promise<TriageResult> {
    const result = await this.agent.generate(
      [{ role: 'user', content: prompt }],
      { structuredOutput: { schema: TriageSchema } }
    );
    // Validate rather than cast: a missing or malformed object fails here
    // with a schema error instead of rendering as "intent: undefined" later.
    return TriageSchema.parse(result.object);
  }
}
