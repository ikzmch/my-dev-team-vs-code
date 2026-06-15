import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { Approver, McpInvoker } from '../tools/types';
import {
  Complexity,
  HistoryTurn,
  Intent,
  PartialExecution,
  PartialPlan,
  PartialSummary,
  Plan,
  PlanDecision,
  PROTOCOL_VERSION,
  Reply,
  ReplyProgress,
} from '../protocol/types';
import { ReplyFolder, RunEvent } from '../protocol/events';
import { clientTools, ToolHost } from '../protocol/toolContract';
import { Engine, RunCancelledError, RunFailedError } from '../protocol/engine';
import { EvalLog, UsageEntry } from '../client/evalLog';
import { ChangeSession, ChangeTracker } from '../client/changeTracker';
import { formatTokenCount, sumUsage } from '../client/usageStats';
import { collectInstructions } from '../client/instructions';
import { collectSkills } from '../client/skills';
import { collectReferences } from '../client/references';
import { CLEAR_COMMAND, COMPACT_COMMAND, MODEL_COMMAND } from '../config/clientCommands';
import { handleModelChatCommand } from './modelCommands';
import { PlanPreview, formatPlanDocument, isBigPlan } from './planPreview';
import { environment } from '../config/environment';
import { settings } from '../config/settings';
import { messages, truncateForDisplay } from '../config/messages';

export const PARTICIPANT_ID = 'myDevTeam.agent';

/** Command id the in-chat approval links invoke; registered in `register`. */
export const APPROVAL_COMMAND_ID = 'myDevTeam.approval';

/** Command id the in-chat plan-review links invoke; registered in `register`. */
export const PLAN_REVIEW_COMMAND_ID = 'myDevTeam.planReview';

/**
 * Phase 1 approval: ask in the chat stream itself. `confirm` renders the
 * proposed action (title + preview) followed by inline Approve/Decline command
 * links and blocks until one is clicked; the links invoke the registered
 * approval command carrying an approval id, which settles the matching confirm.
 * Links are used over `stream.button` so the two choices sit on one line
 * instead of stacking vertically. When
 * the tools are invoked outside a @devteam turn (they are registered
 * editor-wide) there is no stream to ask in, so the approver falls back to a
 * modal dialog. When you add a Webview later, write a WebviewApprover that
 * implements the same `Approver` interface with a rich diff dialog - the
 * tools won't change.
 *
 * The chat stream is per-request, so each request opens its own session
 * (`openSession`) for its duration. Sessions keep concurrent requests apart:
 * an approval is owned by the session whose stream rendered it, so a request
 * ending (or being cancelled) declines only its own pending approvals and
 * cannot touch another request's stream or block its tool calls. A confirm
 * carrying a run's `correlationId` (the handler binds it per run through the
 * ToolHost) renders into the session opened for that run, so under concurrent
 * `@devteam` turns a run's approval can no longer surface in the wrong turn's
 * stream. A confirm with no id - the editor-wide tool path, which has no owning
 * run - or one whose session has already closed falls back to the most recent
 * session, then to a modal; the gate itself works regardless.
 */
export class ChatApprover implements Approver {
  /** Active request sessions, in open order; keyed for correlation lookup. */
  private readonly sessions: Array<{
    id: number;
    stream: vscode.ChatResponseStream;
    /** The run this session was opened for, matched against confirm's id. */
    correlationId?: string;
  }> = [];
  private readonly pending = new Map<
    string,
    { sessionId: number; resolve: (approved: boolean) => void }
  >();
  private nextApprovalId = 0;
  private nextSessionId = 0;

