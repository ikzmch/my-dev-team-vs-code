import { describe, it, expect, beforeEach, vi } from 'vitest';

// Replace the Mastra Agent with a fake whose `generate`/`stream` we control,
// so these tests never construct a real model or hit Ollama.
const { generateMock, streamMock, agentCtor } = vi.hoisted(() => ({
  generateMock: vi.fn(),
  streamMock: vi.fn(),
  agentCtor: vi.fn(),
}));

vi.mock('@mastra/core/agent', () => ({
  Agent: class {
    generate = generateMock;
    stream = streamMock;
    constructor(config: unknown) {
      agentCtor(config);
    }
  },
}));

import { Triage, TriageSchema } from '../src/engine/core/triage';
import { Planner, PlanSchema, PartialPlan } from '../src/engine/core/planner';
import { Summarizer, SummaryGenSchema, PartialSummary } from '../src/engine/core/summarizer';
import { Answerer } from '../src/engine/core/answerer';
import { Executor, PartialExecution } from '../src/engine/core/executor';
import { AgentUsage } from '../src/engine/core/usage';
import { agents } from '../src/engine/config/agents';
import { routeModel, routeTriageModel } from '../src/engine/core/models';
import { ToolHost } from '../src/protocol/toolContract';
import { settings } from '../src/config/settings';
import { __state } from './mocks/vscode';

beforeEach(() => {
  generateMock.mockReset();
  streamMock.mockReset();
  agentCtor.mockReset();
});

/**
 * Fake of the MastraModelOutput the planner consumes: a partial-object
 * stream plus the final validated object.
 */
function fakeStreamOutput(partials: unknown[], final: unknown) {
  return {
    objectStream: new ReadableStream({
      start(controller) {
        for (const partial of partials) {
          controller.enqueue(partial);
        }
        controller.close();
      },
    }),
    object: Promise.resolve(final),
  };
}

/**
 * Fake of the MastraModelOutput the answerer consumes: the full chunk stream,
 * with each answer delta as a `text-delta` chunk (the answerer reads
 * `fullStream` so it can split a reasoning model's `<think>` chunks from the
 * answer). Extra chunks (e.g. `reasoning-delta`) can be appended for tests that
 * exercise thinking.
 */
function fakeTextOutput(
  deltas: string[],
  extra: Array<{ type: string; payload?: unknown }> = []
) {
  const chunks = [
    ...deltas.map((text) => ({ type: 'text-delta', payload: { text } })),
    ...extra,
  ];
  return {
    fullStream: new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(chunk);
        }
        controller.close();
      },
    }),
  };
}

/**
 * Fake of the MastraModelOutput the executor consumes: the full chunk stream
 * the tool-calling loop produces.
 */
function fakeChunkOutput(chunks: Array<{ type: string; payload?: unknown }>) {
  return {
    fullStream: new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(chunk);
        }
        controller.close();
      },
    }),
  };
}

const toolHostStub: ToolHost = {
  tools: ['read', 'search', 'run', 'write', 'edit'],
  execute: async () => 'ok',
};

describe('Triage', () => {
  it('returns the structured object from the model', async () => {
    generateMock.mockResolvedValue({
      object: { intent: 'oneshot', complexity: 'simple', reason: 'just a question' },
    });
    const result = await new Triage().classify('what is a closure');
    expect(result).toEqual({
      intent: 'oneshot',
      complexity: 'simple',
      reason: 'just a question',
    });
  });

  it('passes the prompt and the triage schema to the model', async () => {
    generateMock.mockResolvedValue({
      object: { intent: 'planning', complexity: 'moderate', reason: 'x' },
    });
    await new Triage().classify('refactor this');

    const [messages, options] = generateMock.mock.calls[0];
    expect(messages).toEqual([{ role: 'user', content: 'refactor this' }]);
    expect(options).toEqual({ structuredOutput: { schema: TriageSchema } });
  });

  it('is configured with triage instructions', async () => {
    new Triage();
    const config = agentCtor.mock.calls[0][0] as { id: string; instructions: string };
    expect(config.id).toBe('triage');
    expect(config.instructions).toContain('triage agent');
  });
});

