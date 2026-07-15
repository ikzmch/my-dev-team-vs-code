// The quick-question command: the hotkey path for asking a side question
// while a chat run is busy. VS Code delivers no second chat request from a
// session whose turn is still streaming, so this path bypasses the chat UI
// entirely: an input box takes the question, the run goes straight to the
// engine as the pinned /ask route (no conversation history - a side question
// is context-free by design), and the answer renders into a read-only
// markdown preview beside the editor. A cancellable progress notification
// covers the run.
//
// The engine already multiplexes concurrent runs, so a quick question during
// a long @devteam turn just works; the shared per-provider rate limiter keeps
// the two runs under one quota. No tools are offered: a side question can
// never touch the workspace, structurally rather than by prompt.

import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { Engine, RunCancelledError, RunFailedError } from '../protocol/engine';
import { PROTOCOL_VERSION } from '../protocol/types';
import { ReplyFolder, RunEvent } from '../protocol/events';
import { ToolHost } from '../protocol/toolContract';
import { ASK_COMMAND } from '../config/clientCommands';
import { collectInstructions } from '../client/instructions';
import { EvalLog, UsageEntry } from '../client/evalLog';
import { settings } from '../config/settings';
import { messages } from '../config/messages';

/** Command id of the quick-question entry point (bound to a key in package.json). */
export const QUICK_QUESTION_COMMAND_ID = 'myDevTeam.quickQuestion';

/** The virtual-document scheme the answer content provider serves. */
const SCHEME = 'devteam-answer';

/**
 * The ToolHost a quick question ships: no tools. The /ask route answers in a
 * single model call and never calls tools, but the host is the structural
 * guarantee - even a misrouted run could not read, write, or execute anything.
 */
const noTools: ToolHost = {
  tools: [],
  execute: async () => messages.quickAsk.noTools,
};

/**
 * Serves quick answers as read-only virtual markdown documents and opens the
 * preview tab, mirroring PlanPreview (ui/planPreview.ts): one instance is
 * registered on activation, each question opens (and streams into) its own
 * document keyed by a short id, so concurrent questions do not collide. Unlike
 * a plan preview the tab is not closed when the run ends - the answer is the
 * product, the user closes it when done reading - so only a cancelled
 * question's tab is cleaned up.
 */
export class AnswerPreview {
  /** Question id -> the markdown its virtual document currently serves. */
  private readonly contents = new Map<string, string>();
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();

  /** Register the content provider. Call once on activation. */
  register(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      this.changed,
      vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
        onDidChange: this.changed.event,
        provideTextDocumentContent: (uri) => this.contents.get(uri.path) ?? '',
      })
    );
  }

  /** The virtual-document uri for a question id; its last path segment is the tab name. */
  private uriFor(id: string): vscode.Uri {
    return vscode.Uri.from({ scheme: SCHEME, path: `/${messages.quickAsk.fileName(id)}` });
  }

  /**
   * Open (or refresh) the preview for question `id` showing `markdown`, and
   * return a disposable that removes the content and closes the tab. Opening
   * to the side keeps the editor visible; a second call for the same id
   * refreshes the open preview in place, which is what streams the answer in.
   */
  open(markdown: string, id: string): vscode.Disposable {
    const uri = this.uriFor(id);
    const existed = this.contents.has(uri.path);
    this.contents.set(uri.path, markdown);
    if (existed) {
      this.changed.fire(uri);
    } else {
      void vscode.commands.executeCommand('markdown.showPreviewToSide', uri);
    }
    return { dispose: () => this.close(id) };
  }

  private close(id: string): void {
    const uri = this.uriFor(id);
    if (!this.contents.delete(uri.path)) {
      return;
    }
    // Best-effort: close the preview tab by its per-id file name, exactly like
    // PlanPreview.close. A broken or stubbed tabGroups must never throw out of
    // a question's cleanup - a stale tab is harmless.
    const fileName = messages.quickAsk.fileName(id);
    try {
      for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
          if (tab.label.includes(fileName)) {
            void vscode.window.tabGroups.close(tab);
          }
        }
      }
    } catch {
      // tabGroups unavailable; leave the preview open.
    }
  }
}

/** Short per-window question counter: the preview tab reads "Quick answer 1.md". */
let nextQuestionId = 1;

/**
 * Render the answer document: the title, the quoted question, then the body -
 * the streaming answer so far (with a working note until the run settles), or
 * the failure text.
 */
