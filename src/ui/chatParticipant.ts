import * as vscode from 'vscode';
import { Approver } from '../tools/types';
import {
  Attachment,
  HistoryTurn,
  PartialExecution,
  PartialPlan,
  PROTOCOL_VERSION,
  Reply,
  ReplyProgress,
} from '../protocol/types';
import { ReplyFolder, RunEvent } from '../protocol/events';
import { clientTools, ToolHost } from '../protocol/toolContract';
import { Engine, RunCancelledError, RunFailedError } from '../protocol/engine';
import { environment } from '../config/environment';
import { settings } from '../config/settings';
import { messages } from '../config/messages';

export const PARTICIPANT_ID = 'myDevTeam.agent';

/** Command id the in-chat approval buttons invoke; registered in `register`. */
export const APPROVAL_COMMAND_ID = 'myDevTeam.approval';

/**
 * Phase 1 approval: ask in the chat stream itself. `confirm` renders the
 * proposed action (title + preview) followed by Approve/Decline buttons and
 * blocks until one is clicked; the buttons invoke the registered approval
 * command carrying an approval id, which settles the matching confirm. When
 * the tools are invoked outside a @devteam turn (they are registered
 * editor-wide) there is no stream to ask in, so the approver falls back to a
 * modal dialog. When you add a Webview later, write a WebviewApprover that
 * implements the same `Approver` interface with a rich diff dialog — the
 * tools won't change.
 *
 * The chat stream is per-request, so we set it on each turn.
 */
export class ChatApprover implements Approver {
  private stream: vscode.ChatResponseStream | undefined;
  private readonly pending = new Map<string, (approved: boolean) => void>();
  private nextApprovalId = 0;

