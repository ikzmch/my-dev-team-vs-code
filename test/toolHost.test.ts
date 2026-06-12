import { describe, it, expect, beforeEach, vi } from 'vitest';

// child_process.exec is invoked through util.promisify inside runCommand.
// We replace it with a controllable fake before importing the module under test.
const execMock = vi.fn();
vi.mock('child_process', () => ({
  exec: (cmd: string, opts: unknown, cb: Function) => execMock(cmd, opts, cb),
}));

import { WorkspaceToolHost } from '../src/tools/toolHost';
import { Approver } from '../src/tools/types';
import { clientToolNames } from '../src/protocol/toolContract';
import { __reset, __state, __setFile } from './mocks/vscode';

/** Approver test double recording calls and returning a fixed verdict. */
function makeApprover(verdict: boolean): Approver & {
  calls: Array<{ title: string; detail: string }>;
} {
  const calls: Array<{ title: string; detail: string }> = [];
  return {
    calls,
    confirm: async (title: string, detail: string) => {
      calls.push({ title, detail });
      return verdict;
    },
  };
}

beforeEach(() => {
  __reset();
  execMock.mockReset();
});

describe('WorkspaceToolHost', () => {
  it('offers exactly the protocol contract tool names', () => {
    const host = new WorkspaceToolHost(makeApprover(true));
    expect([...host.tools]).toEqual([...clientToolNames]);
  });

  it('read returns the file text', async () => {
    __setFile('src/a.ts', 'const a = 1;');
    const host = new WorkspaceToolHost(makeApprover(true));
    await expect(host.execute('read', { path: 'src/a.ts' })).resolves.toBe(
      'const a = 1;'
    );
  });

  it('read rejects a path outside the workspace', async () => {
    const host = new WorkspaceToolHost(makeApprover(true));
    await expect(host.execute('read', { path: '../etc/passwd' })).rejects.toThrow(
      /outside the workspace/
    );
  });

  it('search joins matches with newlines', async () => {
    const a = __setFile('src/a.ts', 'x');
    const b = __setFile('src/b.ts', 'x');
    __state.findFilesResult = [a, b];
    const host = new WorkspaceToolHost(makeApprover(true));
    await expect(
      host.execute('search', { query: '**/*.ts', mode: 'glob' })
    ).resolves.toBe('src/a.ts\nsrc/b.ts');
  });

  it('search reports no matches instead of returning an empty string', async () => {
    __state.findFilesResult = [];
    const host = new WorkspaceToolHost(makeApprover(true));
    await expect(
      host.execute('search', { query: '**/*.go', mode: 'glob' })
    ).resolves.toBe('(no matches)');
  });

  it('run executes through the given approver and returns the output', async () => {
    execMock.mockImplementation((_cmd, _opts, cb) =>
      cb(null, { stdout: 'hi', stderr: '' })
    );
    const approver = makeApprover(true);
    const host = new WorkspaceToolHost(approver);

    await expect(host.execute('run', { command: 'echo hi' })).resolves.toBe('hi');
    expect(approver.calls[0]).toEqual({ title: 'Run command', detail: '$ echo hi' });
  });

  it('run forwards the shared mirror to runCommand', async () => {
    execMock.mockImplementation((_cmd, _opts, cb) =>
      cb(null, { stdout: 'hi', stderr: '' })
    );
    const entries: string[] = [];
    const mirror = {
      begin: (command: string) => entries.push(`begin:${command}`),
      output: () => {},
      end: (note: string) => entries.push(`end:${note}`),
    };
    const host = new WorkspaceToolHost(makeApprover(true), mirror);
    await host.execute('run', { command: 'echo hi' });
    expect(entries).toEqual(['begin:echo hi', 'end:(command completed)']);
  });

  it('run does not execute when the approver declines', async () => {
    const host = new WorkspaceToolHost(makeApprover(false));
    await expect(host.execute('run', { command: 'rm -rf /' })).resolves.toBe(
      'Command was not approved by the user.'
    );
    expect(execMock).not.toHaveBeenCalled();
  });

  it('passes the signal to run, so a cancelled request skips it', async () => {
    const controller = new AbortController();
    controller.abort();
    const host = new WorkspaceToolHost(makeApprover(true));
    await expect(
      host.execute('run', { command: 'echo hi' }, controller.signal)
    ).resolves.toBe('Command was cancelled before running.');
    expect(execMock).not.toHaveBeenCalled();
  });

  it('passes the signal to write, so a cancelled request skips it', async () => {
    const controller = new AbortController();
    controller.abort();
    const approver = makeApprover(true);
    const host = new WorkspaceToolHost(approver);
    await expect(
      host.execute('write', { path: 'src/new.ts', contents: 'x = 1' }, controller.signal)
    ).resolves.toBe('Write was cancelled; the file was not changed.');
    expect(__state.files.has('/ws/src/new.ts')).toBe(false);
    // The cancelled write never reached the approval prompt either.
    expect(approver.calls).toHaveLength(0);
  });

  it('write creates the file through the given approver', async () => {
    const approver = makeApprover(true);
    const host = new WorkspaceToolHost(approver);

    const result = await host.execute('write', {
      path: 'src/new.ts',
      contents: 'x = 1',
    });
    expect(result).toContain('Wrote src/new.ts');
    expect(__state.files.get('/ws/src/new.ts')).toBe('x = 1');
    expect(approver.calls).toEqual([
      { title: 'Write file', detail: 'src/new.ts\n\nx = 1' },
    ]);
  });

  it('write does not touch the file when the approver declines', async () => {
    __setFile('src/exists.ts', 'old');
    const host = new WorkspaceToolHost(makeApprover(false));

    await expect(
      host.execute('write', { path: 'src/exists.ts', contents: 'new' })
    ).resolves.toBe('Write was not approved by the user; the file was not changed.');
    expect(__state.files.get('/ws/src/exists.ts')).toBe('old');
  });

  it('rejects an unknown tool before touching anything', async () => {
    const host = new WorkspaceToolHost(makeApprover(true));
    await expect(host.execute('delete-everything', {})).rejects.toThrow(
      /Unknown tool/
    );
  });

  it('rejects malformed arguments before the implementation runs', async () => {
    const host = new WorkspaceToolHost(makeApprover(true));
    // Missing required field.
    await expect(host.execute('read', {})).rejects.toThrow();
    // Wrong enum value.
    await expect(
      host.execute('search', { query: 'x', mode: 'everywhere' })
    ).rejects.toThrow();
    // The approver was never consulted and nothing executed.
    expect(execMock).not.toHaveBeenCalled();
  });
});
