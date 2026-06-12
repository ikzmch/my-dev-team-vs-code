import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  APPROVAL_COMMAND_ID,
  ChatApprover,
  createHandler,
  renderReply,
  PARTICIPANT_ID,
} from '../src/ui/chatParticipant';
import { createDevTeamWorkflow, ReplyProgress } from '../src/core/workflow';
import { TriageResult } from '../src/core/triage';
import { PartialPlan, PlanProgress, PlanResult } from '../src/core/planner';
import { AnswerProgress } from '../src/core/answerer';
import {
  ExecutionProgress,
  ExecutionResult,
  PartialExecution,
} from '../src/core/executor';
import {
  __reset,
  __state,
  __setFile,
  Uri,
  Location,
  Position,
  Range,
} from './mocks/vscode';

beforeEach(() => {
  __reset();
});

function fakeStream() {
  return { markdown: vi.fn(), progress: vi.fn(), button: vi.fn() };
}

/** Minimal CancellationToken double; flip `isCancellationRequested` to cancel. */
function fakeToken(cancelled = false) {
  return {
    isCancellationRequested: cancelled,
    onCancellationRequested: vi.fn(() => ({ dispose: vi.fn() })),
  };
}

const aPlan: PlanResult = {
  summary: 'Add a feature',
  steps: [
    { title: 'Find the file', tool: 'search', detail: 'locate it' },
    { title: 'Think', tool: 'none', detail: 'reason about it' },
  ],
};

const anExecution: ExecutionResult = {
  events: [
    { kind: 'tool', tool: 'search', input: '{"query":"*"}', result: 'src/a.ts' },
    { kind: 'text', text: 'All steps are done.' },
  ],
};

/**
 * Build a real dev-team workflow over fake agents, and record the prompt each
 * agent receives so tests can assert on what the handler and workflow
 * composed for it.
 */
function makeWorkflow(
  classify: (prompt: string) => Promise<TriageResult> = async () => ({
    intent: 'oneshot',
    reason: 'simple',
  }),
  plan: (prompt: string, onPartial?: PlanProgress) => Promise<PlanResult> = async () =>
    aPlan,
  answer: (prompt: string, onPartial?: AnswerProgress) => Promise<string> = async () =>
    'It is 4.',
  execute: (
    prompt: string,
    onPartial?: ExecutionProgress
  ) => Promise<ExecutionResult> = async () => anExecution
) {
  const seen = {
    triage: undefined as string | undefined,
    planner: undefined as string | undefined,
    answerer: undefined as string | undefined,
    executor: undefined as string | undefined,
  };
  const workflow = createDevTeamWorkflow(
    {
      classify: async (prompt: string) => {
        seen.triage = prompt;
        return classify(prompt);
      },
    } as any,
    {
      plan: async (prompt: string, onPartial?: PlanProgress) => {
        seen.planner = prompt;
        return plan(prompt, onPartial);
      },
    } as any,
    {
      answer: async (prompt: string, onPartial?: AnswerProgress) => {
        seen.answerer = prompt;
        return answer(prompt, onPartial);
      },
    } as any,
    {
      execute: async (prompt: string, onPartial?: ExecutionProgress) => {
        seen.executor = prompt;
        return execute(prompt, onPartial);
      },
    } as any
  );
  return { workflow, seen };
}

function emitted(stream: ReturnType<typeof fakeStream>): string {
  return stream.markdown.mock.calls.map((c) => c[0]).join('');
}

