import * as vscode from 'vscode';
import { Approver } from '../core/types';
import {
  DevTeamWorkflow,
  ReplyResult,
  stepIds,
} from '../core/workflow';
import { PlanResult } from '../core/planner';
import { settings } from '../config/settings';
import { messages } from '../config/messages';

export const PARTICIPANT_ID = 'myDevTeam.agent';

/**
 * Phase 1 approval: ask in the chat stream with confirmation buttons.
 * When you add a Webview later, write a WebviewApprover that implements the
 * same `Approver` interface with a rich diff dialog — the tools won't change.
 *
 * The chat stream is per-request, so we set it on each turn.
 */
export class ChatApprover implements Approver {
  private stream: vscode.ChatResponseStream | undefined;

  setStream(stream: vscode.ChatResponseStream) {
    this.stream = stream;
  }

  /**
   * Detach the stream when its request ends. The tools are registered
   * editor-wide and can be invoked outside a @devteam turn; without this, an
   * approval arriving later would write into a finished request's stream.
   */
  clearStream() {
    this.stream = undefined;
  }

  async confirm(title: string, detail: string): Promise<boolean> {
    // A genuinely interactive confirm in chat requires routing button clicks
    // back through a command; for the boilerplate we surface the action and
    // use a modal as the approval gate so the flow is safe out of the box.
    // The modal carries the full detail, so the stream echo is best-effort:
    // a stale or disposed stream must not break the approval flow.
    try {
      this.stream?.markdown(`\n**${title}**\n\n\`\`\`\n${detail}\n\`\`\`\n`);
    } catch {
      // The stream's request has ended; the modal below still shows the detail.
    }
    const pick = await vscode.window.showWarningMessage(
      `${title}?`,
      { modal: true, detail },
      'Approve'
    );
    return pick === 'Approve';
  }
}

function truncate(text: string): string {
  // Cap on inlined attachment text so a huge file can't blow up the prompt.
  return text.length > settings.maxAttachmentChars
    ? text.slice(0, settings.maxAttachmentChars) + '\n…(truncated)'
    : text;
}

/**
 * Resolve files/selections the user attached to the chat request into text
 * blocks. VS Code delivers attachments on `request.references`, not in the
 * prompt: each `value` is a Uri (whole file), a Location (file + range, e.g. a
 * selection), or a plain string.
 */
async function renderReferences(
  refs: readonly vscode.ChatPromptReference[]
): Promise<string> {
  const blocks: string[] = [];
  for (const ref of refs) {
    const v = ref.value;
    try {
      if (v instanceof vscode.Uri) {
        const bytes = await vscode.workspace.fs.readFile(v);
        const rel = vscode.workspace.asRelativePath(v);
        blocks.push(
          `File: ${rel}\n\`\`\`\n${truncate(Buffer.from(bytes).toString('utf8'))}\n\`\`\``
        );
      } else if (v instanceof vscode.Location) {
        const doc = await vscode.workspace.openTextDocument(v.uri);
        const rel = vscode.workspace.asRelativePath(v.uri);
        const startLine = v.range.start.line + 1;
        blocks.push(
          `Selection from ${rel} (line ${startLine}):\n\`\`\`\n${truncate(doc.getText(v.range))}\n\`\`\``
        );
      } else if (typeof v === 'string') {
        blocks.push(truncate(v));
      }
    } catch (err) {
      blocks.push(`(could not read attachment: ${String(err)})`);
    }
  }
  return blocks.join('\n\n');
}

/** Which transient progress label to show when a given workflow step starts. */
const progressByStep: Record<string, string> = {
  [stepIds.triage]: messages.progress.understanding,
  [stepIds.plan]: messages.progress.drafting,
};

/** Render a structured plan as a readable markdown checklist. */
function formatPlan(plan: PlanResult): string {
  const steps = plan.steps
    .map((step, i) => {
      const tool = step.tool === 'none' ? '' : ` _(${step.tool})_`;
      return `${i + 1}. **${step.title}**${tool} — ${step.detail}`;
    })
    .join('\n');
  return messages.plan.header(plan.summary) + `${steps}\n\n` + messages.plan.nextStep;
}

/** Render the workflow's structured reply as chat markdown. */
function renderReply(reply: ReplyResult): string {
  let text = messages.triage.block(reply.intent, reply.reason);
  text += reply.plan ? formatPlan(reply.plan) : messages.triage.oneshotNextStep;
  return text;
}

/** Render a failed run, attributing the error to the step that failed. */
function renderFailure(
  error: unknown,
  steps: Record<string, { status: string }>
): string {
  // Mastra serializes step errors to plain `{ message, … }` objects, so the
  // value here may be an Error, a serialized error, or anything thrown.
  const detail =
    typeof error === 'object' && error !== null && 'message' in error
      ? String((error as { message: unknown }).message)
      : String(error);
  return steps[stepIds.plan]?.status === 'failed'
    ? messages.plan.error(detail)
    : messages.triage.error(detail);
}

/**
 * Builds the chat handler. The handler is thin: it folds attachments into the
 * prompt, starts a run of the dev-team workflow, bridges the run's step
 * events onto the chat stream as progress, and renders the structured result.
 */
export function createHandler(workflow: DevTeamWorkflow): vscode.ChatRequestHandler {
  return async (request, _context, stream, token) => {
    // Fold any attached files/selections into the prompt so the workflow
    // sees them as part of the request.
    const attachments = await renderReferences(request.references);
    const prompt = attachments
      ? `${request.prompt}\n\n--- Attached context ---\n${attachments}`
      : request.prompt;

    const run = await workflow.createRun();
    // Cancelling the chat request aborts the run (and its model call) instead
    // of leaving it to finish in the background.
    const cancellation = token.onCancellationRequested(() => {
      void run.cancel();
    });
    const unwatch = run.watch((event) => {
      if (event.type === 'workflow-step-start') {
        const label = progressByStep[event.payload.id];
        if (label) {
          stream.progress(label);
        }
      }
    });

    let result;
    try {
      result = await run.start({ inputData: { prompt } });
    } catch (err) {
      if (token.isCancellationRequested) {
        return { metadata: { command: request.command ?? '' } } as vscode.ChatResult;
      }
      throw err;
    } finally {
      unwatch();
      cancellation.dispose();
    }

    // A cancelled request renders nothing: VS Code marks the turn cancelled
    // and the stream may already be closed.
    if (token.isCancellationRequested || (result.status as string) === 'canceled') {
      return { metadata: { command: request.command ?? '' } } as vscode.ChatResult;
    }

    if (result.status === 'success') {
      stream.markdown(renderReply(result.result));
    } else if (result.status === 'failed') {
      stream.markdown(renderFailure(result.error, result.steps));
    } else {
      stream.markdown(messages.run.unexpectedStatus(result.status));
    }

    return { metadata: { command: request.command ?? '' } } as vscode.ChatResult;
  };
}
