import { describe, it, expect } from 'vitest';

import { buildAgentTools } from '../src/engine/core/agentTools';
import { toolConfigs } from '../src/engine/config/tools';
import { ToolHost } from '../src/protocol/toolContract';

/** ToolHost test double recording calls and returning a fixed result. */
function makeHost(result = 'ok'): ToolHost & {
  calls: Array<{ tool: string; args: unknown; signal?: AbortSignal }>;
} {
  const calls: Array<{ tool: string; args: unknown; signal?: AbortSignal }> = [];
  return {
    calls,
    tools: ['read', 'search', 'run', 'write', 'edit'],
    execute: async (tool, args, signal) => {
      calls.push({ tool, args, signal });
      return result;
    },
  };
}

/** Run a Mastra tool's execute with the minimal context the wrapper needs. */
function invoke(tool: { execute?: Function }, input: unknown): Promise<unknown> {
  return tool.execute!(input, {});
}

describe('buildAgentTools', () => {
  it('exposes the five workspace tools plus the engine-only progress tool', () => {
    const tools = buildAgentTools(makeHost());
    expect(Object.keys(tools).sort()).toEqual([
      'edit',
      'progress',
      'read',
      'run',
      'search',
      'write',
    ]);
    for (const [name, tool] of Object.entries(tools)) {
      expect(tool.id).toBe(toolConfigs[name].name);
      expect(tool.description).toBe(toolConfigs[name].description);
      expect(tool.inputSchema).toBeDefined();
    }
  });

  it('builds progress as a local tool that acknowledges without a host call', async () => {
    const host = makeHost();
    const tools = buildAgentTools(host);
    const result = await invoke(tools.progress, {
      items: [{ step: 1, status: 'done' }],
    });
    expect(result).toBe('Progress shown to the user.');
    // The progress tool never delegates to the ToolHost.
    expect(host.calls).toHaveLength(0);
  });

  it('delegates each call to the ToolHost with the tool name and args', async () => {
    const host = makeHost('the result');
    const tools = buildAgentTools(host);

    await expect(invoke(tools.read, { path: 'src/a.ts' })).resolves.toBe('the result');
    await expect(
      invoke(tools.search, { query: '**/*.ts', mode: 'glob' })
    ).resolves.toBe('the result');
    await expect(invoke(tools.run, { command: 'echo hi' })).resolves.toBe('the result');
    await expect(
      invoke(tools.write, { path: 'a.ts', contents: 'x' })
    ).resolves.toBe('the result');
    await expect(
      invoke(tools.edit, { path: 'a.ts', oldText: 'x', newText: 'y' })
    ).resolves.toBe('the result');

    expect(host.calls.map((c) => c.tool)).toEqual([
      'read',
      'search',
      'run',
      'write',
      'edit',
    ]);
    expect(host.calls[0].args).toMatchObject({ path: 'src/a.ts' });
    expect(host.calls[2].args).toMatchObject({ command: 'echo hi' });
  });

  it('passes the current signal through to the host on every call', async () => {
    const controller = new AbortController();
    const host = makeHost();
    const tools = buildAgentTools(host, () => controller.signal);

    await invoke(tools.run, { command: 'echo hi' });
    await invoke(tools.write, { path: 'a.ts', contents: 'x' });

    expect(host.calls.every((c) => c.signal === controller.signal)).toBe(true);
  });

  it('reads the signal getter per call, not at build time', async () => {
    let signal: AbortSignal | undefined;
    const host = makeHost();
    const tools = buildAgentTools(host, () => signal);

    await invoke(tools.run, { command: 'one' });
    const controller = new AbortController();
    signal = controller.signal;
    await invoke(tools.run, { command: 'two' });

    expect(host.calls[0].signal).toBeUndefined();
    expect(host.calls[1].signal).toBe(controller.signal);
  });

  it('validates tool input against the schema instead of calling through', async () => {
    const host = makeHost();
    const tools = buildAgentTools(host);
    // Mastra's createTool wraps execute with input validation: a call with a
    // missing required field resolves to a ValidationError, and the host
    // never sees the call.
    const result = (await invoke(tools.read, {})) as { error?: boolean };
    expect(result).toMatchObject({ error: true });
    expect(host.calls).toHaveLength(0);
  });
});