describe('Planner', () => {
  const plan = {
    summary: 'do the thing',
    steps: [{ title: 'Read it', detail: 'because' }],
    complexity: 'moderate' as const,
  };

  it('returns the final structured plan from the stream', async () => {
    streamMock.mockResolvedValue(fakeStreamOutput([{ summary: 'do' }], plan));
    await expect(new Planner().plan('do the thing')).resolves.toEqual(plan);
  });

  it('forwards each partial snapshot to the callback in order', async () => {
    const partials = [
      { summary: 'do' },
      { summary: 'do the thing' },
      { summary: 'do the thing', steps: [{ title: 'Read it' }] },
    ];
    streamMock.mockResolvedValue(fakeStreamOutput(partials, plan));

    const seen: PartialPlan[] = [];
    await new Planner().plan('do the thing', (partial) => seen.push(partial));
    expect(seen).toEqual(partials);
  });

  it('drains the stream even without a callback', async () => {
    streamMock.mockResolvedValue(
      fakeStreamOutput([{ summary: 'do' }, { summary: 'do the thing' }], plan)
    );
    await expect(new Planner().plan('do the thing')).resolves.toEqual(plan);
  });

  it('passes the prompt and the plan schema to the model', async () => {
    streamMock.mockResolvedValue(fakeStreamOutput([], plan));
    await new Planner().plan('build a feature');

    const [messages, options] = streamMock.mock.calls[0];
    expect(messages).toEqual([{ role: 'user', content: 'build a feature' }]);
    expect(options).toEqual({ structuredOutput: { schema: PlanSchema } });
  });

  it('rejects when the final object does not match the plan schema even after a repair', async () => {
    // A fresh output per call so the retry re-streams rather than re-reading a
    // locked stream; both fail validation (steps below the min), so the run dies.
    streamMock.mockImplementation(async () =>
      fakeStreamOutput([], { summary: 's', steps: [] })
    );
    await expect(new Planner().plan('bad')).rejects.toThrow();
    expect(streamMock).toHaveBeenCalledTimes(2);
  });
});

describe('Summarizer', () => {
  const summary = {
    whatShips: 'A change line',
    howItsBuilt: 'A client seam',
    testsAndDocs: 'New tests; DESIGN updated',
  };

  it('returns the final structured summary from the stream', async () => {
    streamMock.mockResolvedValue(fakeStreamOutput([{ whatShips: 'A' }], summary));
    await expect(new Summarizer().summarize('recap this')).resolves.toEqual(summary);
  });

  it('forwards each partial snapshot to the callback in order', async () => {
    const partials = [
      { whatShips: 'A change' },
      { whatShips: 'A change line', howItsBuilt: 'A client' },
      { whatShips: 'A change line', howItsBuilt: 'A client seam', testsAndDocs: 'tests' },
    ];
    streamMock.mockResolvedValue(fakeStreamOutput(partials, summary));

    const seen: PartialSummary[] = [];
    await new Summarizer().summarize('recap this', (partial) => seen.push(partial));
    expect(seen).toEqual(partials);
  });

  it('passes the prompt and the summary schema to the model', async () => {
    streamMock.mockResolvedValue(fakeStreamOutput([], summary));
    await new Summarizer().summarize('recap the change');

    const [messages, options] = streamMock.mock.calls[0];
    expect(messages).toEqual([{ role: 'user', content: 'recap the change' }]);
    expect(options).toEqual({ structuredOutput: { schema: SummaryGenSchema } });
  });

  it('retries once with the validation error when a section is missing', async () => {
    streamMock
      // First summary omits a required field, so it fails the schema.
      .mockResolvedValueOnce(fakeStreamOutput([], { whatShips: 'a', howItsBuilt: 'b' }))
      .mockResolvedValueOnce(fakeStreamOutput([], summary));

    await expect(new Summarizer().summarize('recap it')).resolves.toEqual(summary);
    expect(streamMock).toHaveBeenCalledTimes(2);
    const retryContent = streamMock.mock.calls[1][0][0].content as string;
    expect(retryContent).toContain('recap it');
    expect(retryContent).toContain('failed validation');
  });
});

