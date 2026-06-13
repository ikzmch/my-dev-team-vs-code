import * as vscode from 'vscode';
import { registerTools } from './tools/registerTools';
import { WorkspaceToolHost } from './tools/toolHost';
import { createEngineProvider } from './client/engineFactory';
import { EvalLog } from './client/evalLog';
import {
  PARTICIPANT_ID,
  ChatApprover,
  createHandler,
  TurnMetadata,
} from './ui/chatParticipant';
import { TerminalRunMirror } from './ui/runTerminal';
import { checkEngineAtStartup } from './ui/startupCheck';
import {
  ModelStatusBar,
  pickModel,
  runSetApiKeyCommand,
  SELECT_MODEL_COMMAND_ID,
  SET_API_KEY_COMMAND_ID,
} from './ui/modelCommands';
import { loadStoredApiKeys } from './config/credentials';

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

  // --- Model selection ---
  // Load any cloud-provider API keys from SecretStorage into the in-memory
  // cache (env vars are the fallback), then wire the picker, the "Set API Key"
  // command, and a status-bar item showing the active model. The chosen model
  // travels on every run request via the myDevTeam.model setting; the engine
  // routes by capability when it is "auto".
  void loadStoredApiKeys(context.secrets);
  const modelStatusBar = new ModelStatusBar(getEngine(), SELECT_MODEL_COMMAND_ID);
  context.subscriptions.push(modelStatusBar);
  void modelStatusBar.refresh();
  context.subscriptions.push(
    vscode.commands.registerCommand(SELECT_MODEL_COMMAND_ID, async () => {
      await pickModel(getEngine());
      void modelStatusBar.refresh();
    }),
    vscode.commands.registerCommand(SET_API_KEY_COMMAND_ID, () =>
      runSetApiKeyCommand(context.secrets)
    ),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('myDevTeam.model')) {
        void modelStatusBar.refresh();
      }
    })
  );

  // --- Telemetry/eval seam: the local, opt-in eval log ---
  // Run records (route, per-step usage, outcome) and 👍/👎 feedback land in
  // one JSONL file under the extension's global storage when
  // myDevTeam.telemetry.evalLog is on. It stores no prompt or reply text.
  const evalLog = new EvalLog(context.globalStorageUri);

  // --- UI layer: the chat participant ---
  const handler = createHandler(getEngine, toolHost, evalLog);
  const participant = vscode.chat.createChatParticipant(
    PARTICIPANT_ID,
    async (request, ctx, stream, token) => {
      // Each request opens its own approval session: when it ends (or is
      // cancelled, where a pending approval could otherwise block the run
      // forever), disposing declines only this request's approvals - a
      // concurrent turn's pending approval and stream are untouched.
      const session = approver.openSession(stream);
      const cancellation = token.onCancellationRequested(() => session.dispose());
      try {
        return await handler(request, ctx, stream, token);
      } finally {
        cancellation.dispose();
        session.dispose(); // idempotent: a cancelled request already closed it
      }
    }
  );

  // Built-in feedback: 👍/👎 from the native chat panel arrive here. The
  // handler put the run id and route into the judged turn's result metadata,
  // so the click can be paired with the run record it grades.
  participant.onDidReceiveFeedback((fb) => {
    const kind =
      fb.kind === vscode.ChatResultFeedbackKind.Helpful ? 'helpful' : 'unhelpful';
    console.log(`[My Dev Team] feedback: ${kind}`);
    const metadata = (fb.result?.metadata ?? {}) as Partial<TurnMetadata>;
    void evalLog.recordFeedback({
      kind,
      runId: metadata.runId,
      intent: metadata.intent,
      command: metadata.command,
    });
  });

  context.subscriptions.push(participant);
}

export function deactivate() {}
