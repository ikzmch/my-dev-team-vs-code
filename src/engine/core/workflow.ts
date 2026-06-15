import { createWorkflow, createStep } from '@mastra/core/workflows';
import type { RequestContext } from '@mastra/core/request-context';
import { z } from 'zod';
import { Triage, TriageSchema } from './triage';
import { Planner, PlanProgress } from './planner';
import { Answerer } from './answerer';
import { Executor, ExecutionProgress } from './executor';
import { Summarizer, SummaryProgress } from './summarizer';
import { AgentUsage, estimateTokens } from './usage';
import { commandConfigs, pinnedReason, CommandConfig } from '../config/commands';
import { resolveSkills, renderSkillsSection, SkillSummary } from '../config/skills';
import { settings } from '../../config/settings';
import {
  Attachment,
  AttachmentSchema,
  Complexity,
  ComplexitySchema,
  Execution,
  HistoryTurn,
  HistoryTurnSchema,
  Intent,
  Plan,
  PlanDecision,
  ProjectInstructionsSchema,
  ReplyProgress,
  ReplySchema,
  Reply,
  WorkspaceSkillSchema,
} from '../../protocol/types';
import { InputBreakdown, RunStep } from '../../protocol/events';

export type {
  Attachment,
  HistoryTurn,
  ProjectInstructions,
  ReplyProgress,
} from '../../protocol/types';

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
  instructions: ProjectInstructionsSchema.optional(),
  attachments: z.array(AttachmentSchema).optional(),
  history: z.array(HistoryTurnSchema).optional(),
  /**
   * Workspace skills the client read (raw SKILL.md text). Only the executor
   * consumes them: the execute step merges them with the built-in skills and
   * lists each skill's name + description, loading a body on demand.
   */
  skills: z.array(WorkspaceSkillSchema).optional(),
  command: z.string().optional(),
  /**
   * Run triage even when a command pins the route, keeping the pin but
   * reporting triage's prediction (see RunRequest.shadowTriage). Off unless the
   * client asked for the triage-accuracy signal.
   */
  shadowTriage: z.boolean().optional(),
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
 * Prepend the project-instructions section (the workspace's AGENTS.md or
 * CLAUDE.md, read by the client) ahead of everything else, then the
 * conversation. First place is deliberate: the instructions are the most
 * stable content across turns, so leading with them keeps the longest prompt
 * prefix unchanged turn over turn - exactly what prefix caches reuse -
 * while the growing history and the per-turn prompt follow.
 */
