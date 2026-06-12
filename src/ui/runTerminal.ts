/**
 * Phase-1 implementation of the RunMirror seam (tools/types.ts): a read-only
 * "Dev Team" terminal in the terminal panel that replays everything the `run`
 * tool executed - one `$ command` header per run, its live stdout/stderr, and
 * a one-line outcome note - as a session log the user can open at any time.
 *
 * The terminal is a vscode.Pseudoterminal fed from the child process the tool
 * spawned: the process itself stays owned by tools/workspaceTools.ts (capture,
 * timeout, kill-tree are unchanged), this class only displays its output. The
 * terminal is created lazily on the first command and never revealed
 * automatically - it just appears as a tab the user can click.
 *
 * Two quirks of the Pseudoterminal API shape the implementation:
 * - VS Code only calls `Pseudoterminal.open()` once the terminal first
 *   becomes visible; data fired before that is dropped. So every write also
 *   appends to a backlog, and `open()` flushes the backlog first - a user who
 *   looks five minutes later still sees the full history.
 * - The terminal renderer needs CRLF; lone `\n` would stair-step, so line
 *   endings are normalised on write.
 */
import * as vscode from 'vscode';
import { RunMirror } from '../tools/types';
import { settings } from '../config/settings';
import { messages } from '../config/messages';

export class TerminalRunMirror implements RunMirror, vscode.Disposable {
  private terminal: vscode.Terminal | undefined;
  private emitter: vscode.EventEmitter<string> | undefined;
  /** True once open() fired for the current terminal: live writes reach it. */
  private opened = false;
  /** The full session log, replayed by open(); capped per settings. */
  private backlog = '';
  private readonly closeListener: vscode.Disposable;

  constructor() {
    // A user closing the tab must not kill mirroring for the rest of the
    // session: drop the dead terminal and recreate (with the full backlog)
    // on the next command.
    this.closeListener = vscode.window.onDidCloseTerminal((closed) => {
      if (closed === this.terminal) {
        this.discardTerminal();
      }
    });
  }

  begin(command: string): void {
    // A blank line between runs keeps the log readable; never lead with one.
    const separator = this.backlog ? '\n' : '';
    this.write(`${separator}${messages.terminal.prompt(command)}\n`);
  }

  output(chunk: string): void {
    this.write(chunk);
  }

  end(note: string): void {
    // Keep the note on its own line even when the command's output did not
    // end with a newline.
    const lead = this.backlog.endsWith('\r\n') ? '' : '\n';
    this.write(`${lead}${note}\n`);
  }

  dispose(): void {
    this.closeListener.dispose();
    this.terminal?.dispose();
    this.discardTerminal();
  }

  private write(text: string): void {
    const data = text.replace(/\r?\n/g, '\r\n');
    this.backlog = (this.backlog + data).slice(-settings.runMirrorBacklogMaxChars);
    this.ensureTerminal();
    if (this.opened) {
      this.emitter?.fire(data);
    }
  }

  private ensureTerminal(): void {
    if (this.terminal) {
      return;
    }
    const emitter = new vscode.EventEmitter<string>();
    this.emitter = emitter;
    this.opened = false;
    const pty: vscode.Pseudoterminal = {
      onDidWrite: emitter.event,
      open: () => {
        this.opened = true;
        if (this.backlog) {
          emitter.fire(this.backlog);
        }
      },
      close: () => {},
      // No handleInput: the log is read-only, user keystrokes are ignored.
    };
    this.terminal = vscode.window.createTerminal({
      name: messages.terminal.name,
      pty,
    });
  }

  private discardTerminal(): void {
    this.terminal = undefined;
    this.emitter?.dispose();
    this.emitter = undefined;
    this.opened = false;
  }
}
