import { createWorkflow, createStep } from '@mastra/core/workflows';
import type { RequestContext } from '@mastra/core/request-context';
import { z } from 'zod';
import { Triage, TriageSchema } from './triage';
import { Planner, PlanProgress } from './planner';
import { Answerer } from './answerer';
import { Executor, ExecutionProgress } from './executor';
import { AgentUsage } from './usage';
import { commandConfigs, pinnedReason, CommandConfig } from '../config/commands';
import {
  Attachment,
  AttachmentSchema,
  HistoryTurn,
  HistoryTurnSchema,
  Plan,
  ReplyProgress,
  ReplySchema,
  Reply,
} from '../../protocol/types';
import { RunStep } from '../../protocol/events';

export type { Attachment, HistoryTurn, ReplyProgress } from '../../protocol/types';

/**
 * Step ids of the dev-team workflow. Engine-internal: the LocalEngine maps a
 * failed step onto the protocol's RunStep names, so nothing outside the
 * engine depends on these strings.
 */
export const stepIds = {
  triage: 'triage',
  plan: 'draft-plan',
  answer: 'answer-directly',
  execute: 'execute-plan',
  deliver: 'deliver-answer',
} as const;

/**
 * What the workflow consumes: the user's prompt plus any attached
 * files/selections, the prior turns of the conversation, and the slash
 * command the user invoked, if any. They stay separate so each step can
 * decide how much of each its model actually needs to see - important with
 * small local Ollama models, whose context windows a single attached file can
 * easily crowd out.
 */
export const RequestSchema = z.object({
  prompt: z.string(),
  attachments: z.array(AttachmentSchema).optional(),
  history: z.array(HistoryTurnSchema).optional(),
  command: z.string().optional(),
});
export type RequestInput = z.infer<typeof RequestSchema>;

/**
 * The registered config of the request's slash command. An unknown command
 * name (a client newer than this engine) resolves to undefined: the prompt is
 * then treated as plain text, so version skew degrades, never breaks.
 */
function commandFor(input: RequestInput): CommandConfig | undefined {
  return input.command ? commandConfigs[input.command] : undefined;
}

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
 * The prompt the planner and answerer see: the conversation so far, the slash
 * command's preamble (when one was invoked - the preamble frames the request,
 * e.g. /fix's diagnose-first briefing), the question, and the full attachment
 * text, one fenced block per attachment. Triage never sees the preamble: when
 * a command is known its route is pinned and triage is skipped.
 */
export function fullPrompt(input: RequestInput): string {
  const preamble = commandFor(input)?.preamble;
  const prompt = preamble ? `${preamble}\n\n${input.prompt}` : input.prompt;
  const attachments = input.attachments ?? [];
  if (attachments.length === 0) {
    return withHistory(input, prompt);
  }
  const blocks = attachments.map((a) => `${a.label}\n\`\`\`\n${a.text}\n\`\`\``);
  return withHistory(
    input,
    `${prompt}\n\n--- Attached context ---\n${blocks.join('\n\n')}`
  );
}

/**
 * The prompt the executor sees: the full request (prompt + attachment text,
 * same as the planner saw) plus the plan it is asked to carry out, rendered
 * as a numbered list with the tool hints.
 */