describe('ChatApprover', () => {
  /**
   * Wire an approver the way activate() does: registered command plus an
   * attached stream. Returns a click(n) helper that presses the n-th rendered
   * button by invoking the registered command with that button's arguments.
   */
  function wiredApprover() {
    const approver = new ChatApprover();
    const context = { subscriptions: [] as unknown[] };
    approver.register(context as any);
    const stream = fakeStream();
    approver.setStream(stream as any);
    const click = (n: number) => {
      const button = stream.button.mock.calls[n][0] as {
        command: string;
        arguments: unknown[];
      };
      __state.registeredCommands.get(button.command)!(...button.arguments);
    };
    return { approver, stream, click, context };
  }

  it('renders the question with Approve/Decline buttons into the chat', async () => {
    const { approver, stream, click } = wiredApprover();

    const pending = approver.confirm('Write file', 'preview body');
    expect(stream.markdown).toHaveBeenCalledOnce();
    expect(stream.markdown.mock.calls[0][0]).toContain('**Write file?**');
    expect(stream.markdown.mock.calls[0][0]).toContain('preview body');
    expect(stream.button).toHaveBeenCalledTimes(2);
    expect(stream.button.mock.calls[0][0]).toMatchObject({
      command: APPROVAL_COMMAND_ID,
      title: 'Approve',
    });
    expect(stream.button.mock.calls[1][0]).toMatchObject({
      command: APPROVAL_COMMAND_ID,
      title: 'Decline',
    });

    click(0); // Approve
    await expect(pending).resolves.toBe(true);
  });

  it('resolves false when the user clicks Decline', async () => {
    const { approver, click } = wiredApprover();

    const pending = approver.confirm('Run command', '$ ls');
    click(1); // Decline
    await expect(pending).resolves.toBe(false);
  });

  it('settles concurrent approvals independently by id', async () => {
    const { approver, stream, click } = wiredApprover();

    const first = approver.confirm('Write file', 'one');
    const second = approver.confirm('Run command', 'two');
    expect(stream.button).toHaveBeenCalledTimes(4);

    click(3); // decline the second
    click(0); // approve the first
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(false);
  });

  it('ignores a stale button click after the approval settled', async () => {
    const { approver, click } = wiredApprover();

    const pending = approver.confirm('Run command', '$ ls');
    click(0);
    await expect(pending).resolves.toBe(true);
    expect(() => click(1)).not.toThrow(); // late Decline click is a no-op
  });

  it('declines whatever is still pending when the stream is cleared', async () => {
    const { approver } = wiredApprover();

    const pending = approver.confirm('Write file', 'preview');
    approver.clearStream(); // request ended or was cancelled
    await expect(pending).resolves.toBe(false);
  });

  it('falls back to the modal when no stream has been attached', async () => {
    const approver = new ChatApprover();
    __state.warningResponse = 'Approve';
    await expect(approver.confirm('Run command', '$ ls')).resolves.toBe(true);

    __state.warningResponse = undefined; // user dismissed the modal
    await expect(approver.confirm('Run command', '$ ls')).resolves.toBe(false);
  });

  it('asks via the modal, not the stream, after clearStream', async () => {
    const { approver, stream } = wiredApprover();
    approver.clearStream();
    __state.warningResponse = 'Approve';

    await expect(approver.confirm('Run command', '$ ls')).resolves.toBe(true);
    expect(stream.markdown).not.toHaveBeenCalled();
    expect(stream.button).not.toHaveBeenCalled();
  });

  it('survives a disposed stream and still asks via the modal', async () => {
    const approver = new ChatApprover();
    const closed = {
      markdown: vi.fn(() => {
        throw new Error('stream is closed');
      }),
      button: vi.fn(),
    };
    approver.setStream(closed as any);
    __state.warningResponse = 'Approve';

    await expect(approver.confirm('Run command', '$ ls')).resolves.toBe(true);
  });
});

