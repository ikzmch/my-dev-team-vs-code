import { describe, it, expect, beforeEach, vi } from 'vitest';

// Only the mirror-forwarding test actually executes a command; give it a
// harmless fake exec instead of a real shell.
const execMock = vi.fn();
vi.mock('child_process', () => ({
  exec: (cmd: string, opts: unknown, cb: Function) => execMock(cmd, opts, cb),
}));

import { registerTools } from '../src/tools/registerTools';
import { Approver } from '../src/core/types';
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
  it('registers all four workspace tools and pushes disposables', () => {
    const context = fakeContext();
    registerTools(context as any, makeApprover(true));

    expect([...__state.registeredTools.keys()]).toEqual([
      'devteam__read',
      'devteam__search',
      'devteam__run',
      'devteam__write',
    ]);
    expect(context.subscriptions).toHaveLength(4);
  });

  it('read tool returns file contents', async () => {
    __setFile('a.ts', 'contents here');
    registerTools(fakeContext() as any, makeApprover(true));
    await expect(invokeTool('devteam__read', { path: 'a.ts' })).resolves.toBe(
      'contents here'
    );
  });

  it('search tool joins matches with newlines', async () => {
    __state.findFilesResult = [
      __setFile('a.ts', 'x'),
      __setFile('b.ts', 'y'),
    ];
    registerTools(fakeContext() as any, makeApprover(true));
    const out = await invokeTool('devteam__search', {
      query: '**/*.ts',
      mode: 'glob',
    });
    expect(out).toBe('a.ts\nb.ts');
  });

  it('search tool reports "(no matches)" when empty', async () => {
    __state.findFilesResult = [];
    registerTools(fakeContext() as any, makeApprover(true));
    const out = await invokeTool('devteam__search', {
      query: '**/*.none',
      mode: 'glob',
    });
    expect(out).toBe('(no matches)');
  });

  it('run tool respects a declining approver', async () => {
    registerTools(fakeContext() as any, makeApprover(false));
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
    registerTools(fakeContext() as any, makeApprover(true), mirror);
    await invokeTool('devteam__run', { command: 'echo hi' });
    expect(entries).toEqual(['begin:echo hi', 'end:(command completed)']);
  });

  it('write tool persists the file without asking for approval', async () => {
    // A declining approver proves the write path never consults it.
    registerTools(fakeContext() as any, makeApprover(false));
    const out = await invokeTool('devteam__write', {
      path: 'out.ts',
      contents: 'hello',
    });
    expect(out).toBe('Wrote out.ts (5 bytes).');
    expect(__state.files.get('/ws/out.ts')).toBe('hello');
  });
});
