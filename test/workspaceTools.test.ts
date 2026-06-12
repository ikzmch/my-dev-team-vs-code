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
  editFile,
} from '../src/tools/workspaceTools';
import { Approver, RunMirror } from '../src/tools/types';
import { settings } from '../src/config/settings';
import { environment } from '../src/config/environment';
import {
  __reset,
  __state,
  __setConfig,
  __setFile,
  __setSymlink,
  __setSymlinkDir,
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

  it('rejects a path inside a symlinked directory', async () => {
    // A symlinked *directory* inside the workspace escapes it just like a
    // symlinked file: the final component stats as a plain file, so every
    // ancestor must be checked too.
    __setSymlinkDir('linkdir');
    __setFile('linkdir/secret.txt', 'outside contents');
    await expect(readFile('linkdir/secret.txt')).rejects.toThrow(/symbolic link/);
  });

  it('rejects a deeper path whose middle component is a symlinked directory', async () => {
    __setSymlinkDir('src/linkdir');
    __setFile('src/linkdir/deep/secret.txt', 'outside contents');
    await expect(readFile('src/linkdir/deep/secret.txt')).rejects.toThrow(
      /symbolic link/
    );
  });

  it('truncates contents beyond the character backstop', async () => {
    // One enormous line: the line cap cannot bound it, the char cap must.
    __setFile('big.ts', 'a'.repeat(settings.read.maxChars + 10));
    const text = await readFile('big.ts');
    expect(text).toContain('…(truncated)');
    expect(text.length).toBeLessThan(settings.read.maxChars + 100);
  });

  it('returns a whole small file verbatim, trailing newline included', async () => {
    __setFile('a.ts', 'one\ntwo\n');
    await expect(readFile('a.ts')).resolves.toBe('one\ntwo\n');
  });
});

