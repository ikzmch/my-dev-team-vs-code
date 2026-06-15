import * as vscode from 'vscode';
import { registerTools } from './tools/registerTools';
import { WorkspaceToolHost } from './tools/toolHost';
import { McpHub } from './client/mcp';
import { createEngineProvider } from './client/engineFactory';
import { EvalLog } from './client/evalLog';
import { ChangeTracker } from './client/changeTracker';
import {
  PARTICIPANT_ID,
  ChatApprover,
  ChatPlanReviewer,
  createHandler,
  TurnMetadata,
} from './ui/chatParticipant';
import { PlanPreview } from './ui/planPreview';
import { TerminalRunMirror } from './ui/runTerminal';
import { checkEngineAtStartup } from './ui/startupCheck';
import {
  pickModel,
  runSetApiKeyCommand,
  SELECT_MODEL_COMMAND_ID,
  SET_API_KEY_COMMAND_ID,
} from './ui/modelCommands';
import { pickVerbosity, SELECT_VERBOSITY_COMMAND_ID } from './ui/verbosityCommands';
import { StatusBar, STATUS_MENU_COMMAND_ID } from './ui/statusBar';
import { runShowUsageCommand, SHOW_USAGE_COMMAND_ID } from './ui/usageView';
import { registerEditorEntryPoints } from './ui/editorEntryPoints';
import { setRuntimeConfig } from './config/runtimeConfig';
import { liveRuntimeConfig } from './config/settings';
import { setSecretSource } from './config/credentials';
import { loadStoredApiKeys, secretStorageSource } from './client/secrets';