describe('createHandler', () => {
  it('renders the detected intent and the answer for a oneshot request', async () => {
    const { workflow } = makeWorkflow(
      async () => ({ intent: 'oneshot', reason: 'simple question' }),
      undefined,
      async () => 'It is **4**.'
    );
    const stream = fakeStream();

    await createHandler(workflow)(
      { prompt: 'what is 2+2', references: [] } as any,
      { history: [] } as any,
      stream as any,
      fakeToken() as any
    );

    const text = emitted(stream);
    expect(text).toContain('**Detected intent:** `oneshot`');
    expect(text).toContain('**Reason:** simple question');
    expect(text).toContain('**Answer:**\n\nIt is **4**.');
    // No custom progress label: the chat shows the standard indicator.
    expect(stream.progress).not.toHaveBeenCalled();
  });

  it('renders a planning request as a checklist plus the execution transcript', async () => {
    const { workflow } = makeWorkflow(async () => ({
      intent: 'planning',
      reason: 'needs steps',
    }));
    const stream = fakeStream();

    await createHandler(workflow)(
      { prompt: 'add a feature', references: [] } as any,
      { history: [] } as any,
      stream as any,
      fakeToken() as any
    );

    const text = emitted(stream);
    expect(text).toContain('**Detected intent:** `planning`');
    expect(text).toContain('**Plan:** Add a feature');
    expect(text).toContain('1. **Find the file** _(search)_ - locate it');
    // tool "none" must not render a tool suffix.
    expect(text).toContain('2. **Think** - reason about it');
    expect(text).not.toContain('Think** _(none)_');
    // The execution transcript follows the plan: tool calls and the report.
    expect(text).toContain('**Execution:**');
    expect(text).toContain('- **search** `{"query":"*"}` → `src/a.ts`');
    expect(text).toContain('All steps are done.');
    // No custom progress label: the chat shows the standard indicator.
    expect(stream.progress).not.toHaveBeenCalled();
  });

  it('does not run the executor on a oneshot request', async () => {
    const { workflow, seen } = makeWorkflow();

    await createHandler(workflow)(
      { prompt: 'what is 2+2', references: [] } as any,
      { history: [] } as any,
      fakeStream() as any,
      fakeToken() as any
    );

    expect(seen.executor).toBeUndefined();
  });

  it('hands the executor the prompt plus the drafted plan', async () => {
    const { workflow, seen } = makeWorkflow(async () => ({
      intent: 'planning',
      reason: 'needs steps',
    }));

    await createHandler(workflow)(
      { prompt: 'add a feature', references: [] } as any,
      { history: [] } as any,
      fakeStream() as any,
      fakeToken() as any
    );

    expect(seen.executor).toContain('add a feature');
    expect(seen.executor).toContain('--- Drafted plan ---');
    expect(seen.executor).toContain('1. Find the file (tool: search) - locate it');
  });

  it('surfaces a triage failure with the Ollama hint', async () => {
    const { workflow } = makeWorkflow(async () => {
      throw new Error('connection refused');
    });
    const stream = fakeStream();

    await createHandler(workflow)(
      { prompt: 'hi', references: [] } as any,
      { history: [] } as any,
      stream as any,
      fakeToken() as any
    );

    const text = emitted(stream);
    expect(text).toContain('**Triage error:**');
    expect(text).toContain('connection refused');
    expect(text).toContain('Ollama');
  });

  it('surfaces a planner failure with the Ollama hint', async () => {
    const { workflow } = makeWorkflow(
      async () => ({ intent: 'planning', reason: 'x' }),
      async () => {
        throw new Error('model not found');
      }
    );
    const stream = fakeStream();

    await createHandler(workflow)(
      { prompt: 'do work', references: [] } as any,
      { history: [] } as any,
      stream as any,
      fakeToken() as any
    );

    const text = emitted(stream);
    expect(text).toContain('**Planner error:**');
    expect(text).toContain('model not found');
    expect(text).toContain('Ollama');
  });

  it('surfaces an executor failure with the Ollama hint', async () => {
    const { workflow } = makeWorkflow(
      async () => ({ intent: 'planning', reason: 'x' }),
      undefined,
      undefined,
      async () => {
        throw new Error('model not found');
      }
    );
    const stream = fakeStream();

    await createHandler(workflow)(
      { prompt: 'do work', references: [] } as any,
      { history: [] } as any,
      stream as any,
      fakeToken() as any
    );

    const text = emitted(stream);
    expect(text).toContain('**Executor error:**');
    expect(text).toContain('model not found');
    expect(text).toContain('Ollama');
    // The failure must not be misattributed to the (successful) plan step.
    expect(text).not.toContain('**Planner error:**');
  });

  it('surfaces an answerer failure with the Ollama hint', async () => {
    const { workflow } = makeWorkflow(
      async () => ({ intent: 'oneshot', reason: 'x' }),
      undefined,
      async () => {
        throw new Error('model not found');
      }
    );
    const stream = fakeStream();

    await createHandler(workflow)(
      { prompt: 'what is 2+2', references: [] } as any,
      { history: [] } as any,
      stream as any,
      fakeToken() as any
    );

    const text = emitted(stream);
    expect(text).toContain('**Answerer error:**');
    expect(text).toContain('model not found');
    expect(text).toContain('Ollama');
  });

  it('returns the command in the chat result metadata', async () => {
    const { workflow } = makeWorkflow();

    const result = await createHandler(workflow)(
      { prompt: 'hi', references: [], command: 'explain' } as any,
      { history: [] } as any,
      fakeStream() as any,
      fakeToken() as any
    );
    expect((result as any).metadata.command).toBe('explain');
  });

  it('inlines an attached file (Uri reference) into the answerer prompt', async () => {
    const uri = __setFile('src/a.ts', 'file body');
    const { workflow, seen } = makeWorkflow();

    await createHandler(workflow)(
      { prompt: 'look at this', references: [{ value: uri }] } as any,
      { history: [] } as any,
      fakeStream() as any,
      fakeToken() as any
    );

    expect(seen.answerer).toContain('look at this');
    expect(seen.answerer).toContain('--- Attached context ---');
    expect(seen.answerer).toContain('File: src/a.ts');
    expect(seen.answerer).toContain('file body');
  });

  it('gives the triage agent attachment names but not their contents', async () => {
    const uri = __setFile('src/a.ts', 'file body');
    const { workflow, seen } = makeWorkflow();

    await createHandler(workflow)(
      { prompt: 'look at this', references: [{ value: uri }] } as any,
      { history: [] } as any,
      fakeStream() as any,
      fakeToken() as any
    );

    expect(seen.triage).toContain('look at this');
    expect(seen.triage).toContain('File: src/a.ts');
    expect(seen.triage).not.toContain('file body');
  });

  it('inlines a selection (Location reference) with its line number', async () => {
    const uri = __setFile('src/b.ts', 'line0\nline1\nline2');
    const location = new Location(uri, new Range(new Position(1, 0), new Position(1, 5)));
    const { workflow, seen } = makeWorkflow();

    await createHandler(workflow)(
      { prompt: 'explain', references: [{ value: location }] } as any,
      { history: [] } as any,
      fakeStream() as any,
      fakeToken() as any
    );

    expect(seen.answerer).toContain('Selection from src/b.ts (line 2)');
    expect(seen.answerer).toContain('line1');
    expect(seen.triage).toContain('Selection from src/b.ts (line 2)');
    expect(seen.triage).not.toContain('line1');
  });

  it('inlines a plain string reference', async () => {
    const { workflow, seen } = makeWorkflow();

    await createHandler(workflow)(
      { prompt: 'q', references: [{ value: 'raw snippet' }] } as any,
      { history: [] } as any,
      fakeStream() as any,
      fakeToken() as any
    );
    expect(seen.answerer).toContain('raw snippet');
    expect(seen.triage).toContain('Attached text');
    expect(seen.triage).not.toContain('raw snippet');
  });

  it('reports an unreadable attachment instead of throwing', async () => {
    const ghost = Uri.joinPath(__state.workspaceFolders![0].uri, 'ghost.ts');
    const { workflow, seen } = makeWorkflow();

    await createHandler(workflow)(
      { prompt: 'q', references: [{ value: ghost }] } as any,
      { history: [] } as any,
      fakeStream() as any,
      fakeToken() as any
    );
    expect(seen.answerer).toContain('could not read attachment');
    expect(seen.triage).toContain('Unreadable attachment');
  });

  it('truncates very large attachments', async () => {
    const { workflow, seen } = makeWorkflow();
    const huge = 'z'.repeat(25_000);

    await createHandler(workflow)(
      { prompt: 'q', references: [{ value: huge }] } as any,
      { history: [] } as any,
      fakeStream() as any,
      fakeToken() as any
    );
    expect(seen.answerer).toContain('…(truncated)');
  });

  it('does not add an attachments block when there are no references', async () => {
    const { workflow, seen } = makeWorkflow();

    await createHandler(workflow)(
      { prompt: 'plain', references: [] } as any,
      { history: [] } as any,
      fakeStream() as any,
      fakeToken() as any
    );
    expect(seen.triage).toBe('plain');
    expect(seen.answerer).toBe('plain');
  });

  it('subscribes to cancellation and disposes the listener afterwards', async () => {
    const { workflow } = makeWorkflow();
    const token = fakeToken();

    await createHandler(workflow)(
      { prompt: 'hi', references: [] } as any,
      { history: [] } as any,
      fakeStream() as any,
      token as any
    );

    expect(token.onCancellationRequested).toHaveBeenCalledOnce();
    const subscription = token.onCancellationRequested.mock.results[0]
      .value as { dispose: ReturnType<typeof vi.fn> };
    expect(subscription.dispose).toHaveBeenCalledOnce();
  });

  it('renders nothing when the request was cancelled', async () => {
    const { workflow } = makeWorkflow();
    const stream = fakeStream();

    const result = await createHandler(workflow)(
      { prompt: 'hi', references: [] } as any,
      { history: [] } as any,
      stream as any,
      fakeToken(true) as any
    );

    expect(stream.markdown).not.toHaveBeenCalled();
    expect((result as any).metadata.command).toBe('');
  });

  it('swallows a run failure caused by cancellation', async () => {
    const { workflow } = makeWorkflow(async () => {
      throw new Error('aborted');
    });
    const stream = fakeStream();

    await expect(
      createHandler(workflow)(
        { prompt: 'hi', references: [] } as any,
        { history: [] } as any,
        stream as any,
        fakeToken(true) as any
      )
    ).resolves.toBeDefined();
    expect(stream.markdown).not.toHaveBeenCalled();
  });
});