function withStandingContext(input: RequestInput, body: string): string {
  const rest = withHistory(input, body);
  if (!input.instructions) {
    return rest;
  }
  const { source, text } = input.instructions;
  return `--- Project instructions (${source}) ---\n${text}\n--- End of project instructions ---\n\n${rest}`;
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
 * The prompt the planner and answerer see: the project instructions (when the
 * workspace has an AGENTS.md/CLAUDE.md), the conversation so far, the slash
 * command's preamble (when one was invoked - the preamble frames the request,
 * e.g. /fix's diagnose-first briefing), the question, and the full attachment
 * text, one fenced block per attachment. Triage sees neither the preamble nor
 * the instructions: a known command pins the route and skips triage, and
 * routing oneshot-vs-planning needs no standing conventions - on a small
 * local model they would only crowd out the question.
 */
export function fullPrompt(input: RequestInput): string {
  const preamble = commandFor(input)?.preamble;
  const prompt = preamble ? `${preamble}\n\n${input.prompt}` : input.prompt;
  const attachments = input.attachments ?? [];
  if (attachments.length === 0) {
    return withStandingContext(input, prompt);
  }
  const blocks = attachments.map((a) => `${a.label}\n\`\`\`\n${a.text}\n\`\`\``);
  return withStandingContext(
    input,
    `${prompt}\n\n--- Attached context ---\n${blocks.join('\n\n')}`
  );
}

/**
 * The prompt the executor sees: the full request (prompt + attachment text,
 * same as the planner saw), the catalogue of available skills (name +
 * description only - the executor loads a body on demand via its `skill` tool),
 * and the plan it is asked to carry out, rendered as a numbered list of titles
 * and details. Steps name no tool - the executor chooses how to carry each one
 * out. The skills section is omitted when no skill is available.
 */
export function executionPrompt(
  input: RequestInput,
  plan: Plan,
  skills: readonly SkillSummary[] = []
): string {
  const skillsSection = renderSkillsSection(skills);
  return [
    fullPrompt(input),
    skillsSection,
    `--- Drafted plan ---\n${planText(plan)}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * The planner prompt for a revision: the same full prompt it first saw, plus a
 * delimited section carrying the user's review comment from the approval gate.
 * The planner re-drafts a fresh plan (the comment is untrusted task input, like
 * an attachment), which re-streams over the snapshots already shown.
 */
export function revisionPrompt(input: RequestInput, comment: string): string {
  return (
    `${fullPrompt(input)}\n\n` +
    `--- Plan review ---\n` +
    `The user reviewed your drafted plan and did not approve it. They asked for ` +
    `this change:\n${comment}\n` +
    `Draft a fresh plan that addresses it (summary, steps, and complexity).`
  );
}

/** The drafted plan rendered for a prompt: the summary then the numbered steps. */
function planText(plan: Plan): string {
  const steps = plan.steps
    .map((step, i) => `${i + 1}. ${step.title} - ${step.detail}`)
    .join('\n');
  return `${plan.summary}\n${steps}`;
}

/**
 * The execution transcript rendered for the summarizer's prompt: one line per
 * tool call (name, input preview, and result or a `[failed]` marker) and the
 * model's interleaved commentary, in order. Progress checklists are dropped -
 * they are a live UI affordance, not part of what changed.
 */
function transcriptText(execution: Execution): string {
  return execution.events
    .map((event) => {
      if (event.kind === 'text') {
        return event.text;
      }
      if (event.kind === 'tool') {
        const result = event.failed ? '[failed]' : event.result ?? '';
        return `- ${event.tool} ${event.input}${result ? ` => ${result}` : ''}`;
      }
      return undefined;
    })
    .filter((line): line is string => line !== undefined)
    .join('\n');
}

/**
 * The prompt the summarizer sees: the user's request and standing context (the
 * same prefix the other agents got), the drafted plan, and the execution
 * transcript it should recap. The transcript is the source of truth for what
 * actually happened, so it comes last and clearly delimited.
 */
export function summaryPrompt(input: RequestInput, plan: Plan, execution: Execution): string {
  return (
    `${fullPrompt(input)}\n\n` +
    `--- Drafted plan ---\n${planText(plan)}\n\n` +
    `--- Execution transcript ---\n${transcriptText(execution)}`
  );
}

/**
 * Whether the execution actually changed files: any successful `write` or
 * `edit` tool call in the transcript. The summary recaps a change, so a run
 * that only read/searched/ran commands (or whose every write failed or was
 * declined) has nothing to summarize and the step is skipped.
 */
function executionChangedFiles(execution: Execution): boolean {
  return execution.events.some(
    (event) =>
      event.kind === 'tool' &&
      (event.tool === 'write' || event.tool === 'edit') &&
      !event.failed &&
      event.result !== undefined
  );
}

/** The attachments inlined as the prompt sees them: each label above its text. */
function attachmentsText(input: RequestInput): string {
  return (input.attachments ?? []).map((a) => `${a.label}\n${a.text}`).join('\n\n');
}

/**
 * Estimated input-token attribution for a full-prompt step (plan/answer/
 * execute), section by section - the data that tells a user what to trim. Each
 * field is a length-based estimate of that section's content text (delimiters
 * and the agent's system prompt are excluded: they are fixed overhead the user
 * cannot change). A section that is empty or absent is omitted. The sources
 * mirror the assembly in `fullPrompt`/`executionPrompt`, so the split tracks
 * what is actually sent. `plan` and `skills` are supplied only for the executor
 * step (`skills` is the available-skills catalogue rendered into its prompt).
 */
export function inputBreakdown(
  input: RequestInput,
  plan?: Plan,
  skills: readonly SkillSummary[] = []
): InputBreakdown {
  const breakdown: InputBreakdown = {};
  const add = (key: keyof InputBreakdown, text: string | undefined) => {
    if (!text) {
      return;
    }
    const tokens = estimateTokens(text);
    if (tokens > 0) {
      breakdown[key] = tokens;
    }
  };
  const history = input.history ?? [];
  add('instructions', input.instructions?.text);
  add('history', history.length > 0 ? historySection(history) : undefined);
  add('preamble', commandFor(input)?.preamble);
  add('prompt', input.prompt);
  add('attachments', (input.attachments ?? []).length > 0 ? attachmentsText(input) : undefined);
  add('skills', skills.length > 0 ? renderSkillsSection(skills) : undefined);
  if (plan) {
    add('plan', planText(plan));
  }
  return breakdown;
}

/**
 * Triage decision carried forward to the branch steps. Complexity is relaxed to
 * optional here: triage's generation schema requires it (the model is asked for
 * it), but the carried plumbing tolerates its absence so a model that omits it
 * degrades to capability-only executor routing rather than failing the run.
 */
const TriagedSchema = RequestSchema.extend(TriageSchema.shape).extend({
  complexity: ComplexitySchema.optional(),
});

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
const StagedReplySchema = RequestSchema.extend(ReplySchema.shape).extend({
  /**
   * Engine-internal flag carried from draft-plan to the execute branch: false
   * when the user cancelled at the approval gate, so `shouldExecute` routes to
   * deliver-answer (plan-only) instead of executing. Not part of the protocol
   * reply - the final steps strip it off.
   */
  proceed: z.boolean().optional(),
});
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
export type StepUsage = { step: RunStep; inputBreakdown?: InputBreakdown } & AgentUsage;

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

/**
 * Adapt the run's UsageSink into one agent's reporter, tagging the step and -
 * for the full-prompt steps - the estimated input-token split by section, so
 * the metering record can attribute input tokens to their source.
 */
function usageReporter(
  requestContext: RequestContext,
  step: RunStep,
  breakdown?: InputBreakdown
): ((usage: AgentUsage) => void) | undefined {
  const sink = usageSink(requestContext);
  return (
    sink &&
    ((usage) => sink({ step, ...(breakdown ? { inputBreakdown: breakdown } : {}), ...usage }))
  );
}

/**
 * Receives a condensed line of the model's current reasoning as it works. A
 * side-channel like the usage sink, not part of the reply snapshot: thinking is
 * ephemeral (the LocalEngine forwards each line as a `thinking` event the UI
 * shows as transient progress) and never lands in the durable reply. Must not
 * throw.
 */
export type ThinkingSink = (line: string) => void;

/**
 * RequestContext key under which a caller may pass a `ThinkingSink`. The
 * execute and answer steps hand it to their agent so a reasoning model's
 * thinking surfaces live; absent (or with the setting off) the steps simply do
 * not capture reasoning.
 */
export const thinkingSinkKey = 'onThinking';

function thinkingSink(requestContext: RequestContext): ThinkingSink | undefined {
  return requestContext.get(thinkingSinkKey) as ThinkingSink | undefined;
}

/** Receives triage's prediction on a pinned run when shadow triage is on. */
export type TriageShadowSink = (predicted: Intent) => void;

/**
 * RequestContext key under which a caller may pass a `TriageShadowSink`. Only
 * used on a pinned run with `shadowTriage` set: triage is run anyway, the pin
 * still wins, and its prediction goes here for the metering record.
 */
export const triageShadowKey = 'onTriageShadow';

function triageShadowSink(requestContext: RequestContext): TriageShadowSink | undefined {
  return requestContext.get(triageShadowKey) as TriageShadowSink | undefined;
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
 * Asks the user to approve a drafted plan before it executes, returning their
 * verdict (approve / cancel / revise-with-comment). The engine-side handle on
 * the client's `RunClient.reviewPlan`. Absent (no client seam) means the run
 * never gates: the draft-plan step then proceeds straight to execution.
 */
export type PlanReview = (plan: Plan, complexity: Complexity) => Promise<PlanDecision>;

/**
 * RequestContext key under which the LocalEngine passes a `PlanReview` bound to
 * the run's client. The draft-plan step reads it (and the `myDevTeam.planApproval`
 * setting) to decide whether to pause for approval.
 */
export const planReviewKey = 'onPlanReview';

function planReview(requestContext: RequestContext): PlanReview | undefined {
  return requestContext.get(planReviewKey) as PlanReview | undefined;
}

/**
 * The agent's orchestration as a Mastra workflow:
 *
 *   triage ──▶ branch ──▶ draft-plan       (intent === "planning")
 *          │          └─▶ answer-directly  (intent === "oneshot")
 *          ▼
 *             branch ──▶ execute-plan      (a plan was drafted, the command did
 *                    │                      not opt out, and the user did not
 *                    │                      cancel it at the approval gate)
 *                    └─▶ deliver-answer    (oneshot and plan-only paths;
 *                                           pass-through)
 *
 * "answer-directly" streams a real answer from the Answerer agent;
 * "execute-plan" walks the drafted plan with the Executor's tool-calling
 * loop. The second branch is a branch rather than a plain step so a oneshot
 * (or plan-only) run never starts an executor step. A known slash command on
 * the request pins the triage decision without a model call, and a command
 * with `execute: false` (/plan) stops the run after the plan is drafted.
 * "draft-plan" may also pause for plan approval (see the gate inside it):
 * cancelling there carries `proceed: false` to deliver-answer.
 */
export function createDevTeamWorkflow(
  triage: Triage,
  // A factory, not an instance: the planner's model is sized by triage's
  // complexity, decided once the run is under way, so it is built in the
  // draft-plan step rather than up front (mirroring the executor factory).
  makePlanner: (complexity?: Complexity) => Planner,
  answerer: Answerer,
  // A factory, not an instance: the executor's model is sized by the request's
  // complexity, which triage only decides once the run is under way, so it is
  // built in the execute step rather than up front. The execute step also hands
  // it the run's resolved skill bodies, so its `skill` tool can load them.
  makeExecutor: (
    complexity?: Complexity,
    skillBodies?: ReadonlyMap<string, string>
  ) => Executor,
  // Optional: when supplied (and the setting is on), the execute step ends by
  // summarizing the change. Left out by tests that do not exercise the summary,
  // so the execute step then simply produces no summary.
  makeSummarizer?: () => Summarizer
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
      let decision;
      if (command) {
        decision = {
          intent: command.intent,
          complexity: command.complexity,
          reason: pinnedReason(command.name),
        };
        // Shadow triage: score the pin without changing the route. Triage runs
        // anyway (its tokens are real spend, reported like any triage call),
        // the pinned route still wins, and the prediction is reported for the
        // metering record so the report can measure triage against the command.
        if (inputData.shadowTriage) {
          const predicted = await triage.classify(
            triagePrompt(inputData),
            usageReporter(requestContext, 'triage')
          );
          triageShadowSink(requestContext)?.(predicted.intent);
        }
      } else {
        decision = await triage.classify(
          triagePrompt(inputData),
          usageReporter(requestContext, 'triage')
        );
      }
      return {
        prompt: inputData.prompt,
        instructions: inputData.instructions,
        attachments: inputData.attachments,
        history: inputData.history,
        skills: inputData.skills,
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
      const { prompt, instructions, attachments, history, skills, command, intent, complexity, reason } =
        inputData;
      const sink = progressSink(requestContext);
      // Surface the triage decision right away, then forward every plan
      // snapshot the planner streams, so the UI can render tokens as they
      // arrive instead of waiting for the whole plan.
      sink?.({ intent, complexity, reason });
      const onPartial: PlanProgress | undefined =
        sink && ((partial) => sink({ intent, complexity, reason, plan: partial }));
      // The planner's model is sized by triage's (pre-exploration) complexity;
      // the executor's, later, by the planner's own (post-exploration) one.
      const planner = makePlanner(complexity);
      const draft = (revision?: string) =>
        planner.plan(
          revision ?? fullPrompt(inputData),
          onPartial,
          usageReporter(requestContext, 'plan', inputBreakdown(inputData))
        );

      let plan = await draft();

      // The plan-approval gate. It only engages when the client offered the
      // review seam and the run would actually execute (not a /plan run); the
      // `myDevTeam.planApproval` setting then decides whether to pause: `always`
      // on every plan, `auto` only when the planner judged the work `complex`.
      // The user can approve (proceed), cancel (deliver the plan only), or
      // revise - re-planning with their comment appended and asking again.
      const review = planReview(requestContext);
      const canGate = review !== undefined && commandFor(inputData)?.execute !== false;
      const gates = (p: Plan): boolean => {
        if (!canGate) {
          return false;
        }
        const mode = settings.planApproval;
        return mode === 'always' || (mode === 'auto' && p.complexity === 'complex');
      };
      let proceed = true;
      while (gates(plan)) {
        // Make sure the complete plan is rendered before the approval prompt:
        // the streamed partials may trail the final object.
        sink?.({ intent, complexity, reason, plan });
        const decision = await review!(plan, plan.complexity ?? complexity ?? 'moderate');
        if (decision.kind === 'approve') {
          break;
        }
        if (decision.kind === 'cancel') {
          proceed = false;
          break;
        }
        plan = await draft(revisionPrompt(inputData, decision.comment));
      }

      return {
        prompt, instructions, attachments, history, skills, command, intent, complexity, reason, plan,
        proceed,
      };
    },
  });

  const answerDirectly = createStep({
    id: stepIds.answer,
    inputSchema: TriagedSchema,
    outputSchema: StagedReplySchema,
    execute: async ({ inputData, requestContext }) => {
      const { prompt, instructions, attachments, history, command, intent, complexity, reason } =
        inputData;
      const sink = progressSink(requestContext);
      // Surface the triage decision right away, then forward every answer
      // snapshot the answerer streams, mirroring the draft-plan step.
      sink?.({ intent, complexity, reason });
      const answer = await answerer.answer(
        fullPrompt(inputData),
        sink && ((text) => sink({ intent, complexity, reason, answer: text })),
        usageReporter(requestContext, 'answer', inputBreakdown(inputData)),
        // Surface a reasoning model's thinking live, gated by the setting so
        // turning it off does no extra work (a side-channel, not the reply).
        settings.thinking.showInChatEnabled ? thinkingSink(requestContext) : undefined
      );
      return { prompt, instructions, attachments, history, command, intent, complexity, reason, answer };
    },
  });

  const executePlan = createStep({
    id: stepIds.execute,
    inputSchema: StagedReplySchema,
    outputSchema: ReplySchema,
    execute: async ({ inputData, requestContext }) => {
      const { prompt, instructions, attachments, history, command, intent, complexity, reason, plan } =
        inputData;
      if (!plan) {
        throw new Error('execute-plan reached without a drafted plan.');
      }
      const sink = progressSink(requestContext);
      // Complete the plan render before execution output starts, then
      // forward every transcript snapshot the executor produces.
      sink?.({ intent, complexity, reason, plan });
      const onPartial: ExecutionProgress | undefined =
        sink && ((partial) => sink({ intent, complexity, reason, plan, execution: partial }));
      const executorInput = { prompt, instructions, attachments, history, command };
      // Merge the built-in skills with the run's workspace skills: the catalogue
      // (name + description) goes into the executor's prompt; the bodies back its
      // `skill` tool, loaded on demand.
      const { catalogue, bodies } = resolveSkills(inputData.skills);
      // Size the executor by the planner's post-exploration complexity when it
      // judged one, falling back to triage's pre-exploration value otherwise.
      // The planner has seen the workspace, so its read is the better one to
      // route the heavy step on; and with the run's skill bodies so its `skill`
      // tool can serve them.
      const executor = makeExecutor(plan.complexity ?? complexity, bodies);
      const execution = await executor.execute(
        executionPrompt(executorInput, plan, catalogue),
        onPartial,
        abortSignal(requestContext),
        usageReporter(requestContext, 'execute', inputBreakdown(executorInput, plan, catalogue)),
        // Surface the executor's thinking live, gated by the setting so turning
        // it off does no extra work (a side-channel, not the transcript).
        settings.thinking.showInChatEnabled ? thinkingSink(requestContext) : undefined
      );
      const base = { intent, complexity, reason, plan, execution };

      // Recap the change: only when a summarizer is wired, the setting is on,
      // and the run actually changed files (a read/analyse-only run has nothing
      // to summarize). Best-effort - the work is already done and on disk, so a
      // summarizer failure must degrade to "no summary", never fail the run or
      // discard the execution.
      if (
        !makeSummarizer ||
        !settings.summary.showInChatEnabled ||
        !executionChangedFiles(execution)
      ) {
        return base;
      }
      try {
        const onSummary: SummaryProgress | undefined =
          sink && ((partial) => sink({ ...base, summary: partial }));
        const summary = await makeSummarizer().summarize(
          summaryPrompt(executorInput, plan, execution),
          onSummary,
          usageReporter(requestContext, 'summarize')
        );
        return { ...base, summary };
      } catch {
        // Summary is a nicety on top of completed work; drop it on any failure.
        return base;
      }
    },
  });

  // The oneshot path is already complete after answer-directly, and a
  // plan-only run after draft-plan (a /plan command, or a plan the user
  // cancelled at the approval gate); this pass-through only strips the carried
  // request fields back off.
  const deliverAnswer = createStep({
    id: stepIds.deliver,
    inputSchema: StagedReplySchema,
    outputSchema: ReplySchema,
    execute: async ({ inputData }) => ({
      intent: inputData.intent,
      complexity: inputData.complexity,
      reason: inputData.reason,
      plan: inputData.plan,
      answer: inputData.answer,
    }),
  });

  // A drafted plan is executed unless the run's slash command opted out
  // (/plan stops after drafting, so the user can inspect the steps first) or
  // the user cancelled at the approval gate (`proceed === false`).
  const shouldExecute = async ({ inputData }: { inputData: StagedReply }) =>
    inputData.plan !== undefined &&
    inputData.proceed !== false &&
    commandFor(inputData)?.execute !== false;

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