  /** Register the command the approval buttons invoke. Call once on activation. */
  register(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      vscode.commands.registerCommand(
        APPROVAL_COMMAND_ID,
        (id: string, approved: boolean) => this.settle(id, approved === true)
      )
    );
  }

  setStream(stream: vscode.ChatResponseStream) {
    this.stream = stream;
  }

  /**
   * Detach the stream when its request ends (or is cancelled), declining
   * whatever is still waiting for a click: once the request is over nobody
   * can answer anymore, and a hanging confirm would block its tool call (and
   * with it a cancelled run) forever. The tools are registered editor-wide
   * and can be invoked outside a @devteam turn; without the detach, an
   * approval arriving later would write into a finished request's stream.
   */
  clearStream() {
    this.stream = undefined;
    for (const id of [...this.pending.keys()]) {
      this.settle(id, false);
    }
  }

  async confirm(title: string, detail: string): Promise<boolean> {
    const stream = this.stream;
    if (stream) {
      try {
        const id = String(this.nextApprovalId++);
        stream.markdown(messages.approval.block(title, detail));
        stream.button({
          command: APPROVAL_COMMAND_ID,
          title: messages.approval.approve,
          arguments: [id, true],
        });
        stream.button({
          command: APPROVAL_COMMAND_ID,
          title: messages.approval.decline,
          arguments: [id, false],
        });
        return await new Promise<boolean>((resolve) => this.pending.set(id, resolve));
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
    const resolve = this.pending.get(id);
    if (resolve) {
      this.pending.delete(id);
      resolve(approved);
    }
  }
}

function truncate(text: string, maxChars: number): string {
  // Cap on inlined text so a huge file or reply can't blow up the prompt.
  return text.length > maxChars ? text.slice(0, maxChars) + '\n…(truncated)' : text;
}

/**
 * Resolve files/selections the user attached to the chat request into
 * run-request attachments. VS Code delivers attachments on
 * `request.references`, not in the prompt: each `value` is a Uri (whole
 * file), a Location (file + range, e.g. a selection), or a plain string. The
 * engine decides per step how much of each attachment its model sees (triage
 * gets labels only, the planner/answerer get the full text).
 */
async function collectAttachments(
  refs: readonly vscode.ChatPromptReference[]
): Promise<Attachment[]> {
  const attachments: Attachment[] = [];
  for (const ref of refs) {
    const v = ref.value;
    try {
      if (v instanceof vscode.Uri) {
        const bytes = await vscode.workspace.fs.readFile(v);
        const rel = vscode.workspace.asRelativePath(v);
        attachments.push({
          label: `File: ${rel}`,
          text: truncate(Buffer.from(bytes).toString('utf8'), settings.maxAttachmentChars),
        });
      } else if (v instanceof vscode.Location) {
        const doc = await vscode.workspace.openTextDocument(v.uri);
        const rel = vscode.workspace.asRelativePath(v.uri);
        const startLine = v.range.start.line + 1;
        attachments.push({
          label: `Selection from ${rel} (line ${startLine})`,
          text: truncate(doc.getText(v.range), settings.maxAttachmentChars),
        });
      } else if (typeof v === 'string') {
        attachments.push({
          label: 'Attached text',
          text: truncate(v, settings.maxAttachmentChars),
        });
      }
    } catch (err) {
      attachments.push({
        label: 'Unreadable attachment',
        text: `(could not read attachment: ${String(err)})`,
      });
    }
  }
  return attachments;
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
      const prompt = turn.command ? `/${turn.command} ${turn.prompt}` : turn.prompt;
      turns.push({
        role: 'user',
        text: truncate(prompt, settings.history.maxTurnChars),
      });
    } else if (turn instanceof vscode.ChatResponseTurn) {
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
          text: truncate(text, settings.history.maxTurnChars),
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
    // The title is complete once the tool field has started.
    if (step.tool === undefined && !done) {
      return text;
    }
    text += '**';
    // The tool enum value is complete once the detail field has started.
    if (step.detail === undefined && !done) {
      return text;
    }
    if (step.tool && step.tool !== 'none') {
      text += ` _(${step.tool})_`;
    }
    text += ` - ${step.detail ?? ''}`;
    // The detail keeps streaming until the next step begins.
    if (steps[i + 1] === undefined && !done) {
      return text;
    }
    if (i < steps.length - 1) {
      text += '\n';
    }
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
function formatExecution(execution: PartialExecution, done: boolean): string {
  let text = messages.execution.header;
  for (const event of execution.events) {
    if (event.kind === 'text') {
      text += '\n\n' + event.text;
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
 * Render the reply as chat markdown. Used both for in-flight snapshots
 * (`done` false) and for the final result (`done` true), so the streamed
 * prefix and the finished reply can never drift apart. Exported for tests.
 */
export function renderReply(reply: ReplyProgress | Reply, done: boolean): string {
  let text = messages.triage.block(reply.intent, reply.reason);
  if (reply.plan) {
    // Once execution output exists the plan is necessarily complete, so it
    // can be rendered unconservatively even while the run is still going.
    text += formatPlan(reply.plan, done || reply.execution !== undefined);
    if (reply.execution) {
      text += '\n\n' + formatExecution(reply.execution, done);
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
 * Builds the chat handler. The handler is thin: it resolves attachments and
 * the conversation history into a protocol run request, starts a run on
 * whichever engine the provider currently selects, folds the run's events
 * back into reply snapshots, and streams each render's new suffix onto the
 * chat. It neither knows nor cares whether the engine is in-process or
 * remote - that is the point of the protocol.
 */
export function createHandler(
  getEngine: () => Engine,
  toolHost: ToolHost
): vscode.ChatRequestHandler {
  return async (request, context, stream, token) => {
    // Resolve attached files/selections and the prior turns; the engine
    // folds them into each step's prompt as that step's model needs them.
    const attachments = await collectAttachments(request.references);
    const history = collectHistory(context.history);

    // Stream the reply as the engine produces it: events fold back into
    // grow-only snapshots, and the streamer appends each render's new suffix
    // to the chat. The event sink must never throw into the engine, so
    // stream errors (e.g. a closed stream) are swallowed here.
    const streamer = new ReplyStreamer(stream);
    const folder = new ReplyFolder();
    const onEvent = (event: RunEvent) => {
      if (token.isCancellationRequested) {
        return;
      }
      if (event.type === 'usage') {
        // The billing seam, surfaced locally as a log line for now.
        console.log(
          `[My Dev Team] usage: ${event.step}` +
            (event.model ? ` (${event.model})` : '') +
            ` in=${event.inputTokens ?? '?'} out=${event.outputTokens ?? '?'}`
        );
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

    const handle = getEngine().startRun(
      {
        protocolVersion: PROTOCOL_VERSION,
        prompt: request.prompt,
        attachments,
        history,
        environment: { os: environment.os, shell: environment.shell },
        offeredTools: [...toolHost.tools],
      },
      { onEvent, toolHost }
    );
    // Cancelling the chat request cancels the run (and its model call)
    // instead of leaving it to finish in the background; the engine aborts
    // in-flight tool executions too, so a running command is killed and a
    // pending write is dropped rather than completing.
    const cancellation = token.onCancellationRequested(() => handle.cancel());

    let reply: Reply;
    try {
      reply = await handle.result;
    } catch (err) {
      // A cancelled request renders nothing: VS Code marks the turn
      // cancelled and the stream may already be closed.
      if (token.isCancellationRequested || err instanceof RunCancelledError) {
        return { metadata: { command: request.command ?? '' } } as vscode.ChatResult;
      }
      if (err instanceof RunFailedError) {
        const separator = streamer.hasEmitted ? '\n\n' : '';
        stream.markdown(separator + renderFailure(err));
        return { metadata: { command: request.command ?? '' } } as vscode.ChatResult;
      }
      throw err;
    } finally {
      cancellation.dispose();
    }

    if (!token.isCancellationRequested) {
      // Emits whatever the streaming path has not already rendered.
      streamer.finish(renderReply(reply, true));
    }
    return { metadata: { command: request.command ?? '' } } as vscode.ChatResult;
  };
}
