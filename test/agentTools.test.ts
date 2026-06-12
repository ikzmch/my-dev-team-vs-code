import { describe, it, expect, beforeEach, vi } from 'vitest';

// child_process.exec is invoked through util.promisify inside runCommand.
// We replace it with a controllable fake before importing the module under test.
const execMock = vi.fn();
vi.mock('child_process', () => ({
  exec: (cmd: string, opts: unknown, cb: Function) => execMock(cmd, opts, cb),
}));

import { buildAgentTools } from '../src/tools/agentTools';
import { toolConfigs } from '../src/config/tools';
import { Approver } from '../src/core/types';
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

/** Run a Mastra tool's execute with the minimal context the wrapper needs. */
function invoke(tool: { execute?: Function }, input: unknown): Promise<unknown> {
  return tool.execute!(input, {});
}

beforeEach(() => {
  __reset();
  execMock.mockReset();
});

describe('buildAgentTools', () => {
  it('exposes the four workspace tools under their config names', () => {
    const tools = buildAgentTools(makeApprover(true));
    expect(Object.keys(tools).sort()).toEqual(['read', 'run', 'search', 'write']);
    for (const [name, tool] of Object.entries(tools)) {
      expect(tool.id).toBe(toolConfigs[name].name);
      expect(tool.description).toBe(toolConfigs[name].description);
      expect(tool.inputSchema).toBeDefined();
    }
  });

  it('read returns the file text', async () => {
    __setFile('src/a.ts', 'const a = 1;');
    const tools = buildAgentTools(makeApprover(true));
    await expect(invoke(tools.read, { path: 'src/a.ts' })).resolves.toBe(
      'const a = 1;'
    );
  });

  it('read rejects a path outside the workspace', async () => {
    const tools = buildAgentTools(makeApprover(true));
    await expect(invoke(tools.read, { path: '../etc/passwd' })).rejects.toThrow(
      /outside the workspace/
    );
  });

  it('search joins matches with newlines', async () => {
    const a = __setFile('src/a.ts', 'x');
    const b = __setFile('src/b.ts', 'x');
    __state.findFilesResult = [a, b];
    const tools = buildAgentTools(makeApprover(true));
    await expect(invoke(tools.search, { query: '**/*.ts', mode: 'glob' })).resolves.toBe(
      'src/a.ts\nsrc/b.ts'
    );
  });

  it('search reports no matches instead of returning an empty string', async () => {
    __state.findFilesResult = [];
    const tools = buildAgentTools(makeApprover(true));
    await expect(invoke(tools.search, { query: '**/*.go', mode: 'glob' })).resolves.toBe(
      '(no matches)'
    );
  });

  it('run executes through the given approver and returns the output', async () => {
    execMock.mockImplementation((_cmd, _opts, cb) =>
      cb(null, { stdout: 'hi', stderr: '' })
    );
    const approver = makeApprover(true);
    const tools = buildAgentTools(approver);

    await expect(invoke(tools.run, { command: 'echo hi' })).resolves.toBe('hi');
    expect(approver.calls[0]).toEqual({ title: 'Run command', detail: '$ echo hi' });
  });

  it('run does not execute when the approver declines', async () => {
    const tools = buildAgentTools(makeApprover(false));
    await expect(invoke(tools.run, { command: 'rm -rf /' })).resolves.toBe(
      'Command was not approved by the user.'
    );
    expect(execMock).not.toHaveBeenCalled();
  });

  it('write creates the file without consulting the approver', async () => {
    const approver = makeApprover(true);
    const tools = buildAgentTools(approver);

    const result = await invoke(tools.write, { path: 'src/new.ts', contents: 'x = 1' });
    expect(result).toContain('Wrote src/new.ts');
    expect(__state.files.get('/ws/src/new.ts')).toBe('x = 1');
    expect(approver.calls).toHaveLength(0);
  });

  it('validates tool input against the schema instead of calling through', async () => {
    const tools = buildAgentTools(makeApprover(true));
    // Mastra's createTool wraps execute with input validation: a call with a
    // missing required field resolves to a ValidationError, and the
    // underlying workspace tool (which would throw ENOENT here) never runs.
    const result = (await invoke(tools.read, {})) as { error?: boolean };
    expect(result).toMatchObject({ error: true });
  });
});