function answerDocument(question: string, body: string, done: boolean): string {
  return (
    messages.quickAsk.title +
    messages.quickAsk.question(question) +
    body +
    (done ? '' : (body ? '\n\n' : '') + messages.quickAsk.working)
  );
}

/**
 * Ask and answer one quick question: prompt for the question, run it as the
 * pinned /ask route on whichever engine the provider currently selects, and
 * stream the answer into the preview. Cancelling the progress notification
 * cancels the run and closes the preview. Usage is reported like a chat
 * turn's: `onRunUsage` feeds the session token counter, and the run lands in
 * the opt-in eval log with the ask command and its own conversation id.
 */
export async function runQuickQuestion(
  getEngine: () => Engine,
  preview: AnswerPreview,
  evalLog?: EvalLog,
  onRunUsage?: (usage: readonly UsageEntry[]) => void
): Promise<void> {
  const input = await vscode.window.showInputBox({
    prompt: messages.quickAsk.inputPrompt,
    placeHolder: messages.quickAsk.inputPlaceholder,
  });
  const question = input?.trim();
  if (!question) {
    return;
  }

  const runId = randomUUID();
  const questionId = String(nextQuestionId++);
  const startedAt = Date.now();
  const usage: UsageEntry[] = [];
  const instructions = await collectInstructions();

  // Open the preview immediately with the question and a working note, so the
  // hotkey gives feedback before the first token arrives.
  const previewHandle = preview.open(answerDocument(question, '', false), questionId);

  const folder = new ReplyFolder();
  const onEvent = (event: RunEvent) => {
    if (event.type === 'usage') {
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
      return;
    }
    const progress = folder.apply(event);
    // Stream the growing answer into the preview; the final render comes from
    // the validated result below. The sink must never throw into the engine.
    if (progress?.answer !== undefined && event.type !== 'done') {
      try {
        preview.open(answerDocument(question, progress.answer, false), questionId);
      } catch {
        // Rendering is best-effort; the run itself is untouched.
      }
    }
  };

  const handle = getEngine().startRun(
    {
      protocolVersion: PROTOCOL_VERSION,
      prompt: question,
      // The pinned side-question route: oneshot, no planner, no executor.
      command: ASK_COMMAND,
      model: settings.model,
      instructions,
      // A side question is context-free (no history) and workspace-blind (no
      // tools); the workspace's standing instructions still apply.
      offeredTools: [],
    },
    { onEvent, toolHost: noTools }
  );

  const recordRun = (ending: 'ok' | 'error' | 'cancelled', errorStep?: string) => {
    onRunUsage?.(usage);
    void evalLog?.recordRun({
      runId,
      // A side question is its own thread, not part of any chat conversation.
      conversationId: runId,
      command: ASK_COMMAND,
      intent: 'oneshot',
      outcome: ending,
      errorStep,
      usage,
      durationMs: Date.now() - startedAt,
    });
  };

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: messages.quickAsk.progressTitle,
      cancellable: true,
    },
    async (_progress, token) => {
      const cancellation = token.onCancellationRequested(() => handle.cancel());
      try {
        const reply = await handle.result;
        recordRun('ok');
        preview.open(answerDocument(question, reply.answer ?? '', true), questionId);
      } catch (err) {
        if (token.isCancellationRequested || err instanceof RunCancelledError) {
          recordRun('cancelled');
          // A cancelled question renders nothing: close its preview tab.
          previewHandle.dispose();
          return;
        }
        if (err instanceof RunFailedError) {
          recordRun('error', err.step);
          preview.open(
            answerDocument(
              question,
              messages.quickAsk.failed(err.message) + (err.hint ?? ''),
              true
            ),
            questionId
          );
          return;
        }
        throw err;
      } finally {
        cancellation.dispose();
      }
    }
  );
}

/**
 * Register the quick-question entry point: the answer preview's content
 * provider and the command the keybinding (and palette) invoke. Called once on
 * activation, with the same engine provider, eval log, and usage sink the chat
 * handler uses - a quick question is billed and logged like any run.
 */
export function registerQuickQuestion(
  context: vscode.ExtensionContext,
  getEngine: () => Engine,
  evalLog?: EvalLog,
  onRunUsage?: (usage: readonly UsageEntry[]) => void
): void {
  const preview = new AnswerPreview();
  preview.register(context);
  context.subscriptions.push(
    vscode.commands.registerCommand(QUICK_QUESTION_COMMAND_ID, () =>
      runQuickQuestion(getEngine, preview, evalLog, onRunUsage)
    )
  );
}
