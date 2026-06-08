// Core types shared across the agent. Nothing here imports `vscode` UI
// surfaces directly except where unavoidable; the goal is that this layer
// does not care whether the front-end is a Chat Participant or a Webview.

/** A single turn in the conversation. */
export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * The approval seam. Phase 1 implements this with chat confirmation buttons.
 * Phase 2 (Webview) implements the SAME interface with a rich diff/confirm
 * dialog. The agent core only ever calls `confirm()` and never knows which.
 */
export interface Approver {
  /**
   * Ask the user to approve a side-effecting action.
   * @param title   Short label, e.g. "Run command".
   * @param detail  The specific thing about to happen (command text, diff…).
   * @returns true if the user approved.
   */
  confirm(title: string, detail: string): Promise<boolean>;
}

/** How the core streams output back to whatever UI is driving it. */
export interface OutputSink {
  /** Append markdown to the response. */
  markdown(text: string): void;
  /** Show a transient progress message. */
  progress(text: string): void;
}

/** Result of asking the backend to produce a reply. */
export interface AgentReply {
  text: string;
  /** Optional follow-up questions the UI can render as suggestions. */
  followups?: string[];
}