describe('readFile (line ranges)', () => {
  /** A file of `count` numbered lines: "line 1" .. "line N", newline-terminated. */
  function numberedLines(count: number): string {
    return Array.from({ length: count }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
  }

  it('returns a requested range with a header naming range, total, and next line', async () => {
    __setFile('f.ts', numberedLines(10));
    await expect(readFile('f.ts', 3, 5)).resolves.toBe(
      '(lines 3-5 of 10; continue with startLine 6)\nline 3\nline 4\nline 5'
    );
  });

  it('omits the continue hint when the range reaches the end of the file', async () => {
    __setFile('f.ts', numberedLines(10));
    await expect(readFile('f.ts', 9, 99)).resolves.toBe(
      '(lines 9-10 of 10)\nline 9\nline 10'
    );
  });

  it('starts from line 1 when only endLine is given', async () => {
    __setFile('f.ts', numberedLines(5));
    await expect(readFile('f.ts', undefined, 2)).resolves.toBe(
      '(lines 1-2 of 5; continue with startLine 3)\nline 1\nline 2'
    );
  });

  it('caps an unbounded read at the per-call line limit', async () => {
    const cap = settings.read.maxLines;
    __setFile('f.ts', numberedLines(cap + 50));
    const text = await readFile('f.ts');
    expect(text).toContain(
      `(lines 1-${cap} of ${cap + 50}; continue with startLine ${cap + 1})`
    );
    expect(text).toContain(`line ${cap}`);
    expect(text).not.toContain(`line ${cap + 1}\n`);
  });

  it('caps an explicit range wider than the per-call line limit', async () => {
    const cap = settings.read.maxLines;
    __setFile('f.ts', numberedLines(cap + 50));
    const text = await readFile('f.ts', 2, cap + 20);
    expect(text).toContain(
      `(lines 2-${cap + 1} of ${cap + 50}; continue with startLine ${cap + 2})`
    );
  });

  it('does not count a trailing newline as a line of its own', async () => {
    // wc -l style: the count must match what a line-count command reports, or
    // the model's pre-counted ranges would be off by one.
    __setFile('f.ts', 'a\nb\n');
    await expect(readFile('f.ts', 1, 1)).resolves.toBe(
      '(lines 1-1 of 2; continue with startLine 2)\na'
    );
  });

  it('reports a startLine past the end instead of returning nothing', async () => {
    __setFile('f.ts', numberedLines(3));
    await expect(readFile('f.ts', 7)).resolves.toBe(
      'f.ts has only 3 lines; startLine 7 is past the end of the file.'
    );
  });

  it('reports an endLine before startLine with a recovery instruction', async () => {
    __setFile('f.ts', numberedLines(10));
    const out = await readFile('f.ts', 5, 2);
    expect(out).toContain('endLine 2 is before startLine 5');
    expect(out).toMatch(/at or after startLine/);
  });

  it('returns a range covering the whole file without a header', async () => {
    __setFile('f.ts', 'one\ntwo\n');
    await expect(readFile('f.ts', 1, 2)).resolves.toBe('one\ntwo\n');
  });

  it('reads the per-call line limit live from the user settings', async () => {
    __setConfig('myDevTeam.read.maxLines', 2);
    __setFile('f.ts', numberedLines(5));
    await expect(readFile('f.ts')).resolves.toBe(
      '(lines 1-2 of 5; continue with startLine 3)\nline 1\nline 2'
    );
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

  it('detaches the child off Windows so the whole process group can be killed', async () => {
    execMock.mockImplementation((_cmd, _opts, cb) =>
      cb(null, { stdout: '', stderr: '' })
    );
    await runCommand('echo hi', makeApprover(true));
    const opts = execMock.mock.calls[0][1] as { detached?: boolean };
    expect(opts.detached).toBe(process.platform !== 'win32');
  });

  it('kills the whole process group on POSIX platforms when aborted', async () => {
    // Signalling only the shell child would orphan its grandchildren; the
    // negative pid takes down the group the detached child leads.
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', {
      value: 'linux',
      configurable: true,
    });
    const killSpy = vi
      .spyOn(process, 'kill')
      .mockImplementation(() => true as unknown as true);
    const controller = new AbortController();
    execMock.mockImplementation((_cmd, _opts, cb) => {
      childRef.current.pid = 4242;
      queueMicrotask(() => {
        controller.abort();
        cb(new Error('killed'));
      });
    });
    try {
      const out = await runCommand(
        'sleep 100',
        makeApprover(true),
        undefined,
        controller.signal
      );
      expect(out).toBe('Command was cancelled and the process was killed.');
      expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGKILL');
    } finally {
      Object.defineProperty(process, 'platform', originalPlatform);
      killSpy.mockRestore();
    }
  });

  it('caps the model-facing output of a chatty command, keeping head and tail', async () => {
    const cap = settings.runResultMaxChars;
    const big = 'HEAD' + 'x'.repeat(cap) + 'TAIL';
    execMock.mockImplementation((_cmd, _opts, cb) =>
      cb(null, { stdout: big, stderr: '' })
    );
    const out = await runCommand('npm test', makeApprover(true));
    expect(out.length).toBeLessThan(cap + 100);
    expect(out).toContain('…(output truncated)…');
    expect(out.startsWith('HEAD')).toBe(true);
    expect(out.endsWith('TAIL')).toBe(true);
  });

  it('caps the output attached to a failed command too', async () => {
    const cap = settings.runResultMaxChars;
    const err = Object.assign(new Error('Command failed: npm test'), {
      stdout: 'x'.repeat(cap + 1_000),
      stderr: 'the final assertion',
    });
    execMock.mockImplementation((_cmd, _opts, cb) => cb(err, undefined));
    const out = await runCommand('npm test', makeApprover(true));
    expect(out.length).toBeLessThan(cap + 200);
    expect(out).toContain('Command failed: npm test');
    expect(out).toContain('…(output truncated)…');
    // The tail (where the failure usually prints) survives the cap.
    expect(out).toContain('the final assertion');
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
  it('writes the file and reports byte length when approved', async () => {
    const out = await writeFile('new.ts', 'hello', makeApprover(true));
    expect(out).toBe('Wrote new.ts (5 bytes).');
    expect(__state.files.get('/ws/new.ts')).toBe('hello');
  });

  it('asks the approver with the path and the pending contents', async () => {
    const approver = makeApprover(true);
    await writeFile('src/new.ts', 'const a = 1;', approver);
    expect(approver.calls).toEqual([
      { title: 'Write file', detail: 'src/new.ts\n\nconst a = 1;' },
    ]);
  });

  it('does not write when the user declines', async () => {
    const approver = makeApprover(false);
    const out = await writeFile('new.ts', 'hello', approver);
    expect(out).toBe('Write was not approved by the user; the file was not changed.');
    expect(__state.files.has('/ws/new.ts')).toBe(false);
    expect(approver.calls).toHaveLength(1);
  });

  it('keeps the old contents when an overwrite is declined', async () => {
    __setFile('exists.ts', 'old body');
    await writeFile('exists.ts', 'new body', makeApprover(false));
    expect(__state.files.get('/ws/exists.ts')).toBe('old body');
  });

  it('truncates the approval preview but writes the full contents', async () => {
    const big = 'a'.repeat(settings.writeApprovalPreviewMaxChars + 10);
    const approver = makeApprover(true);
    await writeFile('big.ts', big, approver);

    const detail = approver.calls[0].detail;
    expect(detail).toContain('…(truncated)');
    expect(detail.length).toBeLessThan(
      settings.writeApprovalPreviewMaxChars + 100
    );
    // The cap bounds only the preview; the file itself lands complete.
    expect(__state.files.get('/ws/big.ts')).toBe(big);
  });

  it('shows the complete contents in the preview when under the cap', async () => {
    const approver = makeApprover(true);
    await writeFile('small.ts', 'short body', approver);
    expect(approver.calls[0].detail).toBe('small.ts\n\nshort body');
    expect(approver.calls[0].detail).not.toContain('truncated');
  });

  it('reports utf8 bytes, not characters, for multi-byte content', async () => {
    // "héllo" is 5 characters but 6 utf8 bytes.
    const out = await writeFile('uni.ts', 'héllo', makeApprover(true));
    expect(out).toBe('Wrote uni.ts (6 bytes).');
  });

  it('overwrites an existing file with the new contents when approved', async () => {
    __setFile('exists.ts', 'old body');
    await writeFile('exists.ts', 'new body', makeApprover(true));
    expect(__state.files.get('/ws/exists.ts')).toBe('new body');
  });

  it('rejects a traversal path before consulting the approver', async () => {
    const approver = makeApprover(true);
    await expect(writeFile('../evil.ts', 'x', approver)).rejects.toThrow(
      /outside the workspace/
    );
    expect([...__state.files.keys()].some((k) => k.includes('evil'))).toBe(false);
    expect(approver.calls).toHaveLength(0);
  });

  it('rejects writing through a symbolic link before consulting the approver', async () => {
    __setSymlink('link.ts', 'old');
    const approver = makeApprover(true);
    await expect(writeFile('link.ts', 'new', approver)).rejects.toThrow(
      /symbolic link/
    );
    expect(__state.files.get('/ws/link.ts')).toBe('old');
    expect(approver.calls).toHaveLength(0);
  });

  it('rejects writing into a symlinked directory before consulting the approver', async () => {
    // The write target itself does not exist yet, but its parent is a link
    // pointing who-knows-where; the ancestor check must catch it.
    __setSymlinkDir('linkdir');
    const approver = makeApprover(true);
    await expect(writeFile('linkdir/new.ts', 'x', approver)).rejects.toThrow(
      /symbolic link/
    );
    expect(__state.files.has('/ws/linkdir/new.ts')).toBe(false);
    expect(approver.calls).toHaveLength(0);
  });

  it('does not write or prompt when the request was already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const approver = makeApprover(true);
    const out = await writeFile('new.ts', 'hello', approver, controller.signal);
    expect(out).toBe('Write was cancelled; the file was not changed.');
    expect(__state.files.has('/ws/new.ts')).toBe(false);
    expect(approver.calls).toHaveLength(0);
  });

  it('does not write when the request is cancelled while the prompt is open', async () => {
    // The user may approve a write whose request was cancelled while the
    // buttons were showing; the approval must not resurrect the side effect.
    const controller = new AbortController();
    const approver: Approver = {
      async confirm() {
        controller.abort();
        return true;
      },
    };
    const out = await writeFile('new.ts', 'hello', approver, controller.signal);
    expect(out).toBe('Write was cancelled; the file was not changed.');
    expect(__state.files.has('/ws/new.ts')).toBe(false);
  });
});

describe('editFile', () => {
  it('replaces a unique match and reports the edit when approved', async () => {
    __setFile('a.ts', 'const a = 1;\nconst b = 2;\n');
    const out = await editFile('a.ts', 'const a = 1;', 'const a = 42;', makeApprover(true));
    expect(out).toBe('Edited a.ts (1 replacement).');
    expect(__state.files.get('/ws/a.ts')).toBe('const a = 42;\nconst b = 2;\n');
  });

  it('asks the approver with the path above a diff-style old/new pair', async () => {
    __setFile('a.ts', 'line one\nline two\n');
    const approver = makeApprover(true);
    await editFile('a.ts', 'line one', 'line 1', approver);
    expect(approver.calls).toEqual([
      { title: 'Edit file', detail: 'a.ts\n\n- line one\n+ line 1' },
    ]);
  });

  it('does not interpret $-patterns in the replacement text', async () => {
    // String.replace treats $& and friends as substitutions; model-written
    // code legitimately contains them (regex, shell, templates).
    __setFile('a.ts', 'const re = OLD;');
    await editFile('a.ts', 'OLD', "'$&-$1'", makeApprover(true));
    expect(__state.files.get('/ws/a.ts')).toBe("const re = '$&-$1';");
  });

  it('refuses a missing file and points the model at the write tool', async () => {
    const approver = makeApprover(true);
    const out = await editFile('ghost.ts', 'old', 'new', approver);
    expect(out).toBe('File does not exist: ghost.ts. Use the write tool to create a new file.');
    expect(approver.calls).toHaveLength(0);
  });

  it('reports a missing match with an instruction to re-read the file', async () => {
    __setFile('a.ts', 'const a = 1;');
    const approver = makeApprover(true);
    const out = await editFile('a.ts', 'const b = 2;', 'x', approver);
    expect(out).toMatch(/not found in a\.ts/);
    expect(out).toMatch(/read the file/i);
    expect(__state.files.get('/ws/a.ts')).toBe('const a = 1;');
    expect(approver.calls).toHaveLength(0);
  });

  it('reports an ambiguous match with the count and asks for more context', async () => {
    __setFile('a.ts', 'let x = 0;\nlet x = 0;\nlet x = 0;');
    const approver = makeApprover(true);
    const out = await editFile('a.ts', 'let x = 0;', 'let y = 0;', approver);
    expect(out).toContain('matches 3 places in a.ts');
    expect(out).toMatch(/surrounding/);
    expect(__state.files.get('/ws/a.ts')).toBe('let x = 0;\nlet x = 0;\nlet x = 0;');
    expect(approver.calls).toHaveLength(0);
  });

  it('rejects an edit whose oldText and newText are identical', async () => {
    __setFile('a.ts', 'const a = 1;');
    const out = await editFile('a.ts', 'const a = 1;', 'const a = 1;', makeApprover(true));
    expect(out).toMatch(/identical/);
    expect(__state.files.get('/ws/a.ts')).toBe('const a = 1;');
  });

  it('matches an LF snippet against a CRLF file without rewriting its line endings', async () => {
    // Models usually emit LF; files on Windows are often CRLF. The snippet is
    // adapted to the file, so the match succeeds and the untouched parts of
    // the file keep their endings.
    __setFile('a.ts', 'one\r\ntwo\r\nthree\r\n');
    const out = await editFile('a.ts', 'one\ntwo', 'uno\ndos', makeApprover(true));
    expect(out).toBe('Edited a.ts (1 replacement).');
    expect(__state.files.get('/ws/a.ts')).toBe('uno\r\ndos\r\nthree\r\n');
  });

  it('matches a CRLF snippet against an LF file', async () => {
    __setFile('a.ts', 'one\ntwo\nthree\n');
    await editFile('a.ts', 'one\r\ntwo', 'uno\r\ndos', makeApprover(true));
    expect(__state.files.get('/ws/a.ts')).toBe('uno\ndos\nthree\n');
  });

  it('caps each side of the approval preview but applies the full edit', async () => {
    const oldBig = 'a'.repeat(settings.writeApprovalPreviewMaxChars + 10);
    const newBig = 'b'.repeat(settings.writeApprovalPreviewMaxChars + 10);
    __setFile('big.ts', `start ${oldBig} end`);
    const approver = makeApprover(true);
    await editFile('big.ts', oldBig, newBig, approver);

    const detail = approver.calls[0].detail;
    expect(detail).toContain('…(truncated)');
    expect(detail.length).toBeLessThan(2 * settings.writeApprovalPreviewMaxChars + 200);
    // The cap bounds only the preview; the file gets the complete replacement.
    expect(__state.files.get('/ws/big.ts')).toBe(`start ${newBig} end`);
  });

  it('does not edit when the user declines', async () => {
    __setFile('a.ts', 'const a = 1;');
    const out = await editFile('a.ts', '1', '2', makeApprover(false));
    expect(out).toBe('Edit was not approved by the user; the file was not changed.');
    expect(__state.files.get('/ws/a.ts')).toBe('const a = 1;');
  });

  it('rejects a traversal path before reading or consulting the approver', async () => {
    const approver = makeApprover(true);
    await expect(editFile('../evil.ts', 'a', 'b', approver)).rejects.toThrow(
      /outside the workspace/
    );
    expect(approver.calls).toHaveLength(0);
  });

  it('rejects editing through a symbolic link before consulting the approver', async () => {
    __setSymlink('link.ts', 'old');
    const approver = makeApprover(true);
    await expect(editFile('link.ts', 'old', 'new', approver)).rejects.toThrow(
      /symbolic link/
    );
    expect(__state.files.get('/ws/link.ts')).toBe('old');
    expect(approver.calls).toHaveLength(0);
  });

  it('does not edit or prompt when the request was already cancelled', async () => {
    __setFile('a.ts', 'const a = 1;');
    const controller = new AbortController();
    controller.abort();
    const approver = makeApprover(true);
    const out = await editFile('a.ts', '1', '2', approver, controller.signal);
    expect(out).toBe('Edit was cancelled; the file was not changed.');
    expect(__state.files.get('/ws/a.ts')).toBe('const a = 1;');
    expect(approver.calls).toHaveLength(0);
  });

  it('does not edit when the request is cancelled while the prompt is open', async () => {
    __setFile('a.ts', 'const a = 1;');
    const controller = new AbortController();
    const approver: Approver = {
      async confirm() {
        controller.abort();
        return true;
      },
    };
    const out = await editFile('a.ts', '1', '2', approver, controller.signal);
    expect(out).toBe('Edit was cancelled; the file was not changed.');
    expect(__state.files.get('/ws/a.ts')).toBe('const a = 1;');
  });

  it('does not clobber a file whose match vanished while the prompt was open', async () => {
    // The approval prompt can stay open for a while; applying the snapshot
    // taken before it would silently revert whatever changed the file since.
    __setFile('a.ts', 'const a = 1;');
    const approver: Approver = {
      async confirm() {
        __setFile('a.ts', 'const b = 2;'); // changed while the buttons showed
        return true;
      },
    };
    const out = await editFile('a.ts', 'const a = 1;', 'const a = 42;', approver);
    expect(out).toMatch(/not found in a\.ts/);
    expect(__state.files.get('/ws/a.ts')).toBe('const b = 2;');
  });

  it('applies the edit to the fresh contents when the match survives a concurrent change', async () => {
    __setFile('a.ts', 'header\nconst a = 1;\n');
    const approver: Approver = {
      async confirm() {
        __setFile('a.ts', 'edited header\nconst a = 1;\n');
        return true;
      },
    };
    const out = await editFile('a.ts', 'const a = 1;', 'const a = 42;', approver);
    expect(out).toBe('Edited a.ts (1 replacement).');
    // Both the concurrent change and the approved edit land.
    expect(__state.files.get('/ws/a.ts')).toBe('edited header\nconst a = 42;\n');
  });

  it('reports a file deleted while the prompt was open instead of recreating it', async () => {
    __setFile('a.ts', 'const a = 1;');
    const approver: Approver = {
      async confirm() {
        __state.files.delete('/ws/a.ts');
        return true;
      },
    };
    const out = await editFile('a.ts', 'const a = 1;', 'const a = 2;', approver);
    expect(out).toMatch(/does not exist/);
    expect(__state.files.has('/ws/a.ts')).toBe(false);
  });

  it('rejects editing through a symlinked directory before consulting the approver', async () => {
    __setSymlinkDir('linkdir');
    __setFile('linkdir/a.ts', 'const a = 1;');
    const approver = makeApprover(true);
    await expect(editFile('linkdir/a.ts', '1', '2', approver)).rejects.toThrow(
      /symbolic link/
    );
    expect(__state.files.get('/ws/linkdir/a.ts')).toBe('const a = 1;');
    expect(approver.calls).toHaveLength(0);
  });
});
