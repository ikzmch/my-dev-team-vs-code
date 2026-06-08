import { Agent } from '@mastra/core/agent';
import { z } from 'zod';
import { models } from './models';

/**
 * A step-by-step plan for a "planning" request. The classifier decides a request
 * needs planning; the Planner turns it into an ordered list of concrete steps,
 * each optionally hinting which workspace tool it will use. An executor (next
 * roadmap item) would walk these steps and drive the tool-calling loop.
 *
 * The `tool` hint maps to the four registered workspace tools (see
 * tools/workspaceTools.ts), or "none" for a step that is pure reasoning.
 */
export const PlanStepSchema = z.object({
  title: z
    .string()
    .describe('Short imperative description of the step, e.g. "Read package.json".'),
  tool: z
    .enum(['read', 'search', 'run', 'write', 'none'])
    .describe('The workspace tool this step will likely use, or "none" for pure reasoning.'),
  detail: z
    .string()
    .describe('One sentence on what this step does and why it is needed.'),
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

const INSTRUCTIONS = `You are a planner for a coding assistant inside VS Code.

The user's request has already been classified as needing a multi-step plan.
Draft the shortest ordered sequence of concrete steps that accomplishes it.

You have exactly four tools available:
- "read": read the full text of one workspace file.
- "search": find files by glob, or find text inside files.
- "run": run a shell command (e.g. tests, build, git) in the workspace root.
- "write": create or overwrite a file.
Use "none" for a step that is just reasoning with no tool call.

Rules:
- Prefer exploration (search/read) before any edit (write) or command (run).
- Keep the plan minimal: only the steps actually required, never more than 8.
- Each step must be a single, concrete action, not a vague goal.
- Do not invent file paths you have not been told about; use a search step first.

Respond with a JSON object matching the provided schema.`;

export class Planner {
  private readonly agent = new Agent({
    id: 'planner',
    name: 'Planner',
    instructions: INSTRUCTIONS,
    model: models.plan,
  });

  async plan(prompt: string): Promise<PlanResult> {
    const result = await this.agent.generate(
      [{ role: 'user', content: prompt }],
      { structuredOutput: { schema: PlanSchema } }
    );
    return result.object as PlanResult;
  }
}