describe('Answerer', () => {
  it('returns the final text from the stream', async () => {
    streamMock.mockResolvedValue(fakeTextOutput(['It is', ' 4.']));
    await expect(new Answerer().answer('what is 2+2')).resolves.toBe('It is 4.');
  });

  it('forwards accumulated snapshots, not deltas, to the callback', async () => {
    streamMock.mockResolvedValue(fakeTextOutput(['It', ' is', ' 4.']));

    const seen: string[] = [];
    await new Answerer().answer('what is 2+2', (text) => seen.push(text));
    expect(seen).toEqual(['It', 'It is', 'It is 4.']);
  });

  it('drains the stream even without a callback', async () => {
    streamMock.mockResolvedValue(fakeTextOutput(['a', 'b']));
    await expect(new Answerer().answer('q')).resolves.toBe('ab');
  });

  it('passes the prompt to the model with no structured output', async () => {
    streamMock.mockResolvedValue(fakeTextOutput(['ok']));
    await new Answerer().answer('explain closures');

    const [messages, options] = streamMock.mock.calls[0];
    expect(messages).toEqual([{ role: 'user', content: 'explain closures' }]);
    expect(options).toBeUndefined();
  });

  it('splits reasoning from the answer, forwarding only thinking', async () => {
    streamMock.mockResolvedValue(
      fakeTextOutput(['It ', 'is 4.'], [
        { type: 'reasoning-delta', payload: { text: 'compute 2+2' } },
      ])
    );
    const thinking: string[] = [];
    const answer = await new Answerer().answer(
      'q',
      undefined,
      undefined,
      (line) => thinking.push(line)
    );
    // The answer holds only the text-delta content; reasoning is kept out of it.
    expect(answer).toBe('It is 4.');
    expect(thinking).toEqual(['compute 2+2']);
  });

  it('is configured with answerer instructions', async () => {
    new Answerer();
    const config = agentCtor.mock.calls[0][0] as { id: string; instructions: string };
    expect(config.id).toBe('answerer');
    expect(config.instructions).toContain('answerer');
  });
});

