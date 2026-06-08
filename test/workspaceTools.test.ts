import { describe, it, expect, beforeEach, vi } from 'vitest';

// child_process.exec is invoked through util.promisify inside runCommand.
// We replace it with a controllable fake before importing the module under test.
const execMock = vi.fn();
vi.mock('child_process', () => ({
  exec: (cmd: string, opts: unknown, cb: Function) => execMock(cmd, opts, cb),
}));

import {
  readFile,
  searchFiles,
  runCommand,
  writeFile,
} from '../src/tools/workspaceTools';
import { Approver } from '../src/core/types';
import { __reset, __state, __setFile, Uri } from './mocks/vscode';

/** Approver test double recording calls and returning a fixed verdict. */
function makeApprover(verdict: boolean): Approver & {
  calls: Array<{ title: string; detail: string }>;
} {
  const calls: Array<{ title: string; detail: string }> = [];
  return {
    calls,
    async confirm(title, detail) {
      calls.push({ title, detail });
      return verdict;
    },
  };
}

beforeEach(() => {
  __reset();
  execMock.mockReset();
});

describe('readFile', () => {
  it('returns the utf8 contents of an existing file', async () => {
    __setFile('src/a.ts', 'hello world');
    await expect(readFile('src/a.ts')).resolves.toBe('hello world');
  });

  it('rejects when the file does not exist', async () => {
    await expect(readFile('missing.ts')).rejects.toThrow(/ENOENT/);
  });

  it('throws when no workspace folder is open', async () => {
    __state.workspaceFolders = undefined;
    await expect(readFile('a.ts')).rejects.toThrow('No workspace folder is open.');
  });
});

describe('searchFiles (glob mode)', () => {
  it('maps found uris to workspace-relative paths', async () => {
    __state.findFilesResult = [
      Uri.joinPath(__state.workspaceFolders![0].uri, 'src/a.ts'),
      Uri.joinPath(__state.workspaceFolders![0].uri, 'src/b.ts'),
    ];
    await expect(searchFiles('**/*.ts', 'glob')).resolves.toEqual([
      'src/a.ts',
      'src/b.ts',
    ]);
  });

  it('returns an empty list when nothing matches', async () => {
    __state.findFilesResult = [];
    await expect(searchFiles('**/*.md', 'glob')).resolves.toEqual([]);
  });
});

describe('searchFiles (content mode)', () => {
  it('returns only files whose contents include the query', async () => {
    const a = __setFile('a.ts', 'const needle = 1;');
    const b = __setFile('b.ts', 'unrelated');
    const c = __setFile('c.ts', 'also needle here');
    __state.findFilesResult = [a, b, c];

    const results = await searchFiles('needle', 'content');
    expect(results).toEqual(['a.ts', 'c.ts']);
  });

  it('skips files that cannot be read without failing', async () => {
    const a = __setFile('a.ts', 'has needle');
    const ghost = Uri.joinPath(__state.workspaceFolders![0].uri, 'ghost.ts');
    __state.findFilesResult = [a, ghost]; // ghost is not seeded -> readFile throws
    await expect(searchFiles('needle', 'content')).resolves.toEqual(['a.ts']);
  });

  it('caps content matches at 50 results', async () => {
    const uris: Uri[] = [];
    for (let i = 0; i < 60; i++) {
      uris.push(__setFile(`f${i}.ts`, 'needle'));
    }
    __state.findFilesResult = uris;
    const results = await searchFiles('needle', 'content');
    expect(results).toHaveLength(50);
  });
});

describe('runCommand', () => {
  it('does not execute when the user declines', async () => {
    const approver = makeApprover(false);
    const out = await runCommand('rm -rf /', approver);
    expect(out).toBe('Command was not approved by the user.');
    expect(execMock).not.toHaveBeenCalled();
    expect(approver.calls[0]).toEqual({ title: 'Run command', detail: '$ rm -rf /' });
  });

  it('returns combined stdout and stderr when approved', async () => {
    execMock.mockImplementation((_cmd, _opts, cb) =>
      cb(null, { stdout: 'out', stderr: 'warn' })
    );
    const out = await runCommand('echo hi', makeApprover(true));
    expect(out).toBe('out\n[stderr]\nwarn');
  });

  it('omits the stderr section when there is none', async () => {
    execMock.mockImplementation((_cmd, _opts, cb) =>
      cb(null, { stdout: 'only out', stderr: '' })
    );
    await expect(runCommand('echo hi', makeApprover(true))).resolves.toBe('only out');
  });

  it('reports a friendly message when the command fails', async () => {
    execMock.mockImplementation((_cmd, _opts, cb) =>
      cb(new Error('boom'), { stdout: '', stderr: '' })
    );
    await expect(runCommand('false', makeApprover(true))).resolves.toBe(
      'Command failed: boom'
    );
  });
});

describe('writeFile', () => {
  it('does not write when the user declines', async () => {
    const approver = makeApprover(false);
    const out = await writeFile('new.ts', 'content', approver);
    expect(out).toBe('Write was not approved by the user.');
    expect(__state.files.has('/ws/new.ts')).toBe(false);
  });

  it('writes the file and reports byte length when approved', async () => {
    const out = await writeFile('new.ts', 'hello', makeApprover(true));
    expect(out).toBe('Wrote new.ts (5 bytes).');
    expect(__state.files.get('/ws/new.ts')).toBe('hello');
  });

  it('labels a brand-new file as "(new file)" in the approval preview', async () => {
    const approver = makeApprover(true);
    await writeFile('fresh.ts', 'x', approver);
    expect(approver.calls[0].detail).toContain('--- current ---\n(new file)');
    expect(approver.calls[0].detail).toContain('--- proposed ---\nx');
  });

  it('shows existing contents in the preview when overwriting', async () => {
    __setFile('exists.ts', 'old body');
    const approver = makeApprover(true);
    await writeFile('exists.ts', 'new body', approver);
    expect(approver.calls[0].detail).toContain('--- current ---\nold body');
    expect(approver.calls[0].detail).toContain('--- proposed ---\nnew body');
  });

  it('truncates long previews to keep the prompt small', async () => {
    const approver = makeApprover(true);
    const big = 'a'.repeat(2000);
    await writeFile('big.ts', big, approver);
    expect(approver.calls[0].detail).toContain('…(truncated)');
    // The seeded content is still written in full regardless of preview cap.
    expect(__state.files.get('/ws/big.ts')).toBe(big);
  });
});
