import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
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
  return { markdown: vi.fn(), progress: vi.fn() };
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

/**
 * Build a real dev-team workflow over fake agents, and record the prompt the
 * triage agent receives so tests can assert on what the handler composed.
 */
function makeWorkflow(
  classify: (prompt: string) => Promise<TriageResult> = async () => ({
    intent: 'oneshot',
    reason: 'simple',
  }),
  plan: (prompt: string, onPartial?: PlanProgress) => Promise<PlanResult> = async () =>
    aPlan,
  answer: (prompt: string, onPartial?: AnswerProgress) => Promise<string> = async () =>
    'It is 4.'
) {
  const seen = { prompt: undefined as string | undefined };
  const workflow = createDevTeamWorkflow(
    {
      classify: async (prompt: string) => {
        seen.prompt = prompt;
        return classify(prompt);
      },
    } as any,
    { plan } as any,
    { answer } as any
  );
  return { workflow, seen };
}

function emitted(stream: ReturnType<typeof fakeStream>): string {
  return stream.markdown.mock.calls.map((c) => c[0]).join('');
}

describe('ChatApprover', () => {
  it('returns true only when the user picks Approve', async () => {
    const approver = new ChatApprover();
    const stream = fakeStream();
    approver.setStream(stream as any);

    __state.warningResponse = 'Approve';
    await expect(approver.confirm('Run command', '$ ls')).resolves.toBe(true);

    __state.warningResponse = undefined; // user dismissed the modal
    await expect(approver.confirm('Run command', '$ ls')).resolves.toBe(false);
  });

  it('echoes the action into the chat stream', async () => {
    const approver = new ChatApprover();
    const stream = fakeStream();
    approver.setStream(stream as any);
    __state.warningResponse = 'Approve';

    await approver.confirm('Write file', 'preview body');
    expect(stream.markdown).toHaveBeenCalledOnce();
    expect(stream.markdown.mock.calls[0][0]).toContain('**Write file**');
    expect(stream.markdown.mock.calls[0][0]).toContain('preview body');
  });

  it('still works when no stream has been attached', async () => {
    const approver = new ChatApprover();
    __state.warningResponse = 'Approve';
    await expect(approver.confirm('Run command', '$ ls')).resolves.toBe(true);
  });

  it('stops echoing into a stream after clearStream', async () => {
    const approver = new ChatApprover();
    const stream = fakeStream();
    approver.setStream(stream as any);
    approver.clearStream();
    __state.warningResponse = 'Approve';

    await expect(approver.confirm('Run command', '$ ls')).resolves.toBe(true);
    expect(stream.markdown).not.toHaveBeenCalled();
  });

  it('survives a disposed stream and still asks via the modal', async () => {
    const approver = new ChatApprover();
    const closed = {
      markdown: vi.fn(() => {
        throw new Error('stream is closed');
      }),
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
    expect(stream.progress).toHaveBeenCalledWith('Understanding your request…');
    expect(stream.progress).toHaveBeenCalledWith('Answering…');
  });

  it('renders a planning request as a numbered checklist', async () => {
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
    expect(stream.progress).toHaveBeenCalledWith('Drafting a plan…');
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

  it('inlines an attached file (Uri reference) into the prompt', async () => {
    const uri = __setFile('src/a.ts', 'file body');
    const { workflow, seen } = makeWorkflow();

    await createHandler(workflow)(
      { prompt: 'look at this', references: [{ value: uri }] } as any,
      { history: [] } as any,
      fakeStream() as any,
      fakeToken() as any
    );

    expect(seen.prompt).toContain('look at this');
    expect(seen.prompt).toContain('--- Attached context ---');
    expect(seen.prompt).toContain('File: src/a.ts');
    expect(seen.prompt).toContain('file body');
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

    expect(seen.prompt).toContain('Selection from src/b.ts (line 2)');
    expect(seen.prompt).toContain('line1');
  });

  it('inlines a plain string reference', async () => {
    const { workflow, seen } = makeWorkflow();

    await createHandler(workflow)(
      { prompt: 'q', references: [{ value: 'raw snippet' }] } as any,
      { history: [] } as any,
      fakeStream() as any,
      fakeToken() as any
    );
    expect(seen.prompt).toContain('raw snippet');
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
    expect(seen.prompt).toContain('could not read attachment');
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
    expect(seen.prompt).toContain('…(truncated)');
  });

  it('does not add an attachments block when there are no references', async () => {
    const { workflow, seen } = makeWorkflow();

    await createHandler(workflow)(
      { prompt: 'plain', references: [] } as any,
      { history: [] } as any,
      fakeStream() as any,
      fakeToken() as any
    );
    expect(seen.prompt).toBe('plain');
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
      renderReply({ intent: 'planning', reason: 'needs steps', plan: aPlan }, true)
    );
    expect(count(text, '**Plan:**')).toBe(1);
    expect(count(text, 'Find the file')).toBe(1);
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

  it('appends the plan footer only when done', () => {
    const planning = renderReply(progress(aPlan), false);
    expect(planning).not.toContain('**Next step');
    expect(renderReply(progress(aPlan), true)).toContain(
      '**Next step (not yet implemented):** execute these steps with tools.'
    );
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
