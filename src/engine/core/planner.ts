import { Agent } from '@mastra/core/agent';
import { z } from 'zod';
import { resolveModel, routeModel } from './models';
import { resolveTokenCounts, UsageReporter } from './usage';
import { parseWithRepair } from './repair';
import { agents } from '../config/agents';
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
  private readonly modelName: string;
  private readonly agent: Agent;

  /**
   * `modelPin` is the user's per-run model choice (a registry id, or "auto"/
   * undefined to let the capability router pick the best available model). It
   * is resolved once here because the LocalEngine builds a fresh Planner per
   * run with the run request's choice.
   */
  constructor(modelPin?: string) {
    this.modelName = routeModel(agents.planner.capabilities, modelPin).model;
    this.agent = new Agent({
      id: agents.planner.id,
      name: agents.planner.name,
      description: agents.planner.description,
      instructions: agents.planner.instructions,
      model: resolveModel(agents.planner.capabilities, modelPin),
    });
  }

  async plan(
    prompt: string,
    onPartial?: PlanProgress,
    onUsage?: UsageReporter
  ): Promise<PlanResult> {
    // Validate rather than cast: a missing or malformed object would otherwise
    // render as broken markdown later. On a validation failure, parseWithRepair
    // re-asks once with the zod issues appended (see ./repair.ts) before the
    // step fails for real; a repair attempt simply re-streams a fresh plan,
    // which overwrites the partial snapshots already shown.
    return parseWithRepair(PlanSchema, async (repair) => {
      const content = repair ? `${prompt}\n\n${repair}` : prompt;
      const output = await this.agent.stream(
        [{ role: 'user', content }],
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
      const plan = await output.object;
      const counts = await resolveTokenCounts(output, content, JSON.stringify(plan ?? {}));
      // The retry is a real second model call: report it (flagged repaired) so
      // the billing seam and the eval log see the extra spend.
      onUsage?.({
        model: this.modelName,
        ...counts,
        ...(repair ? { repaired: true } : {}),
      });
      return plan;
    });
  }
}
