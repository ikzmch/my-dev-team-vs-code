import { Agent } from '@mastra/core/agent';
import { z } from 'zod';
import { resolveModel, routeModel } from './models';
import { resolveTokenCounts, UsageReporter } from './usage';
import { parseWithRepair } from './repair';
import { agents } from '../config/agents';
import { Complexity, ComplexitySchema, PartialPlan, Plan } from '../../protocol/types';

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

/**
 * One pivotal design or architectural choice behind the plan, with its reason.
 * Surfaced at the approval gate so the user can judge (and, via Revise, veto)
 * the *approach* before it runs, not just the list of steps. Populated only for
 * genuinely complex changes where the choice matters - see the field's
 * describe() on `PlanSchema.decisions`.
 */
export const PlanDecisionNoteSchema = z.object({
  decision: z
    .string()
    .describe('One key design or architectural choice, stated plainly. Never code.'),
  rationale: z
    .string()
    .describe('One sentence on why this choice over the alternative.'),
});

export const PlanSchema = z.object({
  summary: z
    .string()
    .describe('One sentence restating the goal in your own words.'),
  steps: z
    .array(PlanStepSchema)
    .min(1)
    .max(12)
    .describe(
      'Ordered steps that accomplish the task. Keep it minimal - only the ' +
        'steps actually required, typically 8 or fewer, and never more than 12.'
    ),
  decisions: z
    .array(PlanDecisionNoteSchema)
    .max(3)
    .optional()
    .describe(
      'Up to three pivotal design or architectural decisions behind this plan, ' +
        'each with a one-sentence rationale. Include them ONLY for a complex ' +
        'change where a design choice materially shapes the work and the user ' +
        'benefits from seeing it before approving. Omit the field entirely for a ' +
        'simple or moderate change, or when the plan is self-explanatory. Never ' +
        'code - describe the choice in prose.'
    ),
  complexity: ComplexitySchema.describe(
    'How demanding the work in this plan actually is, now that you have seen ' +
      'the request and any explored context: "simple" for a self-contained ' +
      'change needing little reasoning (e.g. one small file); "moderate" for a ' +
      'typical change touching a few files; "complex" for multi-file changes, ' +
      'subtle debugging, or architectural/performance work. Be honest - a ' +
      '"complex" plan is paused for the user to approve before it runs.'
  ),
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
   * undefined to let the capability router pick the best available model).
   * `complexity` is triage's pre-exploration judgement of how demanding the
   * work is: it narrows the routed model to that tier (cheaper for simple work,
   * stronger for complex), unless the user pinned a model or turned
   * `complexityRouting` off - exactly like the executor. The planner is built
   * once the triage complexity is known (the workflow's draft-plan step builds
   * it), so both are resolved here.
   */
  constructor(modelPin?: string, complexity?: Complexity) {
    this.modelName = routeModel(
      agents.planner.capabilities,
      modelPin,
      undefined,
      complexity
    ).model;
    this.agent = new Agent({
      id: agents.planner.id,
      name: agents.planner.name,
      description: agents.planner.description,
      instructions: agents.planner.instructions,
      model: resolveModel(agents.planner.capabilities, modelPin, undefined, complexity),
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