describe('Executor', () => {
  const toolLoop = [
    { type: 'text-delta', payload: { id: 't1', text: 'Reading' } },
    { type: 'text-delta', payload: { id: 't1', text: ' first.' } },
    {
      type: 'tool-call',
      payload: { toolCallId: 'c1', toolName: 'read', args: { path: 'a.ts' } },
    },
    {
      type: 'tool-result',
      payload: { toolCallId: 'c1', toolName: 'read', result: 'const a = 1;' },
    },
    { type: 'text-delta', payload: { id: 't2', text: 'Done.' } },
  ];

  it('returns the transcript of text and tool calls in order', async () => {
    streamMock.mockResolvedValue(fakeChunkOutput(toolLoop));
    await expect(new Executor(toolHostStub).execute('do it')).resolves.toEqual({
      events: [
        { kind: 'text', text: 'Reading first.' },
        { kind: 'tool', tool: 'read', input: 'a.ts', result: 'const a = 1;' },
        { kind: 'text', text: 'Done.' },
      ],
    });
  });

  it('forwards condensed reasoning to the thinking sink, kept out of the transcript', async () => {
    streamMock.mockResolvedValue(
      fakeChunkOutput([
        { type: 'reasoning-delta', payload: { text: 'Let me check' } },
        { type: 'reasoning-delta', payload: { text: ' the file.' } },
        { type: 'text-delta', payload: { id: 't1', text: 'Done.' } },
      ])
    );
    const thinking: string[] = [];
    const result = await new Executor(toolHostStub).execute(
      'do it',
      undefined,
      undefined,
      undefined,
      (line) => thinking.push(line)
    );
    // The latest condensed line as the reasoning buffer grew.
    expect(thinking).toEqual(['Let me check', 'Let me check the file.']);
    // Reasoning never becomes a transcript event.
    expect(result).toEqual({ events: [{ kind: 'text', text: 'Done.' }] });
  });

  it('ignores reasoning chunks when no thinking sink is given', async () => {
    streamMock.mockResolvedValue(
      fakeChunkOutput([
        { type: 'reasoning-delta', payload: { text: 'hidden' } },
        { type: 'text-delta', payload: { id: 't1', text: 'Hi.' } },
      ])
    );
    const result = await new Executor(toolHostStub).execute('do it');
    expect(result).toEqual({ events: [{ kind: 'text', text: 'Hi.' }] });
  });

  it('turns a progress tool call into a progress event and drops its result', async () => {
    streamMock.mockResolvedValue(
      fakeChunkOutput([
        {
          type: 'tool-call',
          payload: {
            toolCallId: 'p1',
            toolName: 'progress',
            args: { items: [{ step: 1, status: 'done' }, { step: 2, status: 'in_progress' }] },
          },
        },
        // The engine-only progress tool still returns an ack; it must not show
        // up as a tool result in the transcript.
        {
          type: 'tool-result',
          payload: { toolCallId: 'p1', toolName: 'progress', result: 'Progress shown to the user.' },
        },
        { type: 'text-delta', payload: { id: 't1', text: 'Working.' } },
      ])
    );

    await expect(new Executor(toolHostStub).execute('do it')).resolves.toEqual({
      events: [
        {
          kind: 'progress',
          items: [
            { step: 1, status: 'done' },
            { step: 2, status: 'in_progress' },
          ],
        },
        { kind: 'text', text: 'Working.' },
      ],
    });
  });

  it('drops a malformed or empty progress report instead of failing the run', async () => {
    streamMock.mockResolvedValue(
      fakeChunkOutput([
        {
          type: 'tool-call',
          payload: { toolCallId: 'p1', toolName: 'progress', args: { items: [] } },
        },
        {
          type: 'tool-call',
          payload: { toolCallId: 'p2', toolName: 'progress', args: { wrong: true } },
        },
        { type: 'text-delta', payload: { id: 't1', text: 'Done.' } },
      ])
    );

    await expect(new Executor(toolHostStub).execute('do it')).resolves.toEqual({
      events: [{ kind: 'text', text: 'Done.' }],
    });
  });

  it('forwards grow-only snapshots to the callback in order', async () => {
    streamMock.mockResolvedValue(fakeChunkOutput(toolLoop));

    const seen: PartialExecution[] = [];
    await new Executor(toolHostStub).execute('do it', (partial) => seen.push(partial));

    expect(seen).toEqual([
      { events: [{ kind: 'text', text: 'Reading' }] },
      { events: [{ kind: 'text', text: 'Reading first.' }] },
      {
        events: [
          { kind: 'text', text: 'Reading first.' },
          { kind: 'tool', tool: 'read', input: 'a.ts' },
        ],
      },
      {
        events: [
          { kind: 'text', text: 'Reading first.' },
          { kind: 'tool', tool: 'read', input: 'a.ts', result: 'const a = 1;' },
        ],
      },
      {
        events: [
          { kind: 'text', text: 'Reading first.' },
          { kind: 'tool', tool: 'read', input: 'a.ts', result: 'const a = 1;' },
          { kind: 'text', text: 'Done.' },
        ],
      },
    ]);
  });

  it('snapshots are copies, not live views of later mutations', async () => {
    streamMock.mockResolvedValue(fakeChunkOutput(toolLoop));

    const seen: PartialExecution[] = [];
    await new Executor(toolHostStub).execute('do it', (partial) => seen.push(partial));

    // The first snapshot still shows the text as it was at emission time,
    // even though the underlying event kept growing afterwards.
    expect(seen[0].events[0]).toEqual({ kind: 'text', text: 'Reading' });
  });

  it('drains the stream even without a callback', async () => {
    streamMock.mockResolvedValue(fakeChunkOutput(toolLoop));
    const result = await new Executor(toolHostStub).execute('do it');
    expect(result.events).toHaveLength(3);
  });

  it('passes the prompt and the step cap to the model', async () => {
    streamMock.mockResolvedValue(fakeChunkOutput([]));
    await new Executor(toolHostStub).execute('carry out the plan');

    const [messages, options] = streamMock.mock.calls[0];
    expect(messages).toEqual([{ role: 'user', content: 'carry out the plan' }]);
    expect(options).toEqual({ maxSteps: settings.executor.maxSteps });
  });

  it('forwards a cancellation signal to the model when one is given', async () => {
    streamMock.mockResolvedValue(fakeChunkOutput([]));
    const controller = new AbortController();
    await new Executor(toolHostStub).execute('go', undefined, controller.signal);

    const [, options] = streamMock.mock.calls[0];
    expect(options).toEqual({
      maxSteps: settings.executor.maxSteps,
      abortSignal: controller.signal,
    });
  });

  it('is configured with executor instructions, the workspace tools, and progress', () => {
    new Executor(toolHostStub);
    const config = agentCtor.mock.calls[0][0] as {
      id: string;
      instructions: string;
      tools: Record<string, unknown>;
    };
    expect(config.id).toBe('executor');
    expect(config.instructions).toContain('executor');
    expect(Object.keys(config.tools).sort()).toEqual([
      'edit',
      'progress',
      'read',
      'run',
      'search',
      'skill',
      'write',
    ]);
    // With no MCP tools, the executor's prompt carries no additional-tools section.
    expect(config.instructions).not.toContain('Additional tools');
  });

  it('adds MCP tools and an additional-tools prompt section when given dynamic tools', () => {
    new Executor(toolHostStub, undefined, undefined, undefined, [
      { name: 'mcp__fs__read', description: 'Read a file via MCP.', inputSchema: {} },
    ]);
    const config = agentCtor.mock.calls[0][0] as {
      instructions: string;
      tools: Record<string, unknown>;
    };
    expect(config.tools).toHaveProperty('mcp__fs__read');
    expect(config.instructions).toContain('Additional tools');
    expect(config.instructions).toContain('mcp__fs__read');
  });

  it('previews a call by the tool\'s configured key argument, not the args JSON', async () => {
    // The write tool's previewArg is "path": the transcript headline shows
    // the file name; the contents surface only as the bounded snippet.
    streamMock.mockResolvedValue(
      fakeChunkOutput([
        {
          type: 'tool-call',
          payload: {
            toolCallId: 'c1',
            toolName: 'write',
            args: { path: 'calculator.py', contents: 'print(1 + 1)\n' },
          },
        },
      ])
    );
    const result = await new Executor(toolHostStub).execute('go');
    expect(result.events[0]).toEqual({
      kind: 'tool',
      tool: 'write',
      input: 'calculator.py',
      snippet: 'print(1 + 1)',
    });
  });

  const writeCall = (contents: string) => [
    {
      type: 'tool-call',
      payload: {
        toolCallId: 'c1',
        toolName: 'write',
        args: { path: 'a.py', contents },
      },
    },
  ];

  it('caps the write snippet at the configured line count with a truncation message', async () => {
    const lines = ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7'];
    streamMock.mockResolvedValue(fakeChunkOutput(writeCall(lines.join('\n'))));
    const result = await new Executor(toolHostStub).execute('go');
    expect((result.events[0] as { snippet?: string }).snippet).toBe(
      'l1\nl2\nl3\nl4\nl5\n. . . (truncated)'
    );
  });

  it('shows a short file whole, without a truncation message', async () => {
    streamMock.mockResolvedValue(fakeChunkOutput(writeCall('l1\nl2\n')));
    const result = await new Executor(toolHostStub).execute('go');
    expect((result.events[0] as { snippet?: string }).snippet).toBe('l1\nl2');
  });

  it('honours the user-configured snippet line count', async () => {
    __state.configuration.set('myDevTeam.chat.toolSnippetLines', 2);
    try {
      streamMock.mockResolvedValue(fakeChunkOutput(writeCall('l1\nl2\nl3')));
      const result = await new Executor(toolHostStub).execute('go');
      expect((result.events[0] as { snippet?: string }).snippet).toBe(
        'l1\nl2\n. . . (truncated)'
      );
    } finally {
      __state.configuration.delete('myDevTeam.chat.toolSnippetLines');
    }
  });

  it('omits the snippet entirely when the line count is set to 0', async () => {
    __state.configuration.set('myDevTeam.chat.toolSnippetLines', 0);
    try {
      streamMock.mockResolvedValue(fakeChunkOutput(writeCall('l1\nl2')));
      const result = await new Executor(toolHostStub).execute('go');
      expect(result.events[0]).not.toHaveProperty('snippet');
    } finally {
      __state.configuration.delete('myDevTeam.chat.toolSnippetLines');
    }
  });

  it('bounds each snippet line like the input preview', async () => {
    const long = 'x'.repeat(settings.executor.inputPreviewMaxChars + 50);
    streamMock.mockResolvedValue(fakeChunkOutput(writeCall(long)));
    const result = await new Executor(toolHostStub).execute('go');
    const snippet = (result.events[0] as { snippet?: string }).snippet!;
    expect(snippet).toHaveLength(settings.executor.inputPreviewMaxChars + 1);
    expect(snippet.endsWith('…')).toBe(true);
  });

  it('omits the snippet for tools without a snippetArg and for blank contents', async () => {
    streamMock.mockResolvedValue(
      fakeChunkOutput([
        {
          type: 'tool-call',
          payload: { toolCallId: 'c1', toolName: 'read', args: { path: 'a.ts' } },
        },
        {
          type: 'tool-call',
          payload: {
            toolCallId: 'c2',
            toolName: 'write',
            args: { path: 'a.ts', contents: '  \n' },
          },
        },
      ])
    );
    const result = await new Executor(toolHostStub).execute('go');
    expect(result.events[0]).not.toHaveProperty('snippet');
    expect(result.events[1]).not.toHaveProperty('snippet');
  });

  it('falls back to compact JSON without Mastra metadata for unknown tools', async () => {
    streamMock.mockResolvedValue(
      fakeChunkOutput([
        {
          type: 'tool-call',
          payload: {
            toolCallId: 'c1',
            toolName: 'mystery',
            args: { path: 'a.ts', __mastraMetadata: { isStreaming: true } },
          },
        },
      ])
    );
    const result = await new Executor(toolHostStub).execute('go');
    expect(result.events[0]).toEqual({
      kind: 'tool',
      tool: 'mystery',
      input: '{"path":"a.ts"}',
    });
  });

  it('truncates oversized input and result previews', async () => {
    const longPath = 'x'.repeat(settings.executor.inputPreviewMaxChars + 50);
    const longResult = 'y'.repeat(settings.executor.resultPreviewMaxChars + 50);
    streamMock.mockResolvedValue(
      fakeChunkOutput([
        {
          type: 'tool-call',
          payload: { toolCallId: 'c1', toolName: 'read', args: { path: longPath } },
        },
        {
          type: 'tool-result',
          payload: { toolCallId: 'c1', toolName: 'read', result: longResult },
        },
      ])
    );
    const result = await new Executor(toolHostStub).execute('go');
    const event = result.events[0] as { input: string; result?: string };
    expect(event.input).toHaveLength(settings.executor.inputPreviewMaxChars + 1);
    expect(event.input.endsWith('…')).toBe(true);
    expect(event.result).toHaveLength(settings.executor.resultPreviewMaxChars + 1);
    expect(event.result!.endsWith('…')).toBe(true);
  });

  it('stringifies a non-string tool result', async () => {
    streamMock.mockResolvedValue(
      fakeChunkOutput([
        {
          type: 'tool-call',
          payload: { toolCallId: 'c1', toolName: 'search', args: { query: 'q' } },
        },
        {
          type: 'tool-result',
          payload: { toolCallId: 'c1', toolName: 'search', result: { hits: 2 } },
        },
      ])
    );
    const result = await new Executor(toolHostStub).execute('go');
    expect((result.events[0] as { result?: string }).result).toBe('{"hits":2}');
  });

  it('marks an errored tool result as failed', async () => {
    streamMock.mockResolvedValue(
      fakeChunkOutput([
        {
          type: 'tool-call',
          payload: { toolCallId: 'c1', toolName: 'read', args: { path: '../x' } },
        },
        {
          type: 'tool-result',
          payload: {
            toolCallId: 'c1',
            toolName: 'read',
            result: 'Path is outside the workspace: ../x',
            isError: true,
          },
        },
      ])
    );
    const result = await new Executor(toolHostStub).execute('go');
    expect(result.events[0]).toMatchObject({
      kind: 'tool',
      failed: true,
      result: 'Path is outside the workspace: ../x',
    });
  });

  it('records a tool-error chunk as a failed call with the error message', async () => {
    streamMock.mockResolvedValue(
      fakeChunkOutput([
        {
          type: 'tool-call',
          payload: { toolCallId: 'c1', toolName: 'read', args: { path: '../x' } },
        },
        {
          type: 'tool-error',
          payload: {
            toolCallId: 'c1',
            toolName: 'read',
            error: new Error('Path is outside the workspace: ../x'),
          },
        },
      ])
    );
    const result = await new Executor(toolHostStub).execute('go');
    expect(result.events[0]).toMatchObject({
      kind: 'tool',
      failed: true,
      result: 'Path is outside the workspace: ../x',
    });
  });

  it('rejects when the stream reports a run-level error', async () => {
    streamMock.mockResolvedValue(
      fakeChunkOutput([
        { type: 'text-delta', payload: { id: 't1', text: 'Hm' } },
        { type: 'error', payload: { error: new Error('connection refused') } },
      ])
    );
    await expect(new Executor(toolHostStub).execute('go')).rejects.toThrow(
      'connection refused'
    );
  });

  it('ignores unknown chunk types and orphan tool results', async () => {
    streamMock.mockResolvedValue(
      fakeChunkOutput([
        { type: 'step-start', payload: {} },
        { type: 'tool-result', payload: { toolCallId: 'ghost', result: 'x' } },
        { type: 'text-delta', payload: { id: 't1', text: 'ok' } },
        { type: 'finish', payload: {} },
      ])
    );
    await expect(new Executor(toolHostStub).execute('go')).resolves.toEqual({
      events: [{ kind: 'text', text: 'ok' }],
    });
  });
});

