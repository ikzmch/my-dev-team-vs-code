import * as vscode from 'vscode';
import { Approver, ChatTurn, OutputSink } from '../core/types';
import { Backend } from '../core/backend';

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
    history.push({ role: 'user', content: request.prompt });

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
