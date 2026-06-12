import { createWorkflow, createStep } from '@mastra/core/workflows';
import type { RequestContext } from '@mastra/core/request-context';
import { z } from 'zod';
import { Triage, TriageSchema } from './triage';
import { Planner, PlanSchema, PartialPlan } from './planner';
import { Answerer } from './answerer';

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

/** One attached file/selection: a short label naming it plus its (already truncated) text. */
export const AttachmentSchema = z.object({
  label: z.string(),
  text: z.string(),
});
export type Attachment = z.infer<typeof AttachmentSchema>;

/**
 * What the workflow consumes: the user's prompt plus any attached
 * files/selections. They stay separate so each step can decide how much of
 * the attachment text its model actually needs to see - important with small
 * local Ollama models, whose context windows a single attached file can
 * easily crowd out.
 */
export const RequestSchema = z.object({
  prompt: z.string(),
  attachments: z.array(AttachmentSchema).optional(),
});
export type RequestInput = z.infer<typeof RequestSchema>;

/**
 * The prompt the triage agent sees: the question plus attachment names only.
 * Triage just routes oneshot vs planning, so inlining file contents would
 * waste tokens and, on a small local model, push the actual question out of
 * the context window.
 */
export function triagePrompt(input: RequestInput): string {
  const attachments = input.attachments ?? [];
  if (attachments.length === 0) {
    return input.prompt;
  }
  const labels = attachments.map((a) => a.label).join('; ');
  return `${input.prompt}\n\n(The user attached context, contents omitted here: ${labels})`;
}

/**
 * The prompt the planner and answerer see: the question plus the full
 * attachment text, one fenced block per attachment.
 */
export function fullPrompt(input: RequestInput): string {
  const attachments = input.attachments ?? [];
  if (attachments.length === 0) {
    return input.prompt;
  }
  const blocks = attachments.map((a) => `${a.label}\n\`\`\`\n${a.text}\n\`\`\``);
  return `${input.prompt}\n\n--- Attached context ---\n${blocks.join('\n\n')}`;
}

/** Triage decision carried forward to the branch steps. */
const TriagedSchema = RequestSchema.extend(TriageSchema.shape);

/**
 * What the workflow produces: the routing decision plus, for "planning"
 * requests, the drafted plan, or, for "oneshot" requests, the direct answer.
 * Rendering this into chat markdown is the UI layer's job (see
 * ui/chatParticipant.ts).
 */
export const ReplySchema = z.object({
  intent: TriageSchema.shape.intent,
  reason: z.string(),
  plan: PlanSchema.optional(),
  answer: z.string().optional(),
});
export type ReplyResult = z.infer<typeof ReplySchema>;

/**
 * A snapshot of the reply while the run is still producing it: the triage
 * decision is always complete (it comes from buffered structured output), the
 * plan grows as the planner streams it, the answer grows as the answerer
 * streams it.
 */
export type ReplyProgress = {
  intent: ReplyResult['intent'];
  reason: string;
  plan?: PartialPlan;
  answer?: string;
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
 * "answer-directly" streams a real answer from the Answerer agent. An
 * executor step that walks the drafted plan with the workspace tools is the
 * next roadmap item.
 */
export function createDevTeamWorkflow(
  triage: Triage,
  planner: Planner,
  answerer: Answerer
) {
  const triageStep = createStep({
    id: stepIds.triage,
    inputSchema: RequestSchema,
    outputSchema: TriagedSchema,
    execute: async ({ inputData }) => ({
      prompt: inputData.prompt,
      attachments: inputData.attachments,
      ...(await triage.classify(triagePrompt(inputData))),
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
        fullPrompt(inputData),
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
      const sink = progressSink(requestContext);
      // Surface the triage decision right away, then forward every answer
      // snapshot the answerer streams, mirroring the draft-plan step.
      sink?.({ intent, reason });
      const answer = await answerer.answer(
        fullPrompt(inputData),
        sink && ((text) => sink({ intent, reason, answer: text }))
      );
      return { intent, reason, answer };
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
