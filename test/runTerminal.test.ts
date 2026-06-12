import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TerminalRunMirror } from '../src/ui/runTerminal';
import { messages } from '../src/config/messages';
import { settings } from '../src/config/settings';
import {
  __reset,
  __state,
  __closeTerminal,
  window,
  FakeTerminal,
} from './mocks/vscode';

beforeEach(() => {
  __reset();
  vi.mocked(window.createTerminal).mockClear();
});

/**
 * Simulate the user opening the mirror terminal: subscribe to its writes
 * (like the renderer does) and fire the pty's open(). Returns the collected
 * write data.
 */
function openTerminal(terminal: FakeTerminal): string[] {
  const written: string[] = [];
  const pty = terminal.creationOptions.pty;
  pty.onDidWrite((data: string) => written.push(data));
  pty.open(undefined);
  return written;
}

describe('TerminalRunMirror', () => {
  it('creates no terminal until the first command runs', () => {
    new TerminalRunMirror();
    expect(__state.terminals).toHaveLength(0);
  });

  it('creates the named terminal lazily and never reveals it', () => {
    const mirror = new TerminalRunMirror();
    mirror.begin('npm test');
    expect(__state.terminals).toHaveLength(1);
    expect(__state.terminals[0].name).toBe(messages.terminal.name);
    expect(__state.terminals[0].show).not.toHaveBeenCalled();
  });

  it('replays the buffered session log when the user opens the terminal', () => {
    // VS Code only calls Pseudoterminal.open() once the terminal becomes
    // visible; everything written before must be buffered, not lost.
    const mirror = new TerminalRunMirror();
    mirror.begin('npm test');
    mirror.output('line1\nline2');
    mirror.end(messages.terminal.completed);

    const written = openTerminal(__state.terminals[0]);
    expect(written.join('')).toBe(
      '$ npm test\r\nline1\r\nline2\r\n(command completed)\r\n'
    );
  });

  it('streams live once the terminal is open, without re-sending history', () => {
    const mirror = new TerminalRunMirror();
    mirror.begin('npm test');
    const written = openTerminal(__state.terminals[0]);
    const replayed = written.length;

    mirror.output('hi\n');
    expect(written.slice(replayed)).toEqual(['hi\r\n']);
  });

  it('converts bare newlines to CRLF for the terminal renderer', () => {
    const mirror = new TerminalRunMirror();
    mirror.begin('echo');
    mirror.output('a\nb\r\nc');
    const written = openTerminal(__state.terminals[0]);
    expect(written.join('')).toContain('a\r\nb\r\nc');
    expect(written.join('')).not.toMatch(/[^\r]\n/);
  });

  it('separates consecutive commands with a blank line', () => {
    const mirror = new TerminalRunMirror();
    mirror.begin('first');
    mirror.end(messages.terminal.completed);
    mirror.begin('second');

    const written = openTerminal(__state.terminals[0]);
    expect(written.join('')).toBe(
      '$ first\r\n(command completed)\r\n\r\n$ second\r\n'
    );
  });

  it('keeps the outcome note on its own line after output without a newline', () => {
    const mirror = new TerminalRunMirror();
    mirror.begin('echo -n hi');
    mirror.output('hi');
    mirror.end(messages.terminal.completed);
    const written = openTerminal(__state.terminals[0]);
    expect(written.join('')).toBe('$ echo -n hi\r\nhi\r\n(command completed)\r\n');
  });

  it('recreates the terminal with the full history after the user closes it', () => {
    const mirror = new TerminalRunMirror();
    mirror.begin('first');
    openTerminal(__state.terminals[0]);

    __closeTerminal(__state.terminals[0]);
    mirror.begin('second');

    expect(__state.terminals).toHaveLength(2);
    const written = openTerminal(__state.terminals[1]);
    expect(written.join('')).toBe('$ first\r\n\r\n$ second\r\n');
  });

  it('ignores other terminals being closed', () => {
    const mirror = new TerminalRunMirror();
    mirror.begin('first');
    const other = window.createTerminal({ name: 'user shell' });
    __closeTerminal(other);

    mirror.output('still here\n');
    // No replacement terminal was created; the mirror's one is still in use.
    expect(__state.terminals.filter((t) => t.name === messages.terminal.name)).toHaveLength(1);
  });

  it('caps the backlog at the configured size', () => {
    const mirror = new TerminalRunMirror();
    mirror.begin('big');
    mirror.output('x'.repeat(settings.runMirrorBacklogMaxChars + 100));
    const written = openTerminal(__state.terminals[0]);
    expect(written.join('').length).toBe(settings.runMirrorBacklogMaxChars);
  });

  it('dispose() disposes the terminal and stops listening for closes', () => {
    const mirror = new TerminalRunMirror();
    mirror.begin('first');
    const terminal = __state.terminals[0];

    mirror.dispose();
    expect(terminal.dispose).toHaveBeenCalled();
    expect(__state.terminalCloseListeners).toHaveLength(0);
  });
});