describe('self-repair for malformed structured output', () => {
  const counts = { inputTokens: 11, outputTokens: 7 };
  const plan = {
    summary: 'do the thing',
    steps: [{ title: 'Read it', detail: 'because' }],
    complexity: 'moderate' as const,
  };

  it('Triage retries once with the validation error and returns the corrected object', async () => {
    generateMock
      // First generation is malformed (no valid intent), so it fails the schema.
      .mockResolvedValueOnce({ object: { intent: 'nonsense' } })
      .mockResolvedValueOnce({
        object: { intent: 'oneshot', complexity: 'simple', reason: 'ok' },
      });

    const result = await new Triage().classify('what is a closure');
    expect(result).toEqual({ intent: 'oneshot', complexity: 'simple', reason: 'ok' });
    expect(generateMock).toHaveBeenCalledTimes(2);
    // The retry re-asks with the original prompt plus the validation error.
    const retryContent = generateMock.mock.calls[1][0][0].content as string;
    expect(retryContent).toContain('what is a closure');
    expect(retryContent).toContain('failed validation');
  });

  it('Triage reports both calls, flagging only the repair as repaired', async () => {
    generateMock
      .mockResolvedValueOnce({ object: { intent: 'nonsense' }, usage: counts })
      .mockResolvedValueOnce({
        object: { intent: 'oneshot', complexity: 'simple', reason: 'ok' },
        usage: counts,
      });

    const seen: AgentUsage[] = [];
    await new Triage().classify('q', (usage) => seen.push(usage));
    expect(seen).toHaveLength(2);
    expect(seen[0].repaired).toBeUndefined();
    expect(seen[1].repaired).toBe(true);
  });

  it('Triage fails for real when the repair also fails to validate', async () => {
    generateMock.mockResolvedValue({ object: { intent: 'nonsense' } });
    await expect(new Triage().classify('q')).rejects.toThrow();
    expect(generateMock).toHaveBeenCalledTimes(2);
  });

  it('Planner retries once with the validation error and returns the corrected plan', async () => {
    streamMock
      // First plan has no steps (below the min), so it fails the schema.
      .mockResolvedValueOnce(fakeStreamOutput([], { summary: 's', steps: [] }))
      .mockResolvedValueOnce(fakeStreamOutput([], plan));

    await expect(new Planner().plan('build it')).resolves.toEqual(plan);
    expect(streamMock).toHaveBeenCalledTimes(2);
    const retryContent = streamMock.mock.calls[1][0][0].content as string;
    expect(retryContent).toContain('build it');
    expect(retryContent).toContain('failed validation');
  });

  it('Planner reports both calls, flagging only the repair as repaired', async () => {
    streamMock
      .mockResolvedValueOnce(fakeStreamOutput([], { summary: 's', steps: [] }))
      .mockResolvedValueOnce({ ...fakeStreamOutput([], plan), usage: Promise.resolve(counts) });

    const seen: AgentUsage[] = [];
    await new Planner().plan('build it', undefined, (usage) => seen.push(usage));
    expect(seen).toHaveLength(2);
    expect(seen[0].repaired).toBeUndefined();
    expect(seen[1].repaired).toBe(true);
  });
});