  /** Register the command the approval links invoke. Call once on activation. */
  register(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      vscode.commands.registerCommand(
        APPROVAL_COMMAND_ID,
        (id: string, approved: boolean) => this.settle(id, approved === true)
      )
    );
  }

  /**
   * Attach a request's stream for the request's duration. Disposing (do it
   * when the request ends or is cancelled; it is idempotent) detaches the
   * stream and declines the approvals rendered into it - once the request is
   * over nobody can answer them anymore, and a hanging confirm would block
   * its tool call (and with it a cancelled run) forever.
   */
  openSession(
    stream: vscode.ChatResponseStream,
    correlationId?: string
  ): vscode.Disposable {
    const id = this.nextSessionId++;
    this.sessions.push({ id, stream, correlationId });
    return { dispose: () => this.closeSession(id) };
  }

  private closeSession(id: number): void {
    const index = this.sessions.findIndex((session) => session.id === id);
    if (index !== -1) {
      this.sessions.splice(index, 1);
    }
    // Decline only this session's approvals: a concurrent request's pending
    // approval stays live and answerable.
    for (const [approvalId, entry] of [...this.pending]) {
      if (entry.sessionId === id) {
        this.settle(approvalId, false);
      }
    }
  }

  async confirm(title: string, detail: string, correlationId?: string): Promise<boolean> {
    // With a run's id, render only in the session that owns it: falling back to
    // the most recent session here would re-introduce the cross-turn
    // misattribution this id exists to prevent, so a missing owner drops to the
    // modal below instead. Without an id (the editor-wide tool path has no
    // owning run) the most recent session is the right target, as before.
    const session =
      correlationId !== undefined
        ? this.sessions.find((s) => s.correlationId === correlationId)
        : this.sessions[this.sessions.length - 1];
    if (session) {
      try {
        const id = String(this.nextApprovalId++);
        // Render the question and the Approve/Decline choices as one trusted
        // markdown block: command links flow inline on a single line, unlike
        // stream.button which stacks each button vertically. isTrusted is
        // scoped to just the approval command so no other command: link in this
        // block could fire, and the copy is built here from fixed strings (the
        // untrusted detail is fenced by messages.approval.block).
        const md = new vscode.MarkdownString(
          messages.approval.block(title, detail) +
            '\n' +
            messages.approval.links(APPROVAL_COMMAND_ID, id)
        );
        md.isTrusted = { enabledCommands: [APPROVAL_COMMAND_ID] };
        session.stream.markdown(md);
        return await new Promise<boolean>((resolve) =>
          this.pending.set(id, { sessionId: session.id, resolve })
        );
      } catch {
        // The stream's request has ended mid-render; the modal below keeps
        // the approval gate working.
      }
    }
    const pick = await vscode.window.showWarningMessage(
      `${title}?`,
      { modal: true, detail },
      'Approve'
    );
    return pick === 'Approve';
  }

  /** Resolve one pending approval; a stale button click is a no-op. */
  private settle(id: string, approved: boolean): void {
    const entry = this.pending.get(id);
    if (entry) {
      this.pending.delete(id);
      entry.resolve(approved);
    }
  }
}

/**
 * The plan-approval gate's client side (the engine's `RunClient.reviewPlan`).
 * Mirrors `ChatApprover`: per-request sessions keep concurrent runs apart, and
 * the in-chat choices are trusted-markdown command links so Approve/Cancel/
 * Revise sit on one line. Revise opens an input box for the comment, which the
 * engine sends back to the planner to re-draft. When there is no stream (e.g. a
 * future non-chat front-end) it falls back to a modal. A WebviewReviewer would
 * implement the same `review` shape with a richer dialog.
 *
 * When a `PlanPreview` is supplied, a big plan (or every paused plan, per the
 * `myDevTeam.planApproval.preview` setting) also opens as a read-only markdown
 * preview beside the chat for the duration of the review - the richer reading
 * surface for the full plan and its design decisions, while the choices stay in
 * the chat. The preview is closed when the review settles (a click, a cancel, or
 * the request ending), so each verdict cleans up its own tab.
 */
export class ChatPlanReviewer {
  /** Active request sessions, in open order; review uses the most recent. */
  private readonly sessions: Array<{
    id: number;
    stream: vscode.ChatResponseStream;
  }> = [];
  private readonly pending = new Map<
    string,
    { sessionId: number; resolve: (decision: PlanDecision) => void }
  >();
  private nextReviewId = 0;
  private nextSessionId = 0;

  /**
   * The read-only editor preview seam. When supplied, a paused plan may also
   * open beside the chat per the `myDevTeam.planApproval.preview` setting; absent
   * (e.g. in a test), the review is chat-only as before.
   */
  constructor(private readonly preview?: PlanPreview) {}

