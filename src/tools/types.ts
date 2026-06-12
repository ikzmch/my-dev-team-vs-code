// The client-side UI seams of the tool layer. These stay in the extension
// forever - they gate and surface side effects on the user's machine - and
// they never cross the engine protocol: an engine only ever sees a tool's
// returned text, never how the approval or the mirroring happened. Nothing
// here imports `vscode` UI surfaces; the goal is that the tools do not care
// whether the front-end is a Chat Participant or a Webview.

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

/**
 * The run-transparency seam, shaped like the Approver: the `run` tool reports
 * each executed command's lifecycle to it, and a UI implementation decides how
 * to surface that (Phase 1 mirrors it into a "Dev Team" terminal the user can
 * open; see ui/runTerminal.ts). The tool layer never knows which. All methods
 * are fire-and-forget notifications and must not throw - a broken mirror must
 * never fail the command it is only observing.
 */
export interface RunMirror {
  /** A command was approved and is starting. */
  begin(command: string): void;
  /** A chunk of the live stdout/stderr of the running command. */
  output(chunk: string): void;
  /** The command finished; `note` is a one-line outcome (ok, failed, timeout). */
  end(note: string): void;
}