export function activate(context: vscode.ExtensionContext) {
  // --- Engine runtime config ---
  // The engine reads the user's settings through the injected runtime-config
  // seam (config/runtimeConfig.ts), never `vscode` directly, so it can run in a
  // separate process (the sidecar). In the host we inject a live view backed by
  // `settings`, so a settings change still takes effect on the next request.
  setRuntimeConfig(liveRuntimeConfig());

  // Cloud keys: the in-process local engine may use the editor's SecretStorage
  // (the "Set API Key" command), so inject that source and load any stored keys.
  // The sidecar child never loads this module, so it keeps the env-only default.
  setSecretSource(secretStorageSource);
  void loadStoredApiKeys(context.secrets);

  // --- Approval seam: Phase 1 uses the chat-based approver ---
  // Created before the tool host because the side-effecting `run` tool is
  // gated by it. Registering wires up the command its in-chat
  // Approve/Decline buttons invoke.
  const approver = new ChatApprover();
  approver.register(context);

  // --- Plan-preview seam: a big paused plan opens beside the chat ---
  // Serves the plan markdown as a read-only virtual document; the reviewer
  // opens/closes it per review. Registered before the reviewer it backs.
  const planPreview = new PlanPreview();
  planPreview.register(context);

  // --- Plan-approval seam: the gate shown before a plan executes ---
  // Like the approver, registered up front so its in-chat Approve/Cancel/Revise
  // links work; the engine calls it via the run client's reviewPlan when the
  // myDevTeam.planApproval setting asks to pause. The preview seam lets a big
  // plan also open in the editor per myDevTeam.planApproval.preview.
  const planReviewer = new ChatPlanReviewer(planPreview);
  planReviewer.register(context);

  // --- Run-transparency seam: mirror executed commands into a terminal ---
  // Every approved `run` command's live output lands in a read-only
  // "Dev Team" terminal tab the user can open; never revealed automatically.
  const runMirror = new TerminalRunMirror();
  context.subscriptions.push(runMirror);

  // --- Change-tracking seam: sum each turn's writes into a Changes line ---
  // The write/edit tools report every file they land here; the chat handler
  // opens a per-turn session and renders the rolled-up "N files changed" line.
  const changeTracker = new ChangeTracker();

  // --- MCP seam: tools from user-configured MCP servers ---
  // Launches the servers configured in myDevTeam.mcp.servers (over stdio,
  // nothing in an untrusted workspace), discovers their tools, and runs a call
  // back through the ToolHost behind the same Approver as the run tool. Disposed
  // on deactivate so the server processes are closed.
  const mcp = new McpHub();
  context.subscriptions.push({ dispose: () => void mcp.dispose() });

  // --- The client's hands: the workspace ToolHost ---
  // The one place tool calls are validated and dispatched, shared by the
  // engine's executor loop and the editor-wide Language Model Tools
  // registrations. Whichever engine runs, the implementations, the approval
  // gate, the mirror, and the change tracker stay here on the user's machine.
  // The MCP hub is handed in so a discovered MCP tool dispatches like any other.
  const toolHost = new WorkspaceToolHost(approver, runMirror, changeTracker, mcp);
  registerTools(context, toolHost);

  // --- The engine, behind the protocol ---
  // The provider reads `myDevTeam.engine` live per request: the in-process
  // LocalEngine today, a RemoteEngine speaking the same protocol in Phase B.
  // Fire-and-forget health check: the selected engine reports what is wrong
  // (unreachable Ollama, missing models) instead of letting the first chat
  // request be the thing that fails. Never blocks activation.
  const sidecarScriptPath = vscode.Uri.joinPath(
    context.extensionUri,
    'dist',
    'sidecar.js'
  ).fsPath;
  const engineProvider = createEngineProvider(sidecarScriptPath);
  const getEngine = engineProvider.getEngine;
  context.subscriptions.push({ dispose: () => engineProvider.dispose() });
  void checkEngineAtStartup(getEngine());

  // --- The unified status-bar button ---
  // One "My Dev Team" button whose menu changes the model and opens the usage
  // report; it also holds the live state those rows show (the current model
  // label and the running session token total). Created here so model
  // selection can refresh its label and the chat handler can feed it usage.
  const statusBar = new StatusBar(getEngine(), STATUS_MENU_COMMAND_ID);
  context.subscriptions.push(statusBar);
  void statusBar.refresh();
  context.subscriptions.push(
    vscode.commands.registerCommand(STATUS_MENU_COMMAND_ID, () => statusBar.openMenu())
  );

  // --- Model selection ---
  // Wire the model picker and the "Set API Key" command (the latter stores a
  // cloud key in SecretStorage for the local engine). The chosen model travels
  // on every run request via the myDevTeam.model setting; the engine routes by
  // capability when it is "auto". The status button's menu shows the active
  // model and refreshes after a pick.
  context.subscriptions.push(
    vscode.commands.registerCommand(SELECT_MODEL_COMMAND_ID, async () => {
      await pickModel(getEngine());
      void statusBar.refresh();
    }),
    vscode.commands.registerCommand(SET_API_KEY_COMMAND_ID, () =>
      runSetApiKeyCommand(context.secrets)
    ),
    // Output verbosity: a pure rendering setting the chat renderer reads live,
    // so the picker is just a setting write (no status-bar refresh needed - the
    // menu reads the mode fresh when it opens).
    vscode.commands.registerCommand(SELECT_VERBOSITY_COMMAND_ID, () => pickVerbosity()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('myDevTeam.model')) {
        void statusBar.refresh();
      }
    })
  );

  // --- Telemetry/eval seam: the local, opt-in eval log ---
  // Run records (route, per-step usage, outcome) and 👍/👎 feedback land in
  // one JSONL file under the extension's global storage when
  // myDevTeam.telemetry.evalLog is on. It stores no prompt or reply text.
  const evalLog = new EvalLog(context.globalStorageUri);

  // --- Token-usage surfaces ---
  // The status button accumulates each run's tokens live (independent of the
  // opt-in log) and shows the session total in its menu, and the "Show Token
  // Usage" command rolls the stored log up into a report. The handler feeds the
  // button every finished run's usage.
  context.subscriptions.push(
    vscode.commands.registerCommand(SHOW_USAGE_COMMAND_ID, () =>
      runShowUsageCommand(evalLog)
    )
  );

  // --- Editor entry points ---
  // Meet the user in the editor, not only the chat panel: a "Fix with Dev
  // Team" quick fix on a diagnostic, an "Explain with Dev Team" selection
  // action, and a write/repair-tests CodeLens on test files. Each is a thin
  // shim that opens the chat with a pinned slash command, so the routing,
  // references, and approvals all flow through the same pipeline.
  registerEditorEntryPoints(context);

  // --- UI layer: the chat participant ---
  const handler = createHandler(
    getEngine,
    toolHost,
    evalLog,
    (usage) => statusBar.add(usage),
    changeTracker,
    planReviewer,
    // The handler owns the approval session: it opens one keyed by the run id
    // and binds the run's tool calls to it, so an approval renders in the turn
    // that owns it. The plan-review session has no such per-call seam, so the
    // wrapper still manages it the most-recent way below.
    approver,
    // The same MCP hub the ToolHost uses: the handler discovers its tools and
    // ships them on the run request, so the offered names and shipped
    // definitions are one set.
    mcp
  );
  const participant = vscode.chat.createChatParticipant(
    PARTICIPANT_ID,
    async (request, ctx, stream, token) => {
      // Each request opens its own plan-review session: when it ends (or is
      // cancelled, where a pending prompt could otherwise block the run
      // forever), disposing settles only this request's review - a concurrent
      // turn's pending review and stream are untouched. (The approval session
      // is opened inside the handler, keyed by the run id.)
      const reviewSession = planReviewer.openSession(stream);
      const cancellation = token.onCancellationRequested(() => {
        reviewSession.dispose();
      });
      try {
        return await handler(request, ctx, stream, token);
      } finally {
        cancellation.dispose();
        reviewSession.dispose(); // idempotent: a cancelled request already closed it
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