  /** Register the command the review links invoke. Call once on activation. */
  register(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      vscode.commands.registerCommand(
        PLAN_REVIEW_COMMAND_ID,
        (id: string, choice: 'approve' | 'cancel' | 'revise') => void this.choose(id, choice)
      )
    );
  }

  /**
   * Attach a request's stream for its duration. Disposing (when the request
   * ends or is cancelled; idempotent) detaches it and cancels a review still
   * rendered into it - once the request is over nobody can answer it, and a
   * hanging review would block its run (and the run's cancellation) forever.
   */
  openSession(stream: vscode.ChatResponseStream): vscode.Disposable {
    const id = this.nextSessionId++;
    this.sessions.push({ id, stream });
    return { dispose: () => this.closeSession(id) };
  }

  private closeSession(id: number): void {
    const index = this.sessions.findIndex((session) => session.id === id);
    if (index !== -1) {
      this.sessions.splice(index, 1);
    }
    for (const [reviewId, entry] of [...this.pending]) {
      if (entry.sessionId === id) {
        this.settle(reviewId, { kind: 'cancel' });
      }
    }
  }

  /** Ask the user to approve the drafted plan; resolves with their verdict. */
  async review(plan: Plan, complexity: Complexity): Promise<PlanDecision> {
    const id = String(this.nextReviewId++);
    // A big (or, per the setting, every) plan also opens as a read-only preview
    // beside the chat. Tied to this review by id, it is disposed in the finally
    // below, so the tab closes whichever way the verdict lands - a click, the
    // modal, or the request ending.
    const preview = this.maybeOpenPreview(plan, complexity, id);
    try {
      const session = this.sessions[this.sessions.length - 1];
      if (session) {
        try {
          // The question plus Approve/Cancel/Revise as inline command links, one
          // trusted-markdown block (isTrusted scoped to just the review command).
          // A note points at the preview when one was opened.
          const md = new vscode.MarkdownString(
            messages.planApproval.block(complexity) +
              (preview ? messages.planApproval.previewNote : '') +
              '\n' +
              messages.planApproval.links(PLAN_REVIEW_COMMAND_ID, id)
          );
          md.isTrusted = { enabledCommands: [PLAN_REVIEW_COMMAND_ID] };
          session.stream.markdown(md);
          return await new Promise<PlanDecision>((resolve) =>
            this.pending.set(id, { sessionId: session.id, resolve })
          );
        } catch {
          // The stream's request has ended mid-render; the modal keeps the gate
          // working.
        }
      }
      return await this.modalReview(complexity);
    } finally {
      preview?.dispose();
    }
  }

  /**
   * Open the editor preview for a plan when the seam is wired and the
   * `myDevTeam.planApproval.preview` setting calls for it: `always` on every
   * paused plan, `auto` only for a big one, `never` not at all. Returns the
   * disposable that closes it, or undefined when no preview was opened.
   */
  private maybeOpenPreview(
    plan: Plan,
    complexity: Complexity,
    id: string
  ): vscode.Disposable | undefined {
    if (!this.preview || settings.planApprovalPreview === 'never') {
      return undefined;
    }
    const document = formatPlanDocument(plan, complexity);
    if (settings.planApprovalPreview === 'auto' && !isBigPlan(plan, complexity, document)) {
      return undefined;
    }
    return this.preview.open(document, id);
  }

  /** Fallback gate when there is no chat stream to render links into. */
  private async modalReview(complexity: Complexity): Promise<PlanDecision> {
    const pick = await vscode.window.showWarningMessage(
      `Approve this plan before it runs? (complexity: ${complexity})`,
      { modal: true },
      messages.planApproval.approve,
      messages.planApproval.revise
    );
    if (pick === messages.planApproval.approve) {
      return { kind: 'approve' };
    }
    if (pick === messages.planApproval.revise) {
      const comment = await this.askForComment();
      return comment ? { kind: 'revise', comment } : { kind: 'cancel' };
    }
    // Dismissing the modal (its built-in Cancel) cancels the plan.
    return { kind: 'cancel' };
  }

  /** Prompt for the revision comment; an empty or dismissed box means no comment. */
  private async askForComment(): Promise<string | undefined> {
    const comment = await vscode.window.showInputBox({
      prompt: messages.planApproval.revisePrompt,
      placeHolder: messages.planApproval.revisePlaceholder,
    });
    const trimmed = comment?.trim();
    return trimmed ? trimmed : undefined;
  }

  /**
   * Handle a clicked review link. Approve/Cancel settle immediately; Revise
   * first opens the comment input box (a dismissed or empty box falls back to
   * cancel, so the run never hangs waiting on an unanswered review).
   */
  private async choose(id: string, choice: 'approve' | 'cancel' | 'revise'): Promise<void> {
    if (choice === 'revise') {
      const comment = await this.askForComment();
      this.settle(id, comment ? { kind: 'revise', comment } : { kind: 'cancel' });
      return;
    }
    this.settle(id, choice === 'approve' ? { kind: 'approve' } : { kind: 'cancel' });
  }

  /** Resolve one pending review; a stale link click is a no-op. */
  private settle(id: string, decision: PlanDecision): void {
    const entry = this.pending.get(id);
    if (entry) {
      this.pending.delete(id);
      entry.resolve(decision);
    }
  }
}

/**
 * Convert the chat session's prior turns into run-request history turns, so a
 * follow-up ("now rename it too") reaches the agents with the conversation
 * that says what "it" is. Only this participant's exchanges count: a request
 * turn becomes a user turn (with its slash command restored, since VS Code
 * strips it from the prompt), a response turn becomes an assistant turn made
 * of its markdown parts (buttons and other parts carry no reusable text).
 * The settings.history caps bound what a long session can add to a prompt:
 * each turn's text is truncated and only the most recent turns are kept.
 *
 * Two commands manage this history (history is client state - the engine is
 * stateless - so the rules live here, not in the engine's command registry):
 *
 * - a /clear request turn resets the collection; neither the turns before
 *   it, the marker itself, nor its confirmation reply reach future prompts.
 * - a successful /compact response (its `TurnMetadata.outcome` is "ok") also
 *   resets the collection, but keeps itself: the summary becomes the sole
 *   opening assistant turn, standing in for everything it summarized. The
 *   /compact request turn is only the instruction and is skipped, and a
 *   failed or cancelled compact is skipped entirely so it never wipes the
 *   history it failed to summarize.
 */
