import * as vscode from 'vscode';
import { StubBackend } from './core/backend';
import { OllamaClient } from './core/ollama';
import { IntentClassifier } from './core/intentClassifier';
import { registerTools } from './tools/registerTools';
import {
  PARTICIPANT_ID,
  ChatApprover,
  createHandler,
  attachFollowups,
} from './ui/chatParticipant';

export function activate(context: vscode.ExtensionContext) {
  // --- Cheap local model used for routing decisions (intent classification). ---
  // Requires a local Ollama daemon with `qwen3:8b` pulled.
  const ollama = new OllamaClient('qwen3:8b');
  const classifier = new IntentClassifier(ollama);

  // --- Agent core (UI-agnostic) ---
  const backend = new StubBackend(classifier);

  // --- Approval seam: Phase 1 uses the chat-based approver ---
  const approver = new ChatApprover();

  // --- Tools: model can call read/search/run/write ---
  registerTools(context, approver);

  // --- UI layer: the chat participant ---
  const participant = vscode.chat.createChatParticipant(
    PARTICIPANT_ID,
    async (request, ctx, stream, token) => {
      approver.setStream(stream); // wire approver to this request's stream
      const handler = createHandler(backend);
      return handler(request, ctx, stream, token);
    }
  );

  // Built-in feedback: 👍/👎 from the native chat panel arrive here.
  participant.onDidReceiveFeedback((fb) => {
    const kind =
      fb.kind === vscode.ChatResultFeedbackKind.Helpful ? 'helpful' : 'unhelpful';
    console.log(`[My Dev Team] feedback: ${kind}`);
    // TODO: forward to telemetry / store for evals.
  });

  attachFollowups(participant);

  context.subscriptions.push(participant);
}

export function deactivate() {}