export function executionPrompt(input: RequestInput, plan: Plan): string {
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
 * What the workflow produces is the protocol's Reply: the routing decision
 * plus, for "planning" requests, the drafted plan and the execution
 * transcript, or, for "oneshot" requests, the direct answer. Using the
 * protocol schema as the output schema is the guarantee that the engine
 * cannot produce a reply the contract does not describe.
 */
export type ReplyResult = Reply;

/**
 * The reply plus the original request, used between the two branch stages:
 * the execute step still needs the prompt and attachments to brief the
 * executor, so the branch steps carry them forward and the final steps strip
 * them off again.
 */
const StagedReplySchema = RequestSchema.extend(ReplySchema.shape);
type StagedReply = z.infer<typeof StagedReplySchema>;

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
 * One step's metering record: the agent's usage report plus which protocol
 * step it came from. The LocalEngine forwards these as the protocol's usage
 * events - the billing seam.
 */
export type StepUsage = { step: RunStep } & AgentUsage;

/** Receives per-step usage reports. Must not throw. */
export type UsageSink = (usage: StepUsage) => void;

/**
 * RequestContext key under which a caller may pass a `UsageSink` to
 * `run.start`. Reporting is best-effort: a step whose model call exposes no
 * token counts simply never calls the sink.
 */
export const usageSinkKey = 'onUsage';

function usageSink(requestContext: RequestContext): UsageSink | undefined {
  return requestContext.get(usageSinkKey) as UsageSink | undefined;
}

/** Adapt the run's UsageSink into one agent's reporter, tagging the step. */
function usageReporter(
  requestContext: RequestContext,
  step: RunStep
): ((usage: AgentUsage) => void) | undefined {
  const sink = usageSink(requestContext);
  return sink && ((usage) => sink({ step, ...usage }));
}

/**
 * RequestContext key under which a caller may pass an `AbortSignal` to
 * `run.start`. The executor forwards it to its tool-calling loop so a
 * cancelled chat request stops an in-flight command or write, not just the
 * next workflow step.
 */
export const abortSignalKey = 'abortSignal';

function abortSignal(requestContext: RequestContext): AbortSignal | undefined {
  return requestContext.get(abortSignalKey) as AbortSignal | undefined;
}

/**
 * The agent's orchestration as a Mastra workflow:
 *
 *   triage ──▶ branch ──▶ draft-plan       (intent === "planning")
 *          │          └─▶ answer-directly  (intent === "oneshot")
 *          ▼
 *             branch ──▶ execute-plan      (a plan was drafted and the
 *                    │                      command did not opt out)
 *                    └─▶ deliver-answer    (oneshot and plan-only paths;
 *                                           pass-through)
 *
 * "answer-directly" streams a real answer from the Answerer agent;
 * "execute-plan" walks the drafted plan with the Executor's tool-calling
 * loop. The second branch is a branch rather than a plain step so a oneshot
 * (or plan-only) run never starts an executor step. A known slash command on
 * the request pins the triage decision without a model call, and a command
 * with `execute: false` (/plan) stops the run after the plan is drafted.
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
    execute: async ({ inputData, requestContext }) => {
      // A known slash command pins the route: the user typing /fix already is
      // the routing decision, so the triage model call would only add latency
      // and a chance to misroute. The pinned reason renders where the model's
      // reason would, so the UI needs no special case.
      const command = commandFor(inputData);
      const decision = command
        ? { intent: command.intent, reason: pinnedReason(command.name) }
        : await triage.classify(
            triagePrompt(inputData),
            usageReporter(requestContext, 'triage')
          );
      return {
        prompt: inputData.prompt,
        attachments: inputData.attachments,
        history: inputData.history,
        command: inputData.command,
        ...decision,
      };
    },
  });

  const draftPlan = createStep({
    id: stepIds.plan,
    inputSchema: TriagedSchema,
    outputSchema: StagedReplySchema,
    execute: async ({ inputData, requestContext }) => {
      const { prompt, attachments, history, command, intent, reason } = inputData;
      const sink = progressSink(requestContext);
      // Surface the triage decision right away, then forward every plan
      // snapshot the planner streams, so the UI can render tokens as they
      // arrive instead of waiting for the whole plan.
      sink?.({ intent, reason });
      const onPartial: PlanProgress | undefined =
        sink && ((partial) => sink({ intent, reason, plan: partial }));
      const plan = await planner.plan(
        fullPrompt(inputData),
        onPartial,
        usageReporter(requestContext, 'plan')
      );
      return { prompt, attachments, history, command, intent, reason, plan };
    },
  });

  const answerDirectly = createStep({
    id: stepIds.answer,
    inputSchema: TriagedSchema,
    outputSchema: StagedReplySchema,
    execute: async ({ inputData, requestContext }) => {
      const { prompt, attachments, history, command, intent, reason } = inputData;
      const sink = progressSink(requestContext);
      // Surface the triage decision right away, then forward every answer
      // snapshot the answerer streams, mirroring the draft-plan step.
      sink?.({ intent, reason });
      const answer = await answerer.answer(
        fullPrompt(inputData),
        sink && ((text) => sink({ intent, reason, answer: text })),
        usageReporter(requestContext, 'answer')
      );
      return { prompt, attachments, history, command, intent, reason, answer };
    },
  });

  const executePlan = createStep({
    id: stepIds.execute,
    inputSchema: StagedReplySchema,
    outputSchema: ReplySchema,
    execute: async ({ inputData, requestContext }) => {
      const { prompt, attachments, history, command, intent, reason, plan } = inputData;
      if (!plan) {
        throw new Error('execute-plan reached without a drafted plan.');
      }
      const sink = progressSink(requestContext);
      // Complete the plan render before execution output starts, then
      // forward every transcript snapshot the executor produces.
      sink?.({ intent, reason, plan });
      const onPartial: ExecutionProgress | undefined =
        sink && ((partial) => sink({ intent, reason, plan, execution: partial }));
      const execution = await executor.execute(
        executionPrompt({ prompt, attachments, history, command }, plan),
        onPartial,
        abortSignal(requestContext),
        usageReporter(requestContext, 'execute')
      );
      return { intent, reason, plan, execution };
    },
  });

  // The oneshot path is already complete after answer-directly, and a
  // plan-only run (a command with execute: false) after draft-plan; this
  // pass-through only strips the carried request fields back off.
  const deliverAnswer = createStep({
    id: stepIds.deliver,
    inputSchema: StagedReplySchema,
    outputSchema: ReplySchema,
    execute: async ({ inputData }) => ({
      intent: inputData.intent,
      reason: inputData.reason,
      plan: inputData.plan,
      answer: inputData.answer,
    }),
  });

  // A drafted plan is executed unless the run's slash command opted out
  // (/plan stops after drafting, so the user can inspect the steps first).
  const shouldExecute = async ({ inputData }: { inputData: StagedReply }) =>
    inputData.plan !== undefined && commandFor(inputData)?.execute !== false;

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
      [shouldExecute, executePlan],
      [
        async (args: { inputData: StagedReply }) => !(await shouldExecute(args)),
        deliverAnswer,
      ],
    ])
    .map(
      async ({ inputData }) => inputData[stepIds.execute] ?? inputData[stepIds.deliver]
    )
    .commit();
}

export type DevTeamWorkflow = ReturnType<typeof createDevTeamWorkflow>;