function collectHistory(
  history: readonly (vscode.ChatRequestTurn | vscode.ChatResponseTurn)[]
): HistoryTurn[] {
  const turns: HistoryTurn[] = [];
  for (const turn of history) {
    if (turn.participant !== PARTICIPANT_ID) {
      continue;
    }
    if (turn instanceof vscode.ChatRequestTurn) {
      if (turn.command === CLEAR_COMMAND) {
        turns.length = 0;
        continue;
      }
      if (turn.command === COMPACT_COMMAND) {
        continue;
      }
      const prompt = turn.command ? `/${turn.command} ${turn.prompt}` : turn.prompt;
      turns.push({
        role: 'user',
        text: truncateForDisplay(prompt, settings.history.maxTurnChars),
      });
    } else if (turn instanceof vscode.ChatResponseTurn) {
      const metadata = turn.result?.metadata as Partial<TurnMetadata> | undefined;
      if (metadata?.command === CLEAR_COMMAND) {
        continue;
      }
      if (metadata?.command === COMPACT_COMMAND) {
        if (metadata.outcome !== 'ok') {
          continue;
        }
        turns.length = 0;
      }
      const text = turn.response
        .filter(
          (part): part is vscode.ChatResponseMarkdownPart =>
            part instanceof vscode.ChatResponseMarkdownPart
        )
        .map((part) => part.value.value)
        .join('');
      if (text.trim()) {
        turns.push({
          role: 'assistant',
          text: truncateForDisplay(text, settings.history.maxTurnChars),
        });
      }
    }
  }
  return turns.slice(-settings.history.maxTurns);
}

/**
 * Render a (possibly still streaming) plan as a markdown checklist.
 *
 * With `done` false this is a conservative render of a partial snapshot: it
 * stops at the first field the model is still writing, and it withholds any
 * punctuation that follows a field until that field is provably complete (the
 * model has moved on to the next one). That makes successive renders of
 * growing snapshots prefix-extensions of each other - exactly what the
 * append-only chat stream needs. With `done` true it renders the full
 * checklist.
 */
function formatPlan(plan: PartialPlan, done: boolean): string {
  if (plan.summary === undefined) {
    return '';
  }
  let text = messages.plan.header + plan.summary;
  // The summary is complete once the model has started on the steps.
  if (plan.steps === undefined && !done) {
    return text;
  }
  text += '\n\n';
  const steps = plan.steps ?? [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (step?.title === undefined) {
      return text;
    }
    text += `${i + 1}. **${step.title}`;
    // The title is complete once the detail field has started; withhold the
    // closing bold marker until then so streamed renders stay prefix-extensions.
    if (step.detail === undefined && !done) {
      return text;
    }
    text += `** - ${step.detail ?? ''}`;
    // The detail keeps streaming until the next step begins.
    if (steps[i + 1] === undefined && !done) {
      return text;
    }
    if (i < steps.length - 1) {
      text += '\n';
    }
  }
  // The planner's complexity, appended after the steps: an append-only spot, so
  // a value that streams in after the steps (or only at finish) never breaks the
  // prefix-extension the chat stream relies on. Only reached once every step is
  // complete (the loop ran to the end), i.e. when `done` or execution started.
  if (plan.complexity !== undefined) {
    text += messages.plan.complexity(plan.complexity);
  }
  return text;
}

/** Flatten a tool input/result preview onto one backtick-safe line. */
function inlinePreview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').replace(/`/g, "'").trim();
  return flat || messages.execution.emptyResult;
}

/** The display name transcripts render for a tool, from the protocol contract. */
function toolDisplayName(tool: string): string {
  const known = clientTools as Record<string, { displayName: string } | undefined>;
  return known[tool]?.displayName ?? tool;
}

/**
 * Render a (possibly still streaming) execution transcript. Snapshots are
 * grow-only (events are appended; the trailing text event grows, the trailing
 * tool event gains its result), and each event's render is append-only too -
 * the call line is emitted when the call starts and the result suffix when it
 * lands - so successive renders stay prefix-extensions of each other. A tool
 * call still waiting for its result ends the render unless `done`; its
 * snippet (e.g. the first lines of a written file) is held back with the
 * result so it can render beneath the completed line.
 */
function formatExecution(
  execution: PartialExecution,
  plan: PartialPlan | undefined,
  done: boolean
): string {
  let text = messages.execution.header;
  for (const event of execution.events) {
    if (event.kind === 'text') {
      text += '\n\n' + event.text;
    } else if (event.kind === 'progress') {
      // Resolve each reported step number to its plan title (the event carries
      // only the number, so the checklist cannot drift from the plan); an
      // out-of-range number falls back to a bare "Step N" label.
      const items = event.items.map((item) => ({
        title: plan?.steps?.[item.step - 1]?.title ?? `Step ${item.step}`,
        status: item.status,
      }));
      text += messages.execution.progress(items);
    } else {
      text += messages.execution.call(toolDisplayName(event.tool), inlinePreview(event.input));
      if (event.result !== undefined) {
        text += messages.execution.result(inlinePreview(event.result), !!event.failed);
      } else if (!done) {
        return text;
      }
      if (event.snippet !== undefined) {
        text += messages.execution.snippet(event.snippet);
      }
    }
  }
  return text;
}

