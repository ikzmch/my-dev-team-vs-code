import { createWorkflow, createStep } from '@mastra/core/workflows';
import { z } from 'zod';
import { IntentClassifier, IntentSchema } from './intentClassifier';
import { Planner, PlanSchema } from './planner';

/**
 * Step ids of the dev-team workflow. Exported so the UI layer can map the
 * run's step events onto progress labels (and failures onto error copy)
 * without magic strings.
 */
export const stepIds = {
  classify: 'classify-intent',
  plan: 'draft-plan',
  answer: 'answer-directly',
} as const;

/** What the workflow consumes: the user's prompt (with attachments inlined). */
export const RequestSchema = z.object({ prompt: z.string() });
export type RequestInput = z.infer<typeof RequestSchema>;

/** Classification carried forward to the branch steps. */
const ClassifiedSchema = RequestSchema.extend(IntentSchema.shape);

/**
 * What the workflow produces: the routing decision plus, for "planning"
 * requests, the drafted plan. Rendering this into chat markdown is the UI
 * layer's job (see ui/chatParticipant.ts).
 */
export const ReplySchema = z.object({
  intent: IntentSchema.shape.intent,
  reason: z.string(),
  plan: PlanSchema.optional(),
});
export type ReplyResult = z.infer<typeof ReplySchema>;

/**
 * The agent's orchestration as a Mastra workflow:
 *
 *   classify-intent ──▶ branch ──▶ draft-plan       (intent === "planning")
 *                              └─▶ answer-directly  (intent === "oneshot")
 *
 * An executor step that walks the drafted plan with the workspace tools is
 * the next roadmap item; until then "answer-directly" just reports the
 * routing decision.
 */
export function createDevTeamWorkflow(
  classifier: IntentClassifier,
  planner: Planner
) {
  const classify = createStep({
    id: stepIds.classify,
    inputSchema: RequestSchema,
    outputSchema: ClassifiedSchema,
    execute: async ({ inputData }) => ({
      prompt: inputData.prompt,
      ...(await classifier.classify(inputData.prompt)),
    }),
  });

  const draftPlan = createStep({
    id: stepIds.plan,
    inputSchema: ClassifiedSchema,
    outputSchema: ReplySchema,
    execute: async ({ inputData }) => ({
      intent: inputData.intent,
      reason: inputData.reason,
      plan: await planner.plan(inputData.prompt),
    }),
  });

  const answerDirectly = createStep({
    id: stepIds.answer,
    inputSchema: ClassifiedSchema,
    outputSchema: ReplySchema,
    execute: async ({ inputData }) => ({
      intent: inputData.intent,
      reason: inputData.reason,
    }),
  });

  // The generics are explicit because TS cannot infer them from the zod
  // schemas: a zod v4 schema matches more than one member of Mastra's
  // PublicSchema union, so inference collapses TInput/TOutput to `unknown`.
  return createWorkflow<'dev-team', unknown, RequestInput, ReplyResult>({
    id: 'dev-team',
    inputSchema: RequestSchema,
    outputSchema: ReplySchema,
  })
    .then(classify)
    .branch([
      [async ({ inputData }) => inputData.intent === 'planning', draftPlan],
      [async ({ inputData }) => inputData.intent !== 'planning', answerDirectly],
    ])
    // branch() emits { [stepId]: output }; flatten to the single reply.
    .map(async ({ inputData }) => inputData[stepIds.plan] ?? inputData[stepIds.answer])
    .commit();
}

export type DevTeamWorkflow = ReturnType<typeof createDevTeamWorkflow>;