describe('createHandler streaming', () => {
  const count = (text: string, needle: string) => text.split(needle).length - 1;

  /** Growing snapshots the way the partial-JSON stream would deliver them. */
  const partials: PartialPlan[] = [
    { summary: 'Add' },
    { summary: 'Add a feature' },
    { summary: 'Add a feature', steps: [{ title: 'Find the' }] },
    {
      summary: 'Add a feature',
      steps: [{ title: 'Find the file', tool: 'sea' }],
    },
    {
      summary: 'Add a feature',
      steps: [{ title: 'Find the file', tool: 'search', detail: 'locate it' }],
    },
    {
      summary: 'Add a feature',
      steps: [
        { title: 'Find the file', tool: 'search', detail: 'locate it' },
        { title: 'Think', tool: 'none', detail: 'reason about it' },
      ],
    },
  ];

  it('streams the plan incrementally and never repeats content', async () => {
    const { workflow } = makeWorkflow(
      async () => ({ intent: 'planning', reason: 'needs steps' }),
      async (_prompt, onPartial) => {
        for (const partial of partials) {
          onPartial?.(partial);
        }
        return aPlan;
      }
    );
    const stream = fakeStream();

    await createHandler(workflow)(
      { prompt: 'add a feature', references: [] } as any,
      { history: [] } as any,
      stream as any,
      fakeToken() as any
    );

    // The reply arrived in several appended chunks, not one blob.
    expect(stream.markdown.mock.calls.length).toBeGreaterThan(2);

    // The triage block was emitted before any plan content.
    const first = stream.markdown.mock.calls[0][0] as string;
    expect(first).toContain('**Detected intent:** `planning`');
    expect(first).not.toContain('**Plan:**');

    // The concatenation is exactly the final reply, with nothing duplicated.
    const text = emitted(stream);
    expect(text).toBe(
      renderReply(
        {
          intent: 'planning',
          reason: 'needs steps',
          plan: aPlan,
          execution: anExecution,
        },
        true
      )
    );
    expect(count(text, '**Plan:**')).toBe(1);
    expect(count(text, 'Find the file')).toBe(1);
    expect(count(text, '**Execution:**')).toBe(1);
  });

  it('streams the execution transcript incrementally and never repeats content', async () => {
    /** Growing snapshots the way the executor emits them. */
    const executionPartials: PartialExecution[] = [
      { events: [{ kind: 'text', text: 'Searching' }] },
      { events: [{ kind: 'text', text: 'Searching first.' }] },
      {
        events: [
          { kind: 'text', text: 'Searching first.' },
          { kind: 'tool', tool: 'search', input: '{"query":"*"}' },
        ],
      },
      {
        events: [
          { kind: 'text', text: 'Searching first.' },
          { kind: 'tool', tool: 'search', input: '{"query":"*"}', result: 'src/a.ts' },
        ],
      },
      {
        events: [
          { kind: 'text', text: 'Searching first.' },
          { kind: 'tool', tool: 'search', input: '{"query":"*"}', result: 'src/a.ts' },
          { kind: 'text', text: 'Done.' },
        ],
      },
    ];
    const finalExecution: ExecutionResult = {
      events: executionPartials[executionPartials.length - 1]
        .events as ExecutionResult['events'],
    };
    const { workflow } = makeWorkflow(
      async () => ({ intent: 'planning', reason: 'needs steps' }),
      undefined,
      undefined,
      async (_prompt, onPartial) => {
        for (const partial of executionPartials) {
          onPartial?.(partial);
        }
        return finalExecution;
      }
    );
    const stream = fakeStream();

    await createHandler(workflow)(
      { prompt: 'add a feature', references: [] } as any,
      { history: [] } as any,
      stream as any,
      fakeToken() as any
    );

    // The transcript arrived in several appended chunks, not one blob.
    expect(stream.markdown.mock.calls.length).toBeGreaterThan(2);

    // The concatenation is exactly the final reply, with nothing duplicated.
    const text = emitted(stream);
    expect(text).toBe(
      renderReply(
        {
          intent: 'planning',
          reason: 'needs steps',
          plan: aPlan,
          execution: finalExecution,
        },
        true
      )
    );
    expect(count(text, '**Execution:**')).toBe(1);
    expect(count(text, 'src/a.ts')).toBe(1);
    expect(count(text, 'Searching first.')).toBe(1);
  });

  it('streams a oneshot answer incrementally and never repeats content', async () => {
    const snapshots = ['It', 'It is', 'It is 4.'];
    const { workflow } = makeWorkflow(
      async () => ({ intent: 'oneshot', reason: 'simple' }),
      undefined,
      async (_prompt, onPartial) => {
        for (const snapshot of snapshots) {
          onPartial?.(snapshot);
        }
        return 'It is 4.';
      }
    );
    const stream = fakeStream();

    await createHandler(workflow)(
      { prompt: 'what is 2+2', references: [] } as any,
      { history: [] } as any,
      stream as any,
      fakeToken() as any
    );

    // The reply arrived in several appended chunks, not one blob.
    expect(stream.markdown.mock.calls.length).toBeGreaterThan(2);

    // The triage block was emitted before any answer content.
    const first = stream.markdown.mock.calls[0][0] as string;
    expect(first).toContain('**Detected intent:** `oneshot`');
    expect(first).not.toContain('**Answer:**');

    // The concatenation is exactly the final reply, with nothing duplicated.
    const text = emitted(stream);
    expect(text).toBe(
      renderReply({ intent: 'oneshot', reason: 'simple', answer: 'It is 4.' }, true)
    );
    expect(count(text, '**Answer:**')).toBe(1);
    expect(count(text, 'It is 4.')).toBe(1);
  });

  it('falls back to the complete reply when a snapshot is inconsistent', async () => {
    const { workflow } = makeWorkflow(
      async () => ({ intent: 'planning', reason: 'needs steps' }),
      async (_prompt, onPartial) => {
        onPartial?.({ summary: 'B' });
        onPartial?.({ summary: 'A different summary' }); // not an extension
        return aPlan;
      }
    );
    const stream = fakeStream();

    await createHandler(workflow)(
      { prompt: 'add a feature', references: [] } as any,
      { history: [] } as any,
      stream as any,
      fakeToken() as any
    );

    // The full reply is still rendered after the stale streamed prefix.
    const text = emitted(stream);
    expect(text).toContain('**Plan:** Add a feature');
    expect(text).toContain('1. **Find the file** _(search)_ - locate it');
  });

  it('separates a planner failure from already-streamed output', async () => {
    const { workflow } = makeWorkflow(
      async () => ({ intent: 'planning', reason: 'needs steps' }),
      async (_prompt, onPartial) => {
        onPartial?.({ summary: 'Add a feature' });
        throw new Error('model not found');
      }
    );
    const stream = fakeStream();

    await createHandler(workflow)(
      { prompt: 'add a feature', references: [] } as any,
      { history: [] } as any,
      stream as any,
      fakeToken() as any
    );

    const text = emitted(stream);
    expect(text).toContain('**Plan:** Add a feature');
    expect(text).toContain('\n\n**Planner error:** model not found');
  });

  it('does not fail the run when a streamed chunk cannot be written', async () => {
    const { workflow } = makeWorkflow(
      async () => ({ intent: 'planning', reason: 'needs steps' }),
      async (_prompt, onPartial) => {
        onPartial?.({ summary: 'Add' });
        return aPlan;
      }
    );
    const stream = fakeStream();
    // The write triggered by the first snapshot throws; later writes work.
    stream.markdown.mockImplementationOnce(() => {
      throw new Error('stream not ready');
    });

    await createHandler(workflow)(
      { prompt: 'add a feature', references: [] } as any,
      { history: [] } as any,
      stream as any,
      fakeToken() as any
    );

    // The run still succeeded and the final render delivered the full reply.
    const text = emitted(stream);
    expect(text).toContain('**Plan:** Add a feature');
    expect(text).not.toContain('**Planner error');
  });
});