/**
 * Render a (possibly still streaming) end-of-run summary as its three sections.
 * Conservative while streaming, exactly like `formatPlan`: it stops at the
 * first section the model is still writing and only emits the next section's
 * header once that section has started, so successive renders of growing
 * snapshots are prefix-extensions of one another.
 */
function formatSummary(summary: PartialSummary, done: boolean): string {
  if (summary.whatShips === undefined) {
    return '';
  }
  let text = messages.summary.header + messages.summary.whatShips + summary.whatShips;
  // Each section is complete once the next one has started streaming.
  if (summary.howItsBuilt === undefined && !done) {
    return text;
  }
  text += messages.summary.howItsBuilt + (summary.howItsBuilt ?? '');
  if (summary.testsAndDocs === undefined && !done) {
    return text;
  }
  text += messages.summary.testsAndDocs + (summary.testsAndDocs ?? '');
  return text;
}

/**
 * Render the reply as chat markdown. Used both for in-flight snapshots
 * (`done` false) and for the final result (`done` true), so the streamed
 * prefix and the finished reply can never drift apart. Exported for tests.
 */
export function renderReply(reply: ReplyProgress | Reply, done: boolean): string {
  // The complexity shown is the planner's, rendered inside the plan block (see
  // formatPlan) rather than here - so the value never changes after it is first
  // emitted, keeping streamed renders prefix-extensions of one another.
  let text = messages.triage.block(reply.intent, reply.reason);
  // The model line arrives just after triage (the model-selected event), so it
  // is appended right behind the triage block - keeping streamed renders
  // prefix-extensions of one another - and ahead of the plan/answer.
  if (reply.selection) {
    text += messages.model.block(reply.selection);
  }
  if (reply.plan) {
    // Once execution output exists the plan is necessarily complete, so it
    // can be rendered unconservatively even while the run is still going.
    text += formatPlan(reply.plan, done || reply.execution !== undefined);
    if (reply.execution) {
      text += '\n\n' + formatExecution(reply.execution, reply.plan, done);
      // The summary (when present) streams in after the transcript; its header
      // carries its own leading blank line, so no separator is added here.
      if (reply.summary) {
        text += formatSummary(reply.summary, done);
      }
    } else if (done) {
      // A finished run whose reply holds a plan but no transcript is the
      // /plan command's plan-only path; in-flight snapshots (`done` false)
      // never carry the note, so streamed renders stay prefix-extensions.
      text += messages.plan.notExecuted;
    }
  } else if (reply.answer !== undefined) {
    // The answer snapshots are grow-only accumulated text, so appending them
    // behind the header keeps successive renders prefix-extensions.
    text += messages.answer.header + reply.answer;
  }
  return text;
}

/**
 * Bridges full-document renders onto the append-only chat stream by emitting
 * only the newly appended suffix of each successive render. If a snapshot
 * ever fails to extend what was already emitted (the event stream should be
 * monotonic, so this is a guard, not an expectation), it is skipped;
 * `finish` then falls back to appending the complete reply so the user never
 * ends up with a truncated answer.
 */
class ReplyStreamer {
  private emitted = '';

  constructor(private readonly stream: vscode.ChatResponseStream) {}

  get hasEmitted(): boolean {
    return this.emitted.length > 0;
  }

  update(full: string): void {
    if (full.length > this.emitted.length && full.startsWith(this.emitted)) {
      this.stream.markdown(full.slice(this.emitted.length));
      this.emitted = full;
    }
  }

  finish(full: string): void {
    if (full.startsWith(this.emitted)) {
      this.update(full);
    } else {
      this.stream.markdown('\n\n' + full);
    }
  }
}

/**
 * Render a failed run from the protocol's failure: the step's error template
 * plus the engine-supplied troubleshooting hint when there is one (the
 * LocalEngine points at Ollama and the routed model - knowledge the client
 * deliberately no longer has).
 */
function renderFailure(error: RunFailedError): string {
  const template =
    error.step === 'execute'
      ? messages.execution.error
      : error.step === 'plan'
      ? messages.plan.error
      : error.step === 'answer'
      ? messages.answer.error
      : error.step === 'triage'
      ? messages.triage.error
      : messages.run.error;
  return template(error.message) + (error.hint ?? '');
}

/**
 * What the handler stores in each turn's chat result metadata: the pairing
 * key the feedback listener needs to attribute a later 👍/👎 click to the run
 * (and route) it judges, plus how the turn ended. VS Code hands the metadata
 * back on `onDidReceiveFeedback` via `feedback.result`, and on each response
 * turn's `result` in the session history - which is how `collectHistory`
 * tells a successful /compact (its summary replaces the older turns) from a
 * failed one (which must not wipe the history it failed to summarize).
 */
