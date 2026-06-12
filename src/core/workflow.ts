import { createWorkflow, createStep } from '@mastra/core/workflows';
import type { RequestContext } from '@mastra/core/request-context';
import { z } from 'zod';
import { Triage, TriageSchema } from './triage';
import { Planner, PlanSchema, PlanResult, PartialPlan } from './planner';
import { Answerer } from './answerer';
import { Executor, ExecutionSchema, PartialExecution } from './executor';

/**
 * Step ids of the dev-team workflow. Exported so the UI layer can map
 * step failures onto error copy without magic strings.
 */
export const stepIds = {
  triage: 'triage',
  plan: 'draft-plan',
  answer: 'answer-directly',
  execute: 'execute-plan',
  deliver: 'deliver-answer',
} as const;

/** One attached file/selection: a short label naming it plus its (already truncated) text. */
export const AttachmentSchema = z.object({
  label: z.string(),
  text: z.string(),
});
export type Attachment = z.infer<typeof AttachmentSchema>;

/**
 * One prior turn of the conversation: who said it (the user, or this
 * participant) and its (already capped) text. The UI layer converts VS Code's
 * ChatContext.history into these before starting a run, applying the
 * settings.history caps, so the workflow never sees an unbounded session.
 */
export const HistoryTurnSchema = z.object({
  role: z.enum(['user', 'assistant']),
  text: z.string(),
});
export type HistoryTurn = z.infer<typeof HistoryTurnSchema>;

/**
 * What the workflow consumes: the user's prompt plus any attached
 * files/selections and the prior turns of the conversation. They stay
 * separate so each step can decide how much of each its model actually needs
 * to see - important with small local Ollama models, whose context windows a
 * single attached file can easily crowd out.
 */
export const RequestSchema = z.object({
  prompt: z.string(),
  attachments: z.array(AttachmentSchema).optional(),
  history: z.array(HistoryTurnSchema).optional(),
});
export type RequestInput = z.infer<typeof RequestSchema>;

/**
 * The prior turns rendered as a clearly delimited conversation section, so a
 * follow-up like "now rename it too" carries the turns that say what "it" is.
 * Every agent prompt gets the same section (triage included: a follow-up
 * cannot be routed without the conversation it follows); the per-turn and
 * turn-count caps were already applied when the turns were collected.
 */
function historySection(history: HistoryTurn[]): string {
  const turns = history.map(
    (turn) => `${turn.role === 'user' ? 'User' : 'Assistant'}: ${turn.text}`
  );
  return `--- Conversation so far ---\n${turns.join('\n\n')}\n--- End of conversation ---`;
}

/** Prepend the conversation section when there is one; the bare body otherwise. */
function withHistory(input: RequestInput, body: string): string {
  const history = input.history ?? [];
  return history.length === 0 ? body : `${historySection(history)}\n\n${body}`;
}

/**
 * The prompt the triage agent sees: the conversation so far, the question,
 * and attachment names only. Triage just routes oneshot vs planning, so
 * inlining file contents would waste tokens and, on a small local model, push
 * the actual question out of the context window - but it does get the (capped)
 * history, because a follow-up cannot be routed without it.
 */
export function triagePrompt(input: RequestInput): string {
  const attachments = input.attachments ?? [];
  if (attachments.length === 0) {
    return withHistory(input, input.prompt);
  }
  const labels = attachments.map((a) => a.label).join('; ');
  return withHistory(
    input,
    `${input.prompt}\n\n(The user attached context, contents omitted here: ${labels})`
  );
}

/**
 * The prompt the planner and answerer see: the conversation so far, the
 * question, and the full attachment text, one fenced block per attachment.
 */
export function fullPrompt(input: RequestInput): string {
  const attachments = input.attachments ?? [];
  if (attachments.length === 0) {
    return withHistory(input, input.prompt);
  }
  const blocks = attachments.map((a) => `${a.label}\n\`\`\`\n${a.text}\n\`\`\``);
  return withHistory(
    input,
    `${input.prompt}\n\n--- Attached context ---\n${blocks.join('\n\n')}`
  );
}

/**
 * The prompt the executor sees: the full request (prompt + attachment text,
 * same as the planner saw) plus the plan it is asked to carry out, rendered
 * as a numbered list with the tool hints.
 */
export function executionPrompt(input: RequestInput, plan: PlanResult): string {
  const steps = plan.steps
    .map(
      (step, i) =>
        `${i + 1}. ${step.title}` +
        (step.tool !== 'none' ? ` (tool: ${step.tool})` : '') +
        ` - ${step.detail}`
    )
    .join('\n');
  return `${fullPrompt(input)}\n\n--- Drafted plan ---\n${plan.summary}\n${steps}`;
}

/** Triage decision carried forward to the branch steps. */
const TriagedSchema = RequestSchema.extend(TriageSchema.shape);

/**
 * What the workflow produces: the routing decision plus, for "planning"
 * requests, the drafted plan and the execution transcript, or, for "oneshot"
 * requests, the direct answer. Rendering this into chat markdown is the UI
 * layer's job (see ui/chatParticipant.ts).
 */
