import * as vscode from 'vscode';
import { Approver, ChatTurn, OutputSink } from '../core/types';
import { Backend } from '../core/backend';
import { settings } from '../config/settings';

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

  async confirm(title: string, detail: string): Promise<boolean> {
    // A genuinely interactive confirm in chat requires routing button clicks
    // back through a command; for the boilerplate we surface the action and
    // use a modal as the approval gate so the flow is safe out of the box.
    this.stream?.markdown(`\n**${title}**\n\n\`\`\`\n${detail}\n\`\`\`\n`);
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

/**
 * Builds the chat handler. The handler is thin: it converts VS Code's chat
 * context into our UI-agnostic ChatTurn[] and hands off to the backend.
 */
export function createHandler(backend: Backend): vscode.ChatRequestHandler {
  return async (request, context, stream, _token) => {
    // Reconstruct conversation history in our own neutral format.
    const history: ChatTurn[] = [];
    for (const turn of context.history) {
      if (turn instanceof vscode.ChatRequestTurn) {
        history.push({ role: 'user', content: turn.prompt });
      } else if (turn instanceof vscode.ChatResponseTurn) {
        const text = turn.response
          .map((p) =>
            p instanceof vscode.ChatResponseMarkdownPart ? p.value.value : ''
          )
          .join('');
        history.push({ role: 'assistant', content: text });
      }
    }

    // Fold any attached files/selections into the user turn so the backend
    // sees them as part of the message (no Backend interface change needed).
    const attachments = await renderReferences(request.references);
    const userContent = attachments
      ? `${request.prompt}\n\n--- Attached context ---\n${attachments}`
      : request.prompt;
    history.push({ role: 'user', content: userContent });

    // Bridge the UI-agnostic OutputSink onto VS Code's chat stream.
    // The backend is responsible for announcing what it's doing via
    // sink.progress(); we do not emit a generic placeholder here.
    const sink: OutputSink = {
      markdown: (text) => stream.markdown(text),
      progress: (text) => stream.progress(text),
    };

    const reply = await backend.reply(history, sink);
    stream.markdown(reply.text);

    // Render follow-up suggestions as clickable chips.
    return {
      metadata: { command: request.command ?? '' },
      followups: reply.followups,
    } as vscode.ChatResult;
  };
}

/** Attach follow-up provider so `reply.followups` render as suggestions. */
export function attachFollowups(participant: vscode.ChatParticipant) {
  participant.followupProvider = {
    provideFollowups(result: vscode.ChatResult) {
      const fus = (result as any).followups as string[] | undefined;
      return (fus ?? []).map((label) => ({ prompt: label, label }));
    },
  };
}