export interface TurnMetadata {
  command: string;
  runId: string;
  /** The chat conversation this turn belongs to; reused by later turns. */
  conversationId?: string;
  intent?: Intent;
  outcome?: 'ok' | 'error' | 'cancelled';
}

/**
 * The conversation id for this turn: when there is collected history this is a
 * follow-up, so it reuses the most recent prior turn's id (scanning back for
 * the first response turn that carries one); otherwise - a new chat, or the
 * first turn after a /clear emptied the history - it mints a fresh id. A
 * /clear or /model turn carries no id, so the scan skips past it to the real
 * conversation it belongs to.
 */
function conversationIdFor(context: vscode.ChatContext, hasHistory: boolean): string {
  if (hasHistory) {
    for (let i = context.history.length - 1; i >= 0; i--) {
      const turn = context.history[i];
      if (turn instanceof vscode.ChatResponseTurn && turn.participant === PARTICIPANT_ID) {
        const id = (turn.result?.metadata as Partial<TurnMetadata> | undefined)?.conversationId;
        if (id) {
          return id;
        }
      }
    }
  }
  return randomUUID();
}

/**
 * Builds the chat handler. The handler is thin: it resolves attachments and
 * the conversation history into a protocol run request, starts a run on
 * whichever engine the provider currently selects, folds the run's events
 * back into reply snapshots, and streams each render's new suffix onto the
 * chat. It neither knows nor cares whether the engine is in-process or
 * remote - that is the point of the protocol. When an `EvalLog` is supplied,
 * each run's route, per-step usage, and outcome are recorded to it (the log
 * itself is opt-in and stores nothing unless its setting is on). `onRunUsage`,
 * when supplied, receives every finished run's per-step token usage (regardless
 * of the eval-log setting) - the session token counter subscribes to it. When a
 * `changeTracker` is supplied, each turn opens a session on it so the files the
 * run writes roll up into a `**Changes:**` summary line under the reply. When an
 * `approver` is supplied, each turn opens an approval session keyed by its run
 * id and binds the run's tool calls to it, so a `run` (or gated write/edit)
 * approval renders in the turn that owns it even when turns run concurrently.
 */
