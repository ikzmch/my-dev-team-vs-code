import * as vscode from 'vscode';
import { Triage } from './core/triage';
import { Planner } from './core/planner';
import { Answerer } from './core/answerer';
import { Executor } from './core/executor';
import { createDevTeamWorkflow } from './core/workflow';
import { registerTools } from './tools/registerTools';
import {
  PARTICIPANT_ID,
  ChatApprover,
  createHandler,
} from './ui/chatParticipant';
import { checkOllamaAtStartup } from './ui/startupCheck';

export function activate(context: vscode.ExtensionContext) {
  // Fire-and-forget health check: warn now if the configured Ollama endpoint
  // is unreachable or a router-selected model is not pulled, instead of
  // failing on the first chat request. Never blocks activation.
  void checkOllamaAtStartup();

  // --- Approval seam: Phase 1 uses the chat-based approver ---
  // Created before the agents because the Executor's side-effecting tools
  // (run, write) are gated by it. Registering wires up the command its
  // in-chat Approve/Decline buttons invoke.
  const approver = new ChatApprover();
  approver.register(context);

  // --- Agent core (UI-agnostic) ---
  // Each agent declares weighted capability requirements and the router
  // (`config/models.ts` + `core/models.ts`) wires the best registered model;
  // tune capabilities and the registry there, not here. The Mastra workflow
  // orchestrates them: triage → draft a plan and execute it / answer directly.
  const workflow = createDevTeamWorkflow(
    new Triage(),
    new Planner(),
    new Answerer(),
    new Executor(approver)
  );

  // --- Tools: model can call read/search/run/write ---
  registerTools(context, approver);

  // --- UI layer: the chat participant ---
  const handler = createHandler(workflow);
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
