import { Agent } from '@mastra/core/agent';
import { z } from 'zod';
import { resolveModel } from './models';
import { readUsage, UsageReporter } from './usage';
import { agents } from '../config/agents';
import { selectModel } from '../config/models';
import { PartialPlan, Plan } from '../../protocol/types';

export type { PartialPlan, PartialPlanStep } from '../../protocol/types';

/**
 * A step-by-step plan for a "planning" request. The classifier decides a request
 * needs planning; the Planner turns it into an ordered list of concrete steps,
 * each optionally hinting which workspace tool it will use. The Executor
 * (./executor.ts) then walks these steps and drives the tool-calling loop.
 *
 * This is the generation schema: its describe() strings steer the model. The
 * protocol's PlanSchema (src/protocol/types.ts) is the wire shape of the same
 * data, without the prompt material; anything this schema accepts the protocol
 * schema accepts.
 */
export const PlanStepSchema = z.object({
  title: z
    .string()
    .describe('Short imperative description of the step, e.g. "Read package.json".'),
  detail: z
    .string()
    .describe(
      'One sentence of plain prose on what this step does and why it is needed. Never any code: no file contents, no snippets - the executor writes the code.'
    ),
});

export const PlanSchema = z.object({
  summary: z
    .string()
    .describe('One sentence restating the goal in your own words.'),
  steps: z
    .array(PlanStepSchema)
    .min(1)
    .max(8)
    .describe('Ordered steps that accomplish the task. Keep it minimal.'),
});

export type PlanStep = z.infer<typeof PlanStepSchema>;
export type PlanResult = Plan;

/** Receives plan snapshots as the model streams them. Must not throw. */
export type PlanProgress = (partial: PartialPlan) => void;

export class Planner {
  private readonly modelName = selectModel(agents.planner.capabilities).model;
  private readonly agent = new Agent({
    id: agents.planner.id,
    name: agents.planner.name,
    description: agents.planner.description,
    instructions: agents.planner.instructions,
    model: resolveModel(agents.planner.capabilities),
  });

  async plan(
    prompt: string,
    onPartial?: PlanProgress,
    onUsage?: UsageReporter
  ): Promise<PlanResult> {
    const output = await this.agent.stream(
      [{ role: 'user', content: prompt }],
      { structuredOutput: { schema: PlanSchema } }
    );
    // Drain the partial-object stream, forwarding each snapshot to the
    // caller; reading it is also what drives the generation to completion,
    // so this loop runs even when nobody listens.
    const reader = output.objectStream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value !== undefined) {
        onPartial?.(value as PartialPlan);
      }
    }
    const usage = await readUsage(output);
    if (usage) {
      onUsage?.({ model: this.modelName, ...usage });
    }
    // Validate rather than cast: a missing or malformed object fails here
    // with a schema error instead of rendering broken markdown later.
    return PlanSchema.parse(await output.object);
  }
}
