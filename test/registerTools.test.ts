import { describe, it, expect, beforeEach, vi } from 'vitest';

// Only the mirror-forwarding test actually executes a command; give it a
// harmless fake exec instead of a real shell.
const execMock = vi.fn();
vi.mock('child_process', () => ({
  exec: (cmd: string, opts: unknown, cb: Function) => execMock(cmd, opts, cb),
}));

import { registerTools } from '../src/tools/registerTools';
import { WorkspaceToolHost } from '../src/tools/toolHost';
import { Approver } from '../src/tools/types';
import { ToolHost } from '../src/protocol/toolContract';
import { __reset, __state, __setFile } from './mocks/vscode';

function makeApprover(verdict: boolean): Approver {
  return { async confirm() { return verdict; } };
}

function fakeContext() {
  return { subscriptions: [] as unknown[] };
}

/** Invoke a registered tool by name and return its first text part. */
async function invokeTool(name: string, input: unknown): Promise<string> {
  const impl = __state.registeredTools.get(name) as {
    invoke(opts: { input: unknown }): Promise<{ content: Array<{ value: string }> }>;
  };
  const result = await impl.invoke({ input });
  return result.content[0].value;
}

beforeEach(() => {
  __reset();
  execMock.mockReset();
});

describe('registerTools', () => {
  it('registers all five workspace tools and pushes disposables', () => {
    const context = fakeContext();
    registerTools(context as any, new WorkspaceToolHost(makeApprover(true)));

    expect([...__state.registeredTools.keys()]).toEqual([
      'devteam__read',
      'devteam__search',
      'devteam__run',
      'devteam__write',
      'devteam__edit',
    ]);
    expect(context.subscriptions).toHaveLength(5);
  });

  it('delegates each registered tool to the shared host with its short name', async () => {
    const calls: Array<{ tool: string; args: unknown }> = [];
    const host: ToolHost = {
      tools: ['read', 'search', 'run', 'write', 'edit'],
      execute: async (tool, args) => {
        calls.push({ tool, args });
        return 'host says hi';
      },
    };
    registerTools(fakeContext() as any, host);

    await expect(invokeTool('devteam__read', { path: 'a.ts' })).resolves.toBe(
      'host says hi'
    );
    await expect(invokeTool('devteam__run', { command: 'echo hi' })).resolves.toBe(
      'host says hi'
    );
    expect(calls).toEqual([
      { tool: 'read', args: { path: 'a.ts' } },
      { tool: 'run', args: { command: 'echo hi' } },
    ]);
  });

  it('read tool returns file contents', async () => {
    __setFile('a.ts', 'contents here');
    registerTools(fakeContext() as any, new WorkspaceToolHost(makeApprover(true)));
    await expect(invokeTool('devteam__read', { path: 'a.ts' })).resolves.toBe(
      'contents here'
    );
  });

  it('search tool joins matches with newlines', async () => {
    __state.findFilesResult = [
      __setFile('a.ts', 'x'),
      __setFile('b.ts', 'y'),
    ];
    registerTools(fakeContext() as any, new WorkspaceToolHost(makeApprover(true)));
    const out = await invokeTool('devteam__search', {
      query: '**/*.ts',
      mode: 'glob',
    });
    expect(out).toBe('a.ts\nb.ts');
  });

  it('search tool reports "(no matches)" when empty', async () => {
    __state.findFilesResult = [];
    registerTools(fakeContext() as any, new WorkspaceToolHost(makeApprover(true)));
    const out = await invokeTool('devteam__search', {
      query: '**/*.none',
      mode: 'glob',
    });
    expect(out).toBe('(no matches)');
  });

  it('run tool respects a declining approver', async () => {
    registerTools(fakeContext() as any, new WorkspaceToolHost(makeApprover(false)));
    const out = await invokeTool('devteam__run', { command: 'echo hi' });
    expect(out).toBe('Command was not approved by the user.');
  });

  it('run tool forwards the shared mirror to runCommand', async () => {
    execMock.mockImplementation((_cmd, _opts, cb) =>
      cb(null, { stdout: 'hi', stderr: '' })
    );
    const entries: string[] = [];
    const mirror = {
      begin: (command: string) => entries.push(`begin:${command}`),
      output: () => {},
      end: (note: string) => entries.push(`end:${note}`),
    };
    registerTools(
      fakeContext() as any,
      new WorkspaceToolHost(makeApprover(true), mirror)
    );
    await invokeTool('devteam__run', { command: 'echo hi' });
    expect(entries).toEqual(['begin:echo hi', 'end:(command completed)']);
  });

  it('write tool persists the file when the approver approves', async () => {
    registerTools(fakeContext() as any, new WorkspaceToolHost(makeApprover(true)));
    const out = await invokeTool('devteam__write', {
      path: 'out.ts',
      contents: 'hello',
    });
    expect(out).toBe('Wrote out.ts (5 bytes).');
    expect(__state.files.get('/ws/out.ts')).toBe('hello');
  });

  it('edit tool replaces the matched text when the approver approves', async () => {
    __setFile('a.ts', 'const a = 1;');
    registerTools(fakeContext() as any, new WorkspaceToolHost(makeApprover(true)));
    const out = await invokeTool('devteam__edit', {
      path: 'a.ts',
      oldText: 'a = 1',
      newText: 'a = 2',
    });
    expect(out).toBe('Edited a.ts (1 replacement).');
    expect(__state.files.get('/ws/a.ts')).toBe('const a = 2;');
  });

  it('edit tool respects a declining approver', async () => {
    __setFile('a.ts', 'const a = 1;');
    registerTools(fakeContext() as any, new WorkspaceToolHost(makeApprover(false)));
    const out = await invokeTool('devteam__edit', {
      path: 'a.ts',
      oldText: 'a = 1',
      newText: 'a = 2',
    });
    expect(out).toBe('Edit was not approved by the user; the file was not changed.');
    expect(__state.files.get('/ws/a.ts')).toBe('const a = 1;');
  });

  it('write tool respects a declining approver', async () => {
    // The editor-wide registration goes through the same gate as the engine's
    // executor loop: a decline leaves the workspace untouched.
    registerTools(fakeContext() as any, new WorkspaceToolHost(makeApprover(false)));
    const out = await invokeTool('devteam__write', {
      path: 'out.ts',
      contents: 'hello',
    });
    expect(out).toBe('Write was not approved by the user; the file was not changed.');
    expect(__state.files.has('/ws/out.ts')).toBe(false);
  });

  it('bridges the invocation cancellation token onto the host abort signal', async () => {
    // The editor passes a CancellationToken per invocation; the registration
    // must turn it into the AbortSignal the host's tools observe, or a
    // cancelled call would run to its timeout.
    let seenSignal: AbortSignal | undefined;
    const host: ToolHost = {
      tools: ['read', 'search', 'run', 'write', 'edit'],
      execute: async (_tool, _args, signal) => {
        seenSignal = signal;
        return 'ok';
      },
    };
    registerTools(fakeContext() as any, host);

    const impl = __state.registeredTools.get('devteam__run') as {
      invoke(opts: { input: unknown }, token?: unknown): Promise<unknown>;
    };
    let fireCancellation: (() => void) | undefined;
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: (listener: () => void) => {
        fireCancellation = listener;
        return { dispose: () => {} };
      },
    };
    await impl.invoke({ input: { command: 'echo hi' } }, token);

    expect(seenSignal).toBeDefined();
    expect(seenSignal!.aborted).toBe(false);
    fireCancellation!();
    expect(seenSignal!.aborted).toBe(true);
  });

  it('passes an already-aborted signal for an already-cancelled token', async () => {
    let seenSignal: AbortSignal | undefined;
    const host: ToolHost = {
      tools: ['read', 'search', 'run', 'write', 'edit'],
      execute: async (_tool, _args, signal) => {
        seenSignal = signal;
        return 'ok';
      },
    };
    registerTools(fakeContext() as any, host);

    const impl = __state.registeredTools.get('devteam__run') as {
      invoke(opts: { input: unknown }, token?: unknown): Promise<unknown>;
    };
    const token = {
      isCancellationRequested: true,
      onCancellationRequested: () => ({ dispose: () => {} }),
    };
    await impl.invoke({ input: { command: 'echo hi' } }, token);
    expect(seenSignal!.aborted).toBe(true);
  });
});