describe('renderReply', () => {
  const progress = (plan?: PartialPlan): ReplyProgress => ({
    intent: 'planning',
    reason: 'needs steps',
    plan,
  });

  it('renders growing snapshots as prefix-extensions of each other', () => {
    const snapshots: PartialPlan[] = [
      {},
      { summary: 'Add' },
      { summary: 'Add a feature' },
      { summary: 'Add a feature', steps: [] },
      { summary: 'Add a feature', steps: [{ title: 'Find' }] },
      { summary: 'Add a feature', steps: [{ title: 'Find the file', tool: 'sea' }] },
      {
        summary: 'Add a feature',
        steps: [{ title: 'Find the file', tool: 'search', detail: 'locate' }],
      },
      {
        summary: 'Add a feature',
        steps: [
          { title: 'Find the file', tool: 'search', detail: 'locate it' },
          { title: 'Think', tool: 'none', detail: 'reason about it' },
        ],
      },
    ];

    let previous = '';
    for (const snapshot of snapshots) {
      const rendered = renderReply(progress(snapshot), false);
      expect(rendered.startsWith(previous)).toBe(true);
      previous = rendered;
    }
    const final = renderReply(progress(aPlan), true);
    expect(final.startsWith(previous)).toBe(true);
  });

  it('withholds the tool suffix until the detail field starts', () => {
    const mid = renderReply(
      progress({ summary: 's', steps: [{ title: 'Find', tool: 'sea' }] }),
      false
    );
    expect(mid).toContain('1. **Find**');
    expect(mid).not.toContain('sea');
  });

  it('withholds the closing bold marker while the title still streams', () => {
    const mid = renderReply(progress({ summary: 's', steps: [{ title: 'Fi' }] }), false);
    expect(mid.endsWith('1. **Fi')).toBe(true);
  });

  it('no longer advertises a not-yet-implemented executor step', () => {
    expect(renderReply(progress(aPlan), true)).not.toContain('not yet implemented');
  });

  const withExecution = (execution: PartialExecution): ReplyProgress => ({
    intent: 'planning',
    reason: 'needs steps',
    plan: aPlan,
    execution,
  });

  it('renders the execution transcript behind its header after the plan', () => {
    const text = renderReply(withExecution(anExecution), true);
    expect(text).toContain('**Plan:** Add a feature');
    const planAt = text.indexOf('**Plan:**');
    const executionAt = text.indexOf('**Execution:**');
    expect(executionAt).toBeGreaterThan(planAt);
    expect(text).toContain('- **search** `{"query":"*"}` → `src/a.ts`');
    expect(text).toContain('All steps are done.');
  });

  it('renders growing execution snapshots as prefix-extensions of each other', () => {
    const snapshots: PartialExecution[] = [
      { events: [] },
      { events: [{ kind: 'text', text: 'Sear' }] },
      { events: [{ kind: 'text', text: 'Searching.' }] },
      {
        events: [
          { kind: 'text', text: 'Searching.' },
          { kind: 'tool', tool: 'search', input: '{"query":"*"}' },
        ],
      },
      {
        events: [
          { kind: 'text', text: 'Searching.' },
          { kind: 'tool', tool: 'search', input: '{"query":"*"}', result: 'src/a.ts' },
        ],
      },
      {
        events: [
          { kind: 'text', text: 'Searching.' },
          { kind: 'tool', tool: 'search', input: '{"query":"*"}', result: 'src/a.ts' },
          { kind: 'text', text: 'Done.' },
        ],
      },
    ];

    let previous = '';
    for (const snapshot of snapshots) {
      const rendered = renderReply(withExecution(snapshot), false);
      expect(rendered.startsWith(previous)).toBe(true);
      previous = rendered;
    }
    const final = renderReply(
      withExecution(snapshots[snapshots.length - 1]),
      true
    );
    expect(final.startsWith(previous)).toBe(true);
  });

  it('stays a prefix-extension across the plan-to-execution transition', () => {
    // While the plan streams, then once execution starts, the render must
    // keep extending what was already emitted.
    const stages = [
      renderReply(progress({ summary: 'Add a feature', steps: [] }), false),
      renderReply(progress(aPlan), false),
      renderReply(withExecution({ events: [] }), false),
      renderReply(
        withExecution({ events: [{ kind: 'tool', tool: 'read', input: '{}' }] }),
        false
      ),
    ];
    for (let i = 1; i < stages.length; i++) {
      expect(stages[i].startsWith(stages[i - 1])).toBe(true);
    }
  });

  it('ends the render at a tool call that has no result yet', () => {
    const text = renderReply(
      withExecution({
        events: [{ kind: 'tool', tool: 'run', input: '{"command":"npm test"}' }],
      }),
      false
    );
    expect(text.endsWith('- **run** `{"command":"npm test"}`')).toBe(true);
  });

  it('marks a failed tool call in the transcript', () => {
    const text = renderReply(
      withExecution({
        events: [
          {
            kind: 'tool',
            tool: 'read',
            input: '{"path":"../x"}',
            result: 'Path is outside the workspace: ../x',
            failed: true,
          },
        ],
      }),
      true
    );
    expect(text).toContain('→ **failed** `Path is outside the workspace: ../x`');
  });

  it('flattens result previews onto one backtick-safe line', () => {
    const text = renderReply(
      withExecution({
        events: [
          {
            kind: 'tool',
            tool: 'read',
            input: '{"path":"a.md"}',
            result: 'line `one`\nline two',
          },
        ],
      }),
      true
    );
    expect(text).toContain("→ `line 'one' line two`");
  });

  it('renders a write snippet as an indented fenced block under the completed line', () => {
    const text = renderReply(
      withExecution({
        events: [
          {
            kind: 'tool',
            tool: 'write',
            input: 'a.py',
            snippet: 'line one\nline two',
            result: 'Wrote a.py (17 bytes).',
          },
        ],
      }),
      true
    );
    expect(text).toContain('- **write** `a.py` → `Wrote a.py (17 bytes).`');
    expect(text).toContain('\n\n  ````\n  line one\n  line two\n  ````');
  });

  it('holds a snippet back until the call has its result', () => {
    // The snippet renders after the result suffix, so a pending call must not
    // emit it yet or successive renders would stop being prefix-extensions.
    const pending = renderReply(
      withExecution({
        events: [
          { kind: 'tool', tool: 'write', input: 'a.py', snippet: 'line one' },
        ],
      }),
      false
    );
    expect(pending.endsWith('- **write** `a.py`')).toBe(true);

    const settled = renderReply(
      withExecution({
        events: [
          {
            kind: 'tool',
            tool: 'write',
            input: 'a.py',
            snippet: 'line one',
            result: 'ok',
          },
        ],
      }),
      false
    );
    expect(settled.startsWith(pending)).toBe(true);
    expect(settled).toContain('  ````\n  line one\n  ````');
  });

  it('still renders the snippet when the run finished without a result', () => {
    const text = renderReply(
      withExecution({
        events: [
          { kind: 'tool', tool: 'write', input: 'a.py', snippet: 'line one' },
        ],
      }),
      true
    );
    expect(text).toContain('- **write** `a.py`\n\n  ````\n  line one\n  ````');
  });

  it('labels an empty tool result instead of rendering empty backticks', () => {
    const text = renderReply(
      withExecution({
        events: [{ kind: 'tool', tool: 'read', input: '{"path":"a.md"}', result: '' }],
      }),
      true
    );
    expect(text).toContain('→ `(no output)`');
  });

  it('renders the answer behind its header', () => {
    const reply: ReplyProgress = {
      intent: 'oneshot',
      reason: 'simple',
      answer: 'It is 4.',
    };
    expect(renderReply(reply, true)).toContain('**Answer:**\n\nIt is 4.');
  });

  it('renders nothing past the triage block until the answer starts', () => {
    const noAnswer: ReplyProgress = { intent: 'oneshot', reason: 'simple' };
    expect(renderReply(noAnswer, false)).not.toContain('**Answer:**');
  });

  it('renders growing answers as prefix-extensions of each other', () => {
    const snapshots = ['It', 'It is', 'It is 4.'];
    let previous = '';
    for (const answer of snapshots) {
      const rendered = renderReply({ intent: 'oneshot', reason: 'simple', answer }, false);
      expect(rendered.startsWith(previous)).toBe(true);
      previous = rendered;
    }
    const final = renderReply(
      { intent: 'oneshot', reason: 'simple', answer: 'It is 4.' },
      true
    );
    expect(final.startsWith(previous)).toBe(true);
  });
});

describe('module constants', () => {
  it('exposes the participant id', () => {
    expect(PARTICIPANT_ID).toBe('myDevTeam.agent');
  });
});
