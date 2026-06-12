import * as vscode from 'vscode';
import { registerTools } from './tools/registerTools';
import { WorkspaceToolHost } from './tools/toolHost';
import { createEngineProvider } from './client/engineFactory';
import {
  PARTICIPANT_ID,
  ChatApprover,
  createHandler,
} from './ui/chatParticipant';
import { TerminalRunMirror } from './ui/runTerminal';
import { checkEngineAtStartup } from './ui/startupCheck';

export function activate(context: vscode.ExtensionContext) {
  // --- Approval seam: Phase 1 uses the chat-based approver ---
  // Created before the tool host because the side-effecting `run` tool is
  // gated by it. Registering wires up the command its in-chat
  // Approve/Decline buttons invoke.
  const approver = new ChatApprover();
  approver.register(context);

  // --- Run-transparency seam: mirror executed commands into a terminal ---
  // Every approved `run` command's live output lands in a read-only
  // "Dev Team" terminal tab the user can open; never revealed automatically.
  const runMirror = new TerminalRunMirror();
  context.subscriptions.push(runMirror);

  // --- The client's hands: the workspace ToolHost ---
  // The one place tool calls are validated and dispatched, shared by the
  // engine's executor loop and the editor-wide Language Model Tools
  // registrations. Whichever engine runs, the implementations, the approval
  // gate, and the mirror stay here on the user's machine.
  const toolHost = new WorkspaceToolHost(approver, runMirror);
  registerTools(context, toolHost);

  // --- The engine, behind the protocol ---
  // The provider reads `myDevTeam.engine` live per request: the in-process
  // LocalEngine today, a RemoteEngine speaking the same protocol in Phase B.
  // Fire-and-forget health check: the selected engine reports what is wrong
  // (unreachable Ollama, missing models) instead of letting the first chat
  // request be the thing that fails. Never blocks activation.
  const getEngine = createEngineProvider();
  void checkEngineAtStartup(getEngine());

  // --- UI layer: the chat participant ---
  const handler = createHandler(getEngine, toolHost);
  const participant = vscode.chat.createChatParticipant(
    PARTICIPANT_ID,
    async (request, ctx, stream, token) => {
      approver.setStream(stream); // wire approver to this request's stream
      // A cancelled request leaves an approval waiting for a click that can
      // never come; clearing the stream declines it so the run unblocks.
      const cancellation = token.onCancellationRequested(() => approver.clearStream());
      try {
        return await handler(request, ctx, stream, token);
      } finally {
        cancellation.dispose();
        approver.clearStream(); // never leave a finished request's stream behind
      }
    }
  );

  // Built-in feedback: 👍/👎 from the native chat panel arrive here.
  participant.onDidReceiveFeedback((fb) => {
    const kind =
      fb.kind === vscode.ChatResultFeedbackKind.Helpful ? 'helpful' : 'unhelpful';
    console.log(`[My Dev Team] feedback: ${kind}`);
    // TODO: forward to telemetry / store for evals.
  });

  context.subscriptions.push(participant);
}

export function deactivate() {}