export function createHandler(
  getEngine: () => Engine,
  toolHost: ToolHost,
  evalLog?: EvalLog,
  onRunUsage?: (usage: readonly UsageEntry[]) => void,
  changeTracker?: ChangeTracker,
  // The plan-approval gate's client side. When supplied, the run client offers
  // `reviewPlan`, so the engine can pause for approval before executing; absent
  // (e.g. in a test), no gate is offered and runs proceed straight through.
  planReviewer?: ChatPlanReviewer,
  // The approval gate's client side. When supplied, the handler opens a
  // per-run approval session and tags this run's tool calls with its id, so the
  // gate's prompt is attributed to the owning turn; absent (e.g. in a test),
  // tool calls carry no id and the approver renders into the most recent
  // session as before.
  approver?: ChatApprover,
  // The MCP seam. When supplied, the handler discovers the configured servers'
  // tools and ships them on the run request (the same hub backs the ToolHost,
  // so the offered names and the shipped definitions stay one set). Absent
  // (e.g. in a test), no MCP tools are offered.
  mcp?: McpInvoker
): vscode.ChatRequestHandler {
  return async (request, context, stream, token) => {
    // /clear never starts a run: the conversation history is client state
    // (the engine is stateless and receives it per request), so clearing it
    // is purely a marker this handler plants - collectHistory drops every
    // turn before it on the following requests. The confirmation is the
    // whole reply; a message typed after the command is not processed.
    if (request.command === CLEAR_COMMAND) {
      stream.markdown(
        messages.clear.confirmation +
          (request.prompt.trim() ? messages.clear.ignoredPrompt : '')
      );
      const metadata: TurnMetadata = {
        command: CLEAR_COMMAND,
        runId: randomUUID(),
        outcome: 'ok',
      };
      return { metadata };
    }

    // /model is also client-side and starts no run: the model choice is a
    // client setting sent on every run request, so picking it is a setting
    // write plus a chat confirmation (the picker or the typed argument).
    if (request.command === MODEL_COMMAND) {
      await handleModelChatCommand(getEngine(), request.prompt, stream);
      const metadata: TurnMetadata = {
        command: MODEL_COMMAND,
        runId: randomUUID(),
        outcome: 'ok',
      };
      return { metadata };
    }

    // Resolve the workspace's standing instruction file (AGENTS.md/CLAUDE.md),
    // the request's references (attached files/selections/symbols plus inline
    // #codebase/#changes markers), and the prior turns; the engine folds them
    // into each step's prompt as that step's model needs them. Resolving the
    // references also strips any inline marker from the prompt, so the agents
    // see the request, not a stray "#codebase".
    const instructions = await collectInstructions();
    const skills = await collectSkills();
    // Discover the configured MCP servers' tools (connecting them on the first
    // turn; the hub memoises). This primes the same hub the ToolHost reads, so
    // `toolHost.tools` below already includes the MCP names and they match the
    // shipped `dynamicTools`. Never throws - a broken server is skipped.
    const dynamicTools = mcp ? await mcp.listToolDefs() : [];
    const { attachments, prompt } = await collectReferences(
      request.references,
      request.prompt
    );
    const history = collectHistory(context.history);

    // What this turn contributes to the eval log: a fresh run id (also the
    // feedback pairing key), the route once triage decides it, and the
    // usage events as they arrive. The outcome also lands in the turn's
    // metadata, where collectHistory reads it back to trust (or not) a
    // /compact summary.
    const runId = randomUUID();
    // The conversation this run belongs to: reused from the most recent prior
    // turn (a follow-up continues the thread), minted fresh when there is no
    // collected history (a new chat, or the first turn after /clear). It rides
    // in the turn metadata so the next turn can read it back, and into the run
    // record so a thread's runs can be grouped for context-growth analysis.
    const conversationId = conversationIdFor(context, history.length > 0);
    const startedAt = Date.now();
    let intent: Intent | undefined;
    let triagePredicted: Intent | undefined;
    let outcome: TurnMetadata['outcome'];
    const usage: UsageEntry[] = [];
    const chatResult = (): vscode.ChatResult => {
      const metadata: TurnMetadata = {
        command: request.command ?? '',
        runId,
        conversationId,
        intent,
        outcome,
      };
      return { metadata };
    };

    // Stream the reply as the engine produces it: events fold back into
    // grow-only snapshots, and the streamer appends each render's new suffix
    // to the chat. The event sink must never throw into the engine, so
    // stream errors (e.g. a closed stream) are swallowed here.
    const streamer = new ReplyStreamer(stream);
    const folder = new ReplyFolder();
    const onEvent = (event: RunEvent) => {
      if (event.type === 'usage') {
        // The billing seam. Collected before the cancellation check: tokens
        // already spent by a cancelled run still count.
        usage.push({
          step: event.step,
          model: event.model,
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          reasoningTokens: event.reasoningTokens,
          cachedInputTokens: event.cachedInputTokens,
          totalTokens: event.totalTokens,
          estimated: event.estimated,
          inputBreakdown: event.inputBreakdown,
          repaired: event.repaired,
        });
        console.log(
          `[My Dev Team] usage: ${event.step}` +
            (event.model ? ` (${event.model})` : '') +
            ` in=${event.inputTokens ?? '?'} out=${event.outputTokens ?? '?'}`
        );
        return;
      }
      if (event.type === 'triaged') {
        intent = event.intent;
      }
      if (event.type === 'triage-shadow') {
        // What triage would have decided on this pinned run; recorded only, it
        // never changes the route or the render.
        triagePredicted = event.predicted;
        return;
      }
      if (event.type === 'thinking') {
        // The model's condensed reasoning: shown as transient progress (a
        // spinner line VS Code drops once real output streams in), never
        // appended to the reply markdown, so the append-only render stays a
        // prefix-extension. Best-effort and skipped once cancelled.
        if (!token.isCancellationRequested) {
          try {
            stream.progress(messages.thinking.line(event.text));
          } catch {
            // The stream is closed; thinking is best-effort.
          }
        }
        return;
      }
      if (token.isCancellationRequested) {
        return;
      }
      const progress = folder.apply(event);
      // The final render comes from the validated result below.
      if (!progress || event.type === 'done') {
        return;
      }
      try {
        streamer.update(renderReply(progress, false));
      } catch {
        // The stream is closed; the result handling below still runs.
      }
    };

    // Collect the files this turn writes for the `**Changes:**` summary. The
    // tracker is shared (one per ToolHost), so the run's writes are attributed
    // to the newest open session; opening it here makes this turn that session
    // for the run's duration. Disposed in the finally below - reading the
    // summary afterwards still works, the session's collected files are
    // captured in the handle.
    const changeSession = changeTracker?.openSession();

    // Open this turn's approval session keyed by the run id, and bind the run's
    // tool calls to it: tagging each execute with the id lets the approver
    // render a `run` (or gated write/edit) prompt in the turn that owns it
    // rather than the most recent one. Disposed on cancellation (so a pending
    // approval cannot keep a cancelled run hanging) and in the finally below.
    const approvalSession = approver?.openSession(stream, runId);
    const runToolHost: ToolHost = approver
      ? {
          tools: toolHost.tools,
          execute: (tool, args, signal) => toolHost.execute(tool, args, signal, runId),
        }
      : toolHost;

    const handle = getEngine().startRun(
      {
        protocolVersion: PROTOCOL_VERSION,
        prompt,
        // The slash command travels by name only: what it does (route
        // pinning, prompt preamble) is the engine's command registry's
        // business, and an engine that does not know the name treats the
        // prompt as plain text.
        command: request.command,
        // The user's model choice (a registry id, or "auto"); the engine routes
        // by capability when it is "auto" or an id it does not know.
        model: settings.model,
        instructions,
        attachments,
        history,
        // Workspace skills (raw SKILL.md text); the engine merges them with its
        // built-in skills and the executor loads a body on demand.
        skills,
        // Tools discovered from the configured MCP servers; the executor calls
        // them through the ToolHost, gated by the Approver. Their names are also
        // in offeredTools (toolHost.tools includes them).
        dynamicTools,
        environment: { os: environment.os, shell: environment.shell },
        offeredTools: [...toolHost.tools],
        // Ask the engine to shadow-run triage on a pinned command only when the
        // user opted into it and the eval log is on to receive the signal -
        // otherwise the extra triage call would buy nothing.
        shadowTriage:
          settings.telemetry.shadowTriageEnabled && settings.telemetry.evalLogEnabled,
      },
      {
        onEvent,
        toolHost: runToolHost,
        // Offer the plan-approval seam only when a reviewer is wired; the engine
        // then gates per the myDevTeam.planApproval setting. Without it, runs
        // never pause for plan approval.
        ...(planReviewer
          ? { reviewPlan: (plan: Plan, complexity: Complexity) => planReviewer.review(plan, complexity) }
          : {}),
      }
    );
    // Cancelling the chat request cancels the run (and its model call)
    // instead of leaving it to finish in the background; the engine aborts
    // in-flight tool executions too, so a running command is killed and a
    // pending write is dropped rather than completing. Closing the approval
    // session alongside declines any prompt still awaiting a click, so a run
    // blocked on an unanswered approval cannot keep the cancelled turn hanging.
    const cancellation = token.onCancellationRequested(() => {
      handle.cancel();
      approvalSession?.dispose();
    });

    // Settle the turn's outcome (for the result metadata) and record it to
    // the eval log. The log write is fire-and-forget by design: it never
    // rejects, and a slow disk must not delay the turn's result.
    const recordRun = (ending: 'ok' | 'error' | 'cancelled', errorStep?: string) => {
      outcome = ending;
      // The session counter sees every run's tokens (including a cancelled
      // run's already-spent ones), independent of the opt-in eval log.
      onRunUsage?.(usage);
      void evalLog?.recordRun({
        runId,
        conversationId,
        command: request.command ?? '',
        intent,
        outcome: ending,
        errorStep,
        usage,
        durationMs: Date.now() - startedAt,
        triagePredicted,
      });
    };

    // Append the `**Tokens:**` line under a rendered reply when the setting is
    // on and the run spent any tokens. Skipped on a cancelled turn (nothing is
    // rendered) and guarded against a closed stream like the other renders.
    const emitTokenLine = () => {
      if (
        token.isCancellationRequested ||
        usage.length === 0 ||
        !settings.usage.showInChatEnabled
      ) {
        return;
      }
      const summary = sumUsage(usage);
      try {
        stream.markdown(
          messages.usage.chatLine(
            formatTokenCount(summary.inputTokens),
            formatTokenCount(summary.outputTokens),
            summary.hasEstimates
          )
        );
      } catch {
        // The stream is closed; the token line is best-effort.
      }
    };

    // Append the `**Changes:**` line under a rendered reply when the setting is
    // on and the run actually changed files. Skipped on a cancelled turn
    // (nothing is rendered) and guarded against a closed stream; placed above
    // the token line so the work product reads before its cost.
    const emitChangeLine = () => {
      if (token.isCancellationRequested || !settings.changes.showInChatEnabled) {
        return;
      }
      const summary = changeSession?.summary();
      if (!summary || summary.files === 0) {
        return;
      }
      try {
        stream.markdown(
          messages.changes.summary(summary.files, summary.added, summary.removed)
        );
      } catch {
        // The stream is closed; the change line is best-effort.
      }
    };

    let reply: Reply;
    try {
      reply = await handle.result;
    } catch (err) {
      // A cancelled request renders nothing: VS Code marks the turn
      // cancelled and the stream may already be closed.
      if (token.isCancellationRequested || err instanceof RunCancelledError) {
        recordRun('cancelled');
        return chatResult();
      }
      if (err instanceof RunFailedError) {
        recordRun('error', err.step);
        const separator = streamer.hasEmitted ? '\n\n' : '';
        stream.markdown(separator + renderFailure(err));
        // A run that failed mid-way may still have landed files; report them.
        emitChangeLine();
        emitTokenLine();
        return chatResult();
      }
      throw err;
    } finally {
      cancellation.dispose();
      changeSession?.dispose();
      // The run is over: no approval can still be pending, so closing the
      // session just detaches it (the final reply renders straight to the
      // stream below, not through the session).
      approvalSession?.dispose();
    }

    intent = reply.intent;
    recordRun('ok');
    if (!token.isCancellationRequested) {
      // Emits whatever the streaming path has not already rendered.
      streamer.finish(renderReply(reply, true));
      emitChangeLine();
      emitTokenLine();
    }
    return chatResult();
  };
}
