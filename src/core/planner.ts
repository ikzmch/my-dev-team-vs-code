import { Agent } from '@mastra/core/agent';
import { z } from 'zod';
import { resolveModel } from './models';
import { agents } from '../config/agents';
import { toolNames } from '../config/tools';

/**
 * A step-by-step plan for a "planning" request. The classifier decides a request
 * needs planning; the Planner turns it into an ordered list of concrete steps,
 * each optionally hinting which workspace tool it will use. The Executor
 * (core/executor.ts) then walks these steps and drives the tool-calling loop.
 *
 * The `tool` hint enum is derived from the tool configs in config/tools (the
 * same registry the planner's prompt section is rendered from), plus "none"
 * for a step that is pure reasoning.
 */
// "none" leads so the enum stays well-formed even with an empty tool registry.
const planTools: [string, ...string[]] = ['none', ...toolNames];

export const PlanStepSchema = z.object({
  title: z
    .string()
    .describe('Short imperative description of the step, e.g. "Read package.json".'),
  tool: z
    .enum(planTools)
    .describe('The workspace tool this step will likely use, or "none" for pure reasoning.'),
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
export type PlanResult = z.infer<typeof PlanSchema>;

/**
 * A snapshot of the plan while the model is still writing it. Field values
 * arrive incrementally from the partial-JSON stream: strings grow over time
 * and later fields are missing until the model reaches them, so everything is
 * optional and `tool` may hold a not-yet-complete enum value.
 */
export type PartialPlanStep = {
  title?: string;
  tool?: string;
  detail?: string;
};
export type PartialPlan = {
  summary?: string;
  steps?: Array<PartialPlanStep | undefined>;
};

/** Receives plan snapshots as the model streams them. Must not throw. */
export type PlanProgress = (partial: PartialPlan) => void;

export class Planner {
  private readonly agent = new Agent({
    id: agents.planner.id,
    name: agents.planner.name,
    description: agents.planner.description,
    instructions: agents.planner.instructions,
    model: resolveModel(agents.planner.capabilities),
  });

  async plan(prompt: string, onPartial?: PlanProgress): Promise<PlanResult> {
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
    // Validate rather than cast: a missing or malformed object fails here
    // with a schema error instead of rendering broken markdown later.
    return PlanSchema.parse(await output.object);
  }
}
