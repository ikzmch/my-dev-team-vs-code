// Core types shared across the agent. Nothing here imports `vscode` UI
// surfaces directly except where unavoidable; the goal is that this layer
// does not care whether the front-end is a Chat Participant or a Webview.
//
// LLM-facing shapes are the standard ones: Mastra agents/workflows and the
// AI SDK's message types. Only the seams that are genuinely ours live here.

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
