import { describe, it, expect, beforeEach, vi } from 'vitest';

// child_process.exec is invoked through util.promisify inside runCommand.
// We replace it with a controllable fake before importing the module under
// test. The fake carries promisify's custom symbol so the promisified call
// exposes a `.child` with live stdout/stderr emitters, like the real exec -
// that is the surface the run mirror taps. `childRef.current` is the child
// of the most recent call, for tests that emit stream data.
const { execMock, childRef } = vi.hoisted(() => ({
  execMock: vi.fn(),
  childRef: { current: undefined as any },
}));
vi.mock('child_process', async () => {
  const { EventEmitter } = await import('events');
  const exec = (cmd: string, opts: unknown, cb: Function) => execMock(cmd, opts, cb);
  (exec as any)[Symbol.for('nodejs.util.promisify.custom')] = (
    cmd: string,
    opts: unknown
  ) => {
    const child = { stdout: new EventEmitter(), stderr: new EventEmitter() };
    childRef.current = child;
    let settle!: (err: unknown, value?: unknown) => void;
    const promise = new Promise((resolve, reject) => {
      settle = (err, value) => (err ? reject(err) : resolve(value));
    }) as Promise<unknown> & { child: unknown };
    promise.child = child;
    execMock(cmd, opts, settle);
    return promise;
  };
  return { exec };
});