describe('usage reporting', () => {
  const counts = { inputTokens: 11, outputTokens: 7 };
  const plan = {
    summary: 'do the thing',
    steps: [{ title: 'Read it', detail: 'because' }],
    complexity: 'moderate' as const,
  };

  it('Triage reports the routed model and the generate result counts', async () => {
    generateMock.mockResolvedValue({
      object: { intent: 'oneshot', complexity: 'simple', reason: 'x' },
      usage: counts,
    });
    const seen: AgentUsage[] = [];
    await new Triage().classify('q', (usage) => seen.push(usage));
    expect(seen).toEqual([
      {
        model: routeTriageModel(agents.triage.capabilities).model,
        ...counts,
      },
    ]);
  });

  it('Triage falls back to a length-based estimate when the result carries no usage', async () => {
    generateMock.mockResolvedValue({
      object: { intent: 'oneshot', complexity: 'simple', reason: 'x' },
    });
    const seen: AgentUsage[] = [];
    await new Triage().classify('q', (usage) => seen.push(usage));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      model: routeTriageModel(agents.triage.capabilities).model,
      estimated: true,
    });
    // The estimate is derived from the prompt and the serialized object, so
    // both sides are present and positive rather than silently missing.
    expect(seen[0].inputTokens).toBeGreaterThan(0);
    expect(seen[0].outputTokens).toBeGreaterThan(0);
  });

  it('accepts the legacy prompt/completion token names', async () => {
    generateMock.mockResolvedValue({
      object: { intent: 'oneshot', complexity: 'simple', reason: 'x' },
      usage: { promptTokens: 3, completionTokens: 5 },
    });
    const seen: AgentUsage[] = [];
    await new Triage().classify('q', (usage) => seen.push(usage));
    expect(seen).toEqual([
      {
        model: routeTriageModel(agents.triage.capabilities).model,
        inputTokens: 3,
        outputTokens: 5,
      },
    ]);
  });

  it('Planner reports usage off the drained stream', async () => {
    streamMock.mockResolvedValue({
      ...fakeStreamOutput([], plan),
      usage: Promise.resolve(counts),
    });
    const seen: AgentUsage[] = [];
    await new Planner().plan('p', undefined, (usage) => seen.push(usage));
    expect(seen).toEqual([
      { model: routeModel(agents.planner.capabilities).model, ...counts },
    ]);
  });

  it('Answerer reports usage off the drained stream', async () => {
    streamMock.mockResolvedValue({ ...fakeTextOutput(['ok']), usage: counts });
    const seen: AgentUsage[] = [];
    await new Answerer().answer('q', undefined, (usage) => seen.push(usage));
    expect(seen).toEqual([
      { model: routeModel(agents.answerer.capabilities).model, ...counts },
    ]);
  });

  it('Summarizer reports usage off the drained stream', async () => {
    const summary = { whatShips: 'a', howItsBuilt: 'b', testsAndDocs: 'c' };
    streamMock.mockResolvedValue({
      ...fakeStreamOutput([], summary),
      usage: Promise.resolve(counts),
    });
    const seen: AgentUsage[] = [];
    await new Summarizer().summarize('p', undefined, (usage) => seen.push(usage));
    expect(seen).toEqual([
      { model: routeModel(agents.summarizer.capabilities).model, ...counts },
    ]);
  });

  it('Executor reports usage off the drained stream', async () => {
    streamMock.mockResolvedValue({
      ...fakeChunkOutput([]),
      usage: Promise.resolve(counts),
    });
    const seen: AgentUsage[] = [];
    await new Executor(toolHostStub).execute('go', undefined, undefined, (usage) =>
      seen.push(usage)
    );
    expect(seen).toEqual([
      { model: routeModel(agents.executor.capabilities).model, ...counts },
    ]);
  });

  it('a rejecting usage promise is swallowed and falls back to an estimate', async () => {
    streamMock.mockResolvedValue({
      ...fakeTextOutput(['ok']),
      usage: Promise.reject(new Error('no usage')),
    });
    const seen: AgentUsage[] = [];
    await expect(
      new Answerer().answer('q', undefined, (usage) => seen.push(usage))
    ).resolves.toBe('ok');
    // The rejection degrades to undefined, so the estimate stands in rather
    // than the run failing or the usage silently going unreported.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ estimated: true });
  });
});
