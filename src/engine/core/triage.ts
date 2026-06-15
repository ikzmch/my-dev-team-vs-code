import { Agent } from '@mastra/core/agent';
import { z } from 'zod';
import { routeTriageModel, resolveTriageModel } from './models';
import { resolveTokenCounts, UsageReporter } from './usage';
import { parseWithRepair } from './repair';
import { agents } from '../config/agents';
import { ComplexitySchema, IntentSchema } from '../../protocol/types';

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
  complexity: ComplexitySchema.describe(
    'How demanding the work is: "simple" for a self-contained task needing little reasoning or exploration (e.g. a single small script); "moderate" for a typical change touching a few files; "complex" for multi-file changes, subtle debugging, or architectural/performance work.'
  ),
  reason: z.string().describe('One short sentence explaining the choice.'),
});

export type TriageResult = z.infer<typeof TriageSchema>;

export class Triage {
  // Triage routes per the backend `agents.triage.model` config: by default the
  // local Ollama models (a cheap, invisible classification that stays fast and
  // free even when a paid model is pinned for the work that follows), but an
  // operator can point it at a specific model or another provider.
  private readonly modelName = routeTriageModel(agents.triage.capabilities).model;
  private readonly agent = new Agent({
    id: agents.triage.id,
    name: agents.triage.name,
    description: agents.triage.description,
    instructions: agents.triage.instructions,
    model: resolveTriageModel(agents.triage.capabilities),
  });

  async classify(prompt: string, onUsage?: UsageReporter): Promise<TriageResult> {
    // Validate rather than cast: a missing or malformed object would otherwise
    // render as "intent: undefined" later. On a validation failure, parseWithRepair
    // re-asks once with the zod issues appended (see ./repair.ts) before the
    // step fails for real - small local models routinely need that nudge.
    return parseWithRepair(TriageSchema, async (repair) => {
      const content = repair ? `${prompt}\n\n${repair}` : prompt;
      const result = await this.agent.generate(
        [{ role: 'user', content }],
        { structuredOutput: { schema: TriageSchema } }
      );
      const counts = await resolveTokenCounts(
        result,
        content,
        JSON.stringify(result.object ?? {})
      );
      // The retry is a real second model call: report it (flagged repaired) so
      // the billing seam and the eval log see the extra spend.
      onUsage?.({
        model: this.modelName,
        ...counts,
        ...(repair ? { repaired: true } : {}),
      });
      return result.object;
    });
  }
}