import {
  readFile,
  searchFiles,
  runCommand,
  writeFile,
} from '../src/tools/workspaceTools';
import { Approver, RunMirror } from '../src/tools/types';
import { settings } from '../src/config/settings';
import { environment } from '../src/config/environment';
import {
  __reset,
  __state,
  __setFile,
  __setSymlink,
  Uri,
  workspace,
} from './mocks/vscode';

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

  it('rejects a path that traverses out of the workspace', async () => {
    await expect(readFile('../secret.txt')).rejects.toThrow(/outside the workspace/);
    await expect(readFile('src/../../secret.txt')).rejects.toThrow(
      /outside the workspace/
    );
  });

  it('rejects an absolute path', async () => {
    await expect(readFile('/etc/passwd')).rejects.toThrow(/outside the workspace/);
  });

  it('allows .. segments that stay inside the workspace', async () => {
    __setFile('a.ts', 'still inside');
    await expect(readFile('src/../a.ts')).resolves.toBe('still inside');
  });

  it('rejects a path that resolves to a symbolic link', async () => {
    // A link living inside the workspace can still point outside it; following
    // it would let read exfiltrate the target.
    __setSymlink('link.ts', 'contents of the link target');
    await expect(readFile('link.ts')).rejects.toThrow(/symbolic link/);
  });

  it('truncates contents beyond the read cap', async () => {
    __setFile('big.ts', 'a'.repeat(settings.readMaxChars + 10));
    const text = await readFile('big.ts');
    expect(text).toContain('…(truncated)');
    expect(text.length).toBeLessThan(settings.readMaxChars + 100);
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

  it('always excludes the configured noise folders', async () => {
    __state.findFilesResult = [];
    await searchFiles('**/*.ts', 'glob');
    await searchFiles('needle', 'content');
    for (const call of workspace.findFiles.mock.calls) {
      expect(call[1]).toBe(settings.search.excludeGlob);
    }
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

  it('skips binary files instead of matching inside them', async () => {
    const text = __setFile('a.ts', 'has needle');
    const binary = __setFile('blob.bin', 'needle\0with a NUL byte');
    __state.findFilesResult = [text, binary];
    await expect(searchFiles('needle', 'content')).resolves.toEqual(['a.ts']);
  });

  it('skips files larger than the content-search size cap', async () => {
    const small = __setFile('small.ts', 'needle');
    const huge = __setFile(
      'huge.ts',
      'needle' + 'a'.repeat(settings.search.maxFileSizeBytes)
    );
    __state.findFilesResult = [small, huge];
    await expect(searchFiles('needle', 'content')).resolves.toEqual(['small.ts']);
  });

  it('checks an oversized file via stat without ever reading it', async () => {
    // The size cap must bound memory, not only the result set: a file over the
    // cap is rejected by its stat size and never pulled into memory.
    const small = __setFile('small.ts', 'needle');
    const huge = __setFile(
      'huge.ts',
      'needle' + 'a'.repeat(settings.search.maxFileSizeBytes)
    );
    __state.findFilesResult = [small, huge];
    workspace.fs.readFile.mockClear();

    await searchFiles('needle', 'content');

    const readPaths = workspace.fs.readFile.mock.calls.map((c) => (c[0] as Uri).path);
    expect(readPaths).toContain(small.path);
    expect(readPaths).not.toContain(huge.path);
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

  it('includes the output a failed command produced before exiting', async () => {
    // The real exec attaches the collected stdout/stderr to the error.
    const err = Object.assign(new Error('Command failed: npm test'), {
      stdout: '1 test failed',
      stderr: 'AssertionError',
    });
    execMock.mockImplementation((_cmd, _opts, cb) => cb(err, undefined));
    const out = await runCommand('npm test', makeApprover(true));
    expect(out).toContain('Command failed: npm test');
    expect(out).toContain('1 test failed');
    expect(out).toContain('[stderr]\nAssertionError');
  });

  it('runs in the workspace root with the configured output buffer', async () => {
    execMock.mockImplementation((_cmd, _opts, cb) =>
      cb(null, { stdout: '', stderr: '' })
    );
    await runCommand('echo hi', makeApprover(true));
    const opts = execMock.mock.calls[0][1] as { cwd: string; maxBuffer: number };
    expect(opts.cwd).toBe('/ws');
    expect(opts.maxBuffer).toBe(settings.runCommandMaxBufferBytes);
  });

  it('does not start a process when the request is already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const out = await runCommand(
      'echo hi',
      makeApprover(true),
      undefined,
      controller.signal
    );
    expect(out).toBe('Command was cancelled before running.');
    expect(execMock).not.toHaveBeenCalled();
  });

  it('kills the process and reports cancellation when aborted mid-run', async () => {
    const controller = new AbortController();
    execMock.mockImplementation((_cmd, _opts, cb) => {
      // Abort while the process is "running", then settle as a killed process
      // would (the kill-tree itself is a no-op on the pid-less test child).
      queueMicrotask(() => {
        controller.abort();
        cb(new Error('killed'));
      });
    });
    const out = await runCommand(
      'sleep 100',
      makeApprover(true),
      undefined,
      controller.signal
    );
    expect(out).toBe('Command was cancelled and the process was killed.');
  });

  it('spawns the shell the environment config announces to the model', async () => {
    // The prompts tell the model its commands run in environment.shell
    // (PowerShell on Windows); the exec call must honour that, not the
    // platform default cmd.exe.
    execMock.mockImplementation((_cmd, _opts, cb) =>
      cb(null, { stdout: '', stderr: '' })
    );
    await runCommand('echo hi', makeApprover(true));
    const opts = execMock.mock.calls[0][1] as { shell?: string };
    expect(opts.shell).toBe(environment.execShell);
  });
});

describe('runCommand mirroring', () => {
  /** RunMirror test double recording the lifecycle as ordered entries. */
  function makeMirror(): RunMirror & { entries: string[] } {
    const entries: string[] = [];
    return {
      entries,
      begin: (command) => entries.push(`begin:${command}`),
      output: (chunk) => entries.push(`output:${chunk}`),
      end: (note) => entries.push(`end:${note}`),
    };
  }

  it('streams the lifecycle and live output of a successful command', async () => {
    execMock.mockImplementation((_cmd, _opts, cb) => {
      // Emit asynchronously, as a real process would: runCommand must have
      // attached its stream taps by then.
      queueMicrotask(() => {
        childRef.current.stdout.emit('data', 'building...\n');
        childRef.current.stderr.emit('data', 'warn: legacy');
        cb(null, { stdout: 'building...\n', stderr: 'warn: legacy' });
      });
    });
    const mirror = makeMirror();
    const out = await runCommand('npm run build', makeApprover(true), mirror);

    expect(mirror.entries).toEqual([
      'begin:npm run build',
      'output:building...\n',
      'output:warn: legacy',
      'end:(command completed)',
    ]);
    // The buffered result for the model is unchanged by the mirroring.
    expect(out).toBe('building...\n\n[stderr]\nwarn: legacy');
  });

  it('ends the mirror with the failure reason when the command fails', async () => {
    execMock.mockImplementation((_cmd, _opts, cb) => {
      queueMicrotask(() => cb(new Error('boom')));
    });
    const mirror = makeMirror();
    await runCommand('false', makeApprover(true), mirror);
    expect(mirror.entries).toEqual(['begin:false', 'end:Command failed: boom']);
  });

  it('never reaches the mirror when the user declines', async () => {
    const mirror = makeMirror();
    await runCommand('echo hi', makeApprover(false), mirror);
    expect(mirror.entries).toEqual([]);
    expect(execMock).not.toHaveBeenCalled();
  });
});

describe('writeFile', () => {
  it('writes the file and reports byte length', async () => {
    const out = await writeFile('new.ts', 'hello');
    expect(out).toBe('Wrote new.ts (5 bytes).');
    expect(__state.files.get('/ws/new.ts')).toBe('hello');
  });

  it('reports utf8 bytes, not characters, for multi-byte content', async () => {
    // "héllo" is 5 characters but 6 utf8 bytes.
    const out = await writeFile('uni.ts', 'héllo');
    expect(out).toBe('Wrote uni.ts (6 bytes).');
  });

  it('overwrites an existing file with the new contents', async () => {
    __setFile('exists.ts', 'old body');
    await writeFile('exists.ts', 'new body');
    expect(__state.files.get('/ws/exists.ts')).toBe('new body');
  });

  it('rejects a traversal path without writing', async () => {
    await expect(writeFile('../evil.ts', 'x')).rejects.toThrow(
      /outside the workspace/
    );
    expect([...__state.files.keys()].some((k) => k.includes('evil'))).toBe(false);
  });

  it('rejects writing through a symbolic link', async () => {
    __setSymlink('link.ts', 'old');
    await expect(writeFile('link.ts', 'new')).rejects.toThrow(/symbolic link/);
    expect(__state.files.get('/ws/link.ts')).toBe('old');
  });

  it('does not write when the request was cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const out = await writeFile('new.ts', 'hello', controller.signal);
    expect(out).toBe('Write was cancelled; the file was not changed.');
    expect(__state.files.has('/ws/new.ts')).toBe(false);
  });
});
