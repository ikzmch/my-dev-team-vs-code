import { ChatTurn, AgentReply } from './types';

/**
 * The backend abstraction. Swap the implementation to point at the Anthropic
 * API, the M365 Copilot Chat API, or VS Code's `vscode.lm` models. The rest of
 * the extension only depends on this interface.
 */
export interface Backend {
  /**
   * Produce a reply given the conversation so far.
   * In a real backend this is where you'd run the tool-calling loop with the
   * model: the model asks for a tool, you execute it via the ToolRegistry,
   * feed the result back, and repeat until it returns a final answer.
   */
  reply(history: ChatTurn[]): Promise<AgentReply>;
}

/**
 * Stub backend. Returns canned responses so the extension runs end-to-end
 * with no API key. Replace `reply()` with a real client when ready.
 *
 * To wire a real backend later:
 *  - Anthropic:  POST to https://api.anthropic.com/v1/messages with tools[],
 *                loop on stop_reason === "tool_use".
 *  - M365 Copilot Chat API: POST to the Graph /beta copilot conversations
 *                endpoint (preview); requires a Copilot add-on license.
 *  - vscode.lm:  use vscode.lm.selectChatModels() + sendRequest().
 */
export class StubBackend implements Backend {
  async reply(history: ChatTurn[]): Promise<AgentReply> {
    const lastUser = [...history].reverse().find((t) => t.role === 'user');
    const prompt = lastUser?.content ?? '';

    // Trivial heuristic so the stub feels alive and demonstrates follow-ups.
    if (/\bquestion\b/i.test(prompt)) {
      return {
        text:
          "I can ask clarifying questions before acting. For example: " +
          "which file should I focus on, and do you want me to apply changes " +
          "or just propose them?",
        followups: [
          'Focus on the current file',
          'Just propose changes, do not apply',
        ],
      };
    }

    return {
      text:
        `**(stub backend)** You said: "${prompt}"\n\n` +
        'Swap `StubBackend` for a real client to make this useful. ' +
        'The tool-calling loop and approval flow are already wired.',
      followups: ['Read a file', 'Search the workspace', 'Run a command'],
    };
  }
}