export const ReplySchema = z.object({
  intent: TriageSchema.shape.intent,
  reason: z.string(),
  plan: PlanSchema.optional(),
  answer: z.string().optional(),
  execution: ExecutionSchema.optional(),
});
export type ReplyResult = z.infer<typeof ReplySchema>;

/**
 * The reply plus the original request, used between the two branch stages:
 * the execute step still needs the prompt and attachments to brief the
 * executor, so the branch steps carry them forward and the final steps strip
 * them off again.
 */
const StagedReplySchema = RequestSchema.extend(ReplySchema.shape);
type StagedReply = z.infer<typeof StagedReplySchema>;

/**
 * A snapshot of the reply while the run is still producing it: the triage
 * decision is always complete (it comes from buffered structured output), the
 * plan grows as the planner streams it, the answer grows as the answerer
 * streams it, and the execution transcript grows as the executor calls tools.
 */
export type ReplyProgress = {
  intent: ReplyResult['intent'];
  reason: string;
  plan?: PartialPlan;
  answer?: string;
  execution?: PartialExecution;
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
 *          │          └─▶ answer-directly  (intent === "oneshot")
 *          ▼
 *             branch ──▶ execute-plan      (a plan was drafted)
 *                    └─▶ deliver-answer    (the oneshot path; pass-through)
 *
 * "answer-directly" streams a real answer from the Answerer agent;
 * "execute-plan" walks the drafted plan with the Executor's tool-calling
 * loop. The second branch is a branch rather than a plain step so a oneshot
 * run never starts an executor step.
 */
export function createDevTeamWorkflow(
  triage: Triage,
  planner: Planner,
  answerer: Answerer,
  executor: Executor
) {
  const triageStep = createStep({
    id: stepIds.triage,
    inputSchema: RequestSchema,
    outputSchema: TriagedSchema,
    execute: async ({ inputData }) => ({
      prompt: inputData.prompt,
      attachments: inputData.attachments,
      history: inputData.history,
      ...(await triage.classify(triagePrompt(inputData))),
    }),
  });

  const draftPlan = createStep({
    id: stepIds.plan,
    inputSchema: TriagedSchema,
    outputSchema: StagedReplySchema,
    execute: async ({ inputData, requestContext }) => {
      const { prompt, attachments, history, intent, reason } = inputData;
      const sink = progressSink(requestContext);
      // Surface the triage decision right away, then forward every plan
      // snapshot the planner streams, so the UI can render tokens as they
      // arrive instead of waiting for the whole plan.
      sink?.({ intent, reason });
      const plan = await planner.plan(
        fullPrompt(inputData),
        sink && ((partial) => sink({ intent, reason, plan: partial }))
      );
      return { prompt, attachments, history, intent, reason, plan };
    },
  });

  const answerDirectly = createStep({
    id: stepIds.answer,
    inputSchema: TriagedSchema,
    outputSchema: StagedReplySchema,
    execute: async ({ inputData, requestContext }) => {
      const { prompt, attachments, history, intent, reason } = inputData;
      const sink = progressSink(requestContext);
      // Surface the triage decision right away, then forward every answer
      // snapshot the answerer streams, mirroring the draft-plan step.
      sink?.({ intent, reason });
      const answer = await answerer.answer(
        fullPrompt(inputData),
        sink && ((text) => sink({ intent, reason, answer: text }))
      );
      return { prompt, attachments, history, intent, reason, answer };
    },
  });

  const executePlan = createStep({
    id: stepIds.execute,
    inputSchema: StagedReplySchema,
    outputSchema: ReplySchema,
    execute: async ({ inputData, requestContext }) => {
      const { prompt, attachments, history, intent, reason, plan } = inputData;
      if (!plan) {
        throw new Error('execute-plan reached without a drafted plan.');
      }
      const sink = progressSink(requestContext);
      // Complete the plan render before execution output starts, then
      // forward every transcript snapshot the executor produces.
      sink?.({ intent, reason, plan });
      const execution = await executor.execute(
        executionPrompt({ prompt, attachments, history }, plan),
        sink && ((partial) => sink({ intent, reason, plan, execution: partial }))
      );
      return { intent, reason, plan, execution };
    },
  });

  // The oneshot path is already complete after answer-directly; this
  // pass-through only strips the carried request fields back off.
  const deliverAnswer = createStep({
    id: stepIds.deliver,
    inputSchema: StagedReplySchema,
    outputSchema: ReplySchema,
    execute: async ({ inputData }) => ({
      intent: inputData.intent,
      reason: inputData.reason,
      answer: inputData.answer,
    }),
  });

  const hasPlan = async ({ inputData }: { inputData: StagedReply }) =>
    inputData.plan !== undefined;

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
    // branch() emits { [stepId]: output }; flatten to the single staged reply.
    .map(async ({ inputData }) => inputData[stepIds.plan] ?? inputData[stepIds.answer])
    .branch([
      [hasPlan, executePlan],
      [async (args: { inputData: StagedReply }) => !(await hasPlan(args)), deliverAnswer],
    ])
    .map(
      async ({ inputData }) => inputData[stepIds.execute] ?? inputData[stepIds.deliver]
    )
    .commit();
}

export type DevTeamWorkflow = ReturnType<typeof createDevTeamWorkflow>;
