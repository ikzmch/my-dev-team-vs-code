import { createWorkflow, createStep } from '@mastra/core/workflows';
import type { RequestContext } from '@mastra/core/request-context';
import { z } from 'zod';
import { Triage, TriageSchema } from './triage';
import { Planner, PlanSchema, PartialPlan } from './planner';

/**
 * Step ids of the dev-team workflow. Exported so the UI layer can map the
 * run's step events onto progress labels (and failures onto error copy)
 * without magic strings.
 */
export const stepIds = {
  triage: 'triage',
  plan: 'draft-plan',
  answer: 'answer-directly',
} as const;

/** What the workflow consumes: the user's prompt (with attachments inlined). */
export const RequestSchema = z.object({ prompt: z.string() });
export type RequestInput = z.infer<typeof RequestSchema>;

/** Triage decision carried forward to the branch steps. */
const TriagedSchema = RequestSchema.extend(TriageSchema.shape);

/**
 * What the workflow produces: the routing decision plus, for "planning"
 * requests, the drafted plan. Rendering this into chat markdown is the UI
 * layer's job (see ui/chatParticipant.ts).
 */
export const ReplySchema = z.object({
  intent: TriageSchema.shape.intent,
  reason: z.string(),
  plan: PlanSchema.optional(),
});
export type ReplyResult = z.infer<typeof ReplySchema>;

/**
 * A snapshot of the reply while the run is still producing it: the triage
 * decision is always complete (it comes from buffered structured output), the
 * plan grows as the planner streams it.
 */
export type ReplyProgress = {
  intent: ReplyResult['intent'];
  reason: string;
  plan?: PartialPlan;
};

/** Receives reply snapshots as the workflow streams them. Must not throw. */
export type ReplyProgressSink = (progress: ReplyProgress) => void;

/**
 * RequestContext key under which a caller may pass a `ReplyProgressSink` to
 * `run.start`. The context is Mastra's per-run dependency channel, so the
 * sink reaches the steps without widening the input schema.
 */
export const replyProgressKey = 'onReplyProgress';

function progressSink(requestContext: RequestContext): ReplyProgressSink | undefined {
  return requestContext.get(replyProgressKey) as ReplyProgressSink | undefined;
}

/**
 * The agent's orchestration as a Mastra workflow:
 *
 *   triage ──▶ branch ──▶ draft-plan       (intent === "planning")
 *                     └─▶ answer-directly  (intent === "oneshot")
 *
 * An executor step that walks the drafted plan with the workspace tools is
 * the next roadmap item; until then "answer-directly" just reports the
 * routing decision.
 */
export function createDevTeamWorkflow(
  triage: Triage,
  planner: Planner
) {
  const triageStep = createStep({
    id: stepIds.triage,
    inputSchema: RequestSchema,
    outputSchema: TriagedSchema,
    execute: async ({ inputData }) => ({
      prompt: inputData.prompt,
      ...(await triage.classify(inputData.prompt)),
    }),
  });

  const draftPlan = createStep({
    id: stepIds.plan,
    inputSchema: TriagedSchema,
    outputSchema: ReplySchema,
    execute: async ({ inputData, requestContext }) => {
      const { intent, reason } = inputData;
      const sink = progressSink(requestContext);
      // Surface the triage decision right away, then forward every plan
      // snapshot the planner streams, so the UI can render tokens as they
      // arrive instead of waiting for the whole plan.
      sink?.({ intent, reason });
      const plan = await planner.plan(
        inputData.prompt,
        sink && ((partial) => sink({ intent, reason, plan: partial }))
      );
      return { intent, reason, plan };
    },
  });

  const answerDirectly = createStep({
    id: stepIds.answer,
    inputSchema: TriagedSchema,
    outputSchema: ReplySchema,
    execute: async ({ inputData, requestContext }) => {
      const { intent, reason } = inputData;
      progressSink(requestContext)?.({ intent, reason });
      return { intent, reason };
    },
  });

  // The generics are explicit because TS cannot infer them from the zod
  // schemas: a zod v4 schema matches more than one member of Mastra's
  // PublicSchema union, so inference collapses TInput/TOutput to `unknown`.
  return createWorkflow<'dev-team', unknown, RequestInput, ReplyResult>({
    id: 'dev-team',
    inputSchema: RequestSchema,
    outputSchema: ReplySchema,
  })
    .then(triageStep)
    .branch([
      [async ({ inputData }) => inputData.intent === 'planning', draftPlan],
      [async ({ inputData }) => inputData.intent !== 'planning', answerDirectly],
    ])
    // branch() emits { [stepId]: output }; flatten to the single reply.
    .map(async ({ inputData }) => inputData[stepIds.plan] ?? inputData[stepIds.answer])
    .commit();
}

export type DevTeamWorkflow = ReturnType<typeof createDevTeamWorkflow>;
