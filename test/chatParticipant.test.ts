import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  APPROVAL_COMMAND_ID,
  ChatApprover,
  createHandler,
  renderReply,
  PARTICIPANT_ID,
} from '../src/ui/chatParticipant';
import { Reply, ReplyProgress } from '../src/protocol/types';
import { RunEvent } from '../src/protocol/events';
import {
  Engine,
  RunCancelledError,
  RunFailedError,
} from '../src/protocol/engine';
import { ToolHost } from '../src/protocol/toolContract';
import { EvalLog, EVAL_LOG_FILENAME } from '../src/client/evalLog';
import { LocalEngine } from '../src/engine/localEngine';
import { TriageResult } from '../src/engine/core/triage';
import { PartialPlan, PlanProgress, PlanResult } from '../src/engine/core/planner';
import { AnswerProgress } from '../src/engine/core/answerer';
import {
  ExecutionProgress,
  ExecutionResult,
  PartialExecution,
} from '../src/engine/core/executor';
import { settings } from '../src/config/settings';
import {
  __reset,
  __setConfig,
  __state,
  __setFile,
  ChatRequestTurn,
  ChatResponseMarkdownPart,
  ChatResponseTurn,
  Uri,
  Location,
  Position,
  Range,
  workspace,
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

/** The client-side ToolHost stub the handler passes to the engine. */
const hostStub: ToolHost = {
  tools: ['read', 'search', 'run', 'write', 'edit'],
  execute: async () => 'ok',
};

/**
 * Build a real LocalEngine over a real workflow with fake agents, and record
 * the prompt each agent receives so tests can assert on what the handler,
 * engine, and workflow composed for it. Exercising the whole chain - handler
 * -> engine -> events -> fold -> render - is the point: it proves the
 * protocol round trip renders exactly what the old direct wiring did.
 */
function makeEngine(
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
  const engine = new LocalEngine({
    triage: {
      classify: async (prompt: string) => {
        seen.triage = prompt;
        return classify(prompt);
      },
    } as any,
    planner: {
      plan: async (prompt: string, onPartial?: PlanProgress) => {
        seen.planner = prompt;
        return plan(prompt, onPartial);
      },
    } as any,
    answerer: {
      answer: async (prompt: string, onPartial?: AnswerProgress) => {
        seen.answerer = prompt;
        return answer(prompt, onPartial);
      },
    } as any,
    createExecutor: () =>
      ({
        execute: async (prompt: string, onPartial?: ExecutionProgress) => {
          seen.executor = prompt;
          return execute(prompt, onPartial);
        },
      } as any),
  });
  return { engine, seen };
}

function emitted(stream: ReturnType<typeof fakeStream>): string {
  return stream.markdown.mock.calls.map((c) => c[0]).join('');
}

describe('ChatApprover', () => {
  /**
   * Wire an approver the way activate() does: registered command plus an
   * open session for a request's stream. Returns a click(n) helper that
   * presses the n-th rendered button by invoking the registered command with
   * that button's arguments.
   */
  function wiredApprover() {
    const approver = new ChatApprover();
    const context = { subscriptions: [] as unknown[] };
    approver.register(context as any);
    const stream = fakeStream();
    const session = approver.openSession(stream as any);
    const click = (n: number) => {
      const button = stream.button.mock.calls[n][0] as {
        command: string;
        arguments: unknown[];
      };
      __state.registeredCommands.get(button.command)!(...button.arguments);
    };
    return { approver, stream, session, click, context };
  }

  it('renders the question with Approve/Decline buttons into the chat', async () => {
    const { approver, stream, click } = wiredApprover();

    const pending = approver.confirm('Run command', 'preview body');
    expect(stream.markdown).toHaveBeenCalledOnce();
    expect(stream.markdown.mock.calls[0][0]).toContain('**Run command?**');
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

    const first = approver.confirm('Run command', 'one');
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

  it('declines whatever is still pending when its session is disposed', async () => {
    const { approver, session } = wiredApprover();

    const pending = approver.confirm('Run command', 'preview');
    session.dispose(); // request ended or was cancelled
    await expect(pending).resolves.toBe(false);
  });

  it('falls back to the modal when no session is open', async () => {
    const approver = new ChatApprover();
    __state.warningResponse = 'Approve';
    await expect(approver.confirm('Run command', '$ ls')).resolves.toBe(true);

    __state.warningResponse = undefined; // user dismissed the modal
    await expect(approver.confirm('Run command', '$ ls')).resolves.toBe(false);
  });

  it('asks via the modal, not the stream, after the session is disposed', async () => {
    const { approver, stream, session } = wiredApprover();
    session.dispose();
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
    approver.openSession(closed as any);
    __state.warningResponse = 'Approve';

    await expect(approver.confirm('Run command', '$ ls')).resolves.toBe(true);
  });

  it('keeps a concurrent request\'s approval pending when another request ends', async () => {
    // Two chat turns running at once: ending one must decline only its own
    // pending approvals, and the other's buttons must still work.
    const approver = new ChatApprover();
    const context = { subscriptions: [] as unknown[] };
    approver.register(context as any);

    const streamA = fakeStream();
    const sessionA = approver.openSession(streamA as any);
    const pendingA = approver.confirm('Run command', 'a'); // rendered into A

    const streamB = fakeStream();
    const sessionB = approver.openSession(streamB as any);
    const pendingB = approver.confirm('Run command', 'b'); // rendered into B

    sessionA.dispose(); // request A finishes (or is cancelled)
    await expect(pendingA).resolves.toBe(false);

    // B's approval survived A's teardown and its Approve click still settles.
    const button = streamB.button.mock.calls[0][0] as {
      command: string;
      arguments: unknown[];
    };
    __state.registeredCommands.get(button.command)!(...button.arguments);
    await expect(pendingB).resolves.toBe(true);
    sessionB.dispose();
  });

  it('disposing a session twice is a harmless no-op', async () => {
    const { approver, session } = wiredApprover();
    const pending = approver.confirm('Run command', 'preview');
    session.dispose();
    expect(() => session.dispose()).not.toThrow();
    await expect(pending).resolves.toBe(false);
  });
});

describe('createHandler', () => {
  it('renders the detected intent and the answer for a oneshot request', async () => {
    const { engine } = makeEngine(
      async () => ({ intent: 'oneshot', reason: 'simple question' }),
      undefined,
      async () => 'It is **4**.'
    );
    const stream = fakeStream();

    await createHandler(() => engine, hostStub)(
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
    const { engine } = makeEngine(async () => ({
      intent: 'planning',
      reason: 'needs steps',
    }));
    const stream = fakeStream();

    await createHandler(() => engine, hostStub)(
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
    expect(text).toContain('**Search Files** `{"query":"*"}` → `src/a.ts`');
    expect(text).toContain('All steps are done.');
    // No custom progress label: the chat shows the standard indicator.
    expect(stream.progress).not.toHaveBeenCalled();
  });

  it('does not run the executor on a oneshot request', async () => {
    const { engine, seen } = makeEngine();

    await createHandler(() => engine, hostStub)(
      { prompt: 'what is 2+2', references: [] } as any,
      { history: [] } as any,
      fakeStream() as any,
      fakeToken() as any
    );

    expect(seen.executor).toBeUndefined();
  });

  it('hands the executor the prompt plus the drafted plan', async () => {
    const { engine, seen } = makeEngine(async () => ({
      intent: 'planning',
      reason: 'needs steps',
    }));

    await createHandler(() => engine, hostStub)(
      { prompt: 'add a feature', references: [] } as any,
      { history: [] } as any,
      fakeStream() as any,
      fakeToken() as any
    );

    expect(seen.executor).toContain('add a feature');
    expect(seen.executor).toContain('--- Drafted plan ---');
    expect(seen.executor).toContain('1. Find the file (tool: search) - locate it');
  });

  it('relays the slash command so the engine pins the route without triage', async () => {
    const { engine, seen } = makeEngine(async () => {
      throw new Error('triage must not run for a known command');
    });
    const stream = fakeStream();

    await createHandler(() => engine, hostStub)(
      { prompt: 'the tests are failing', command: 'fix', references: [] } as any,
      { history: [] } as any,
      stream as any,
      fakeToken() as any
    );

    expect(seen.triage).toBeUndefined();
    const text = emitted(stream);
    expect(text).toContain('**Detected intent:** `planning`');
    expect(text).toContain('Requested via /fix.');
    // The command's preamble briefs the planner and the executor.
    expect(seen.planner).toContain('/fix');
    expect(seen.executor).toContain('/fix');
  });

  it('renders a /plan run as the plan plus the not-executed note', async () => {
    const { engine, seen } = makeEngine();
    const stream = fakeStream();

    await createHandler(() => engine, hostStub)(
      { prompt: 'add a feature', command: 'plan', references: [] } as any,
      { history: [] } as any,
      stream as any,
      fakeToken() as any
    );

    expect(seen.executor).toBeUndefined();
    const text = emitted(stream);
    expect(text).toContain('Requested via /plan.');
    expect(text).toContain('**Plan:** Add a feature');
    expect(text).not.toContain('**Execution:**');
    expect(text).toContain('nothing was executed');
  });

  it('answers /clear on the client without starting an engine run', async () => {
    const { engine, seen } = makeEngine(async () => {
      throw new Error('no run must start for /clear');
    });
    const stream = fakeStream();

    const result = await createHandler(() => engine, hostStub)(
      { prompt: '', references: [], command: 'clear' } as any,
      { history: [] } as any,
      stream as any,
      fakeToken() as any
    );

    expect(seen.triage).toBeUndefined();
    expect(emitted(stream)).toContain('Context cleared');
    expect(emitted(stream)).not.toContain('not processed');
    const metadata = (result as any).metadata;
    expect(metadata.command).toBe('clear');
    expect(metadata.outcome).toBe('ok');
  });

  it('notes that a message typed after /clear was not processed', async () => {
    const { engine } = makeEngine();
    const stream = fakeStream();

    await createHandler(() => engine, hostStub)(
      { prompt: 'and add a feature', references: [], command: 'clear' } as any,
      { history: [] } as any,
      stream as any,
      fakeToken() as any
    );

    expect(emitted(stream)).toContain('not processed');
  });

  it('surfaces a triage failure with the Ollama hint', async () => {
    const { engine } = makeEngine(async () => {
      throw new Error('connection refused');
    });
    const stream = fakeStream();

    await createHandler(() => engine, hostStub)(
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
    const { engine } = makeEngine(
      async () => ({ intent: 'planning', reason: 'x' }),
      async () => {
        throw new Error('model not found');
      }
    );
    const stream = fakeStream();

    await createHandler(() => engine, hostStub)(
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
    const { engine } = makeEngine(
      async () => ({ intent: 'planning', reason: 'x' }),
      undefined,
      undefined,
      async () => {
        throw new Error('model not found');
      }
    );
    const stream = fakeStream();

    await createHandler(() => engine, hostStub)(
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
    const { engine } = makeEngine(
      async () => ({ intent: 'oneshot', reason: 'x' }),
      undefined,
      async () => {
        throw new Error('model not found');
      }
    );
    const stream = fakeStream();

    await createHandler(() => engine, hostStub)(
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

  it('returns the command, a run id, and the intent in the chat result metadata', async () => {
    const { engine } = makeEngine();

    const result = await createHandler(() => engine, hostStub)(
      { prompt: 'hi', references: [], command: 'explain' } as any,
      { history: [] } as any,
      fakeStream() as any,
      fakeToken() as any
    );
    const metadata = (result as any).metadata;
    expect(metadata.command).toBe('explain');
    // The run id pairs a later 👍/👎 click with this turn's eval log record.
    expect(typeof metadata.runId).toBe('string');
    expect(metadata.runId.length).toBeGreaterThan(0);
    expect(metadata.intent).toBe('oneshot');
    // The outcome is what collectHistory later trusts a /compact summary by.
    expect(metadata.outcome).toBe('ok');
  });

  it('gives the agents the workspace AGENTS.md as project instructions', async () => {
    __setFile('AGENTS.md', 'Always run the tests.');
    const { engine, seen } = makeEngine(async () => ({
      intent: 'planning',
      reason: 'needs steps',
    }));

    await createHandler(() => engine, hostStub)(
      { prompt: 'add a feature', references: [] } as any,
      { history: [] } as any,
      fakeStream() as any,
      fakeToken() as any
    );

    // Triage routes without the standing rules; the working agents get them.
    expect(seen.triage).not.toContain('Always run the tests.');
    for (const prompt of [seen.planner, seen.executor]) {
      expect(prompt).toContain('--- Project instructions (AGENTS.md) ---');
      expect(prompt).toContain('Always run the tests.');
    }
  });

  it('runs without instructions when the workspace has no AGENTS.md', async () => {
    const { engine, seen } = makeEngine();

    await createHandler(() => engine, hostStub)(
      { prompt: 'what is 2+2', references: [] } as any,
      { history: [] } as any,
      fakeStream() as any,
      fakeToken() as any
    );

    expect(seen.answerer).toBe('what is 2+2');
  });

  it('inlines an attached file (Uri reference) into the answerer prompt', async () => {
    const uri = __setFile('src/a.ts', 'file body');
    const { engine, seen } = makeEngine();

    await createHandler(() => engine, hostStub)(
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
    const { engine, seen } = makeEngine();

    await createHandler(() => engine, hostStub)(
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
    const { engine, seen } = makeEngine();

    await createHandler(() => engine, hostStub)(
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
    const { engine, seen } = makeEngine();

    await createHandler(() => engine, hostStub)(
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
    const { engine, seen } = makeEngine();

    await createHandler(() => engine, hostStub)(
      { prompt: 'q', references: [{ value: ghost }] } as any,
      { history: [] } as any,
      fakeStream() as any,
      fakeToken() as any
    );
    expect(seen.answerer).toContain('could not read attachment');
    expect(seen.triage).toContain('Unreadable attachment');
  });

  it('truncates very large attachments', async () => {
    const { engine, seen } = makeEngine();
    const huge = 'z'.repeat(25_000);

    await createHandler(() => engine, hostStub)(
      { prompt: 'q', references: [{ value: huge }] } as any,
      { history: [] } as any,
      fakeStream() as any,
      fakeToken() as any
    );
    expect(seen.answerer).toContain('…(truncated)');
  });

  it('replaces an oversized attached file with a notice, without reading it', async () => {
    // Only maxAttachmentChars survive into the prompt; a file past the read
    // cap must be answered by its stat, never pulled fully into memory.
    const uri = __setFile('huge.bin', 'x'.repeat(settings.maxAttachmentReadBytes + 1));
    const { engine, seen } = makeEngine();
    workspace.fs.readFile.mockClear();

    await createHandler(() => engine, hostStub)(
      { prompt: 'q', references: [{ value: uri }] } as any,
      { history: [] } as any,
      fakeStream() as any,
      fakeToken() as any
    );

    expect(seen.answerer).toContain('File: huge.bin');
    expect(seen.answerer).toContain('attachment skipped');
    const readPaths = workspace.fs.readFile.mock.calls.map((c) => (c[0] as Uri).path);
    expect(readPaths).not.toContain(uri.path);
  });

  it('does not add an attachments block when there are no references', async () => {
    const { engine, seen } = makeEngine();

    await createHandler(() => engine, hostStub)(
      { prompt: 'plain', references: [] } as any,
      { history: [] } as any,
      fakeStream() as any,
      fakeToken() as any
    );
    expect(seen.triage).toBe('plain');
    expect(seen.answerer).toBe('plain');
  });

  it('subscribes to cancellation and disposes the listener afterwards', async () => {
    const { engine } = makeEngine();
    const token = fakeToken();

    await createHandler(() => engine, hostStub)(
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
    const { engine } = makeEngine();
    const stream = fakeStream();

    const result = await createHandler(() => engine, hostStub)(
      { prompt: 'hi', references: [] } as any,
      { history: [] } as any,
      stream as any,
      fakeToken(true) as any
    );

    expect(stream.markdown).not.toHaveBeenCalled();
    expect((result as any).metadata.command).toBe('');
  });

  it('swallows a run failure caused by cancellation', async () => {
    const { engine } = makeEngine(async () => {
      throw new Error('aborted');
    });
    const stream = fakeStream();

    await expect(
      createHandler(() => engine, hostStub)(
        { prompt: 'hi', references: [] } as any,
        { history: [] } as any,
        stream as any,
        fakeToken(true) as any
      )
    ).resolves.toBeDefined();
    expect(stream.markdown).not.toHaveBeenCalled();
  });
});

describe('createHandler eval log recording', () => {
  const FILE = `/global/${EVAL_LOG_FILENAME}`;
  const aReply: Reply = { intent: 'oneshot', reason: 'simple', answer: 'It is 4.' };

  beforeEach(() => {
    __setConfig('myDevTeam.telemetry.evalLog', true);
    // Silence the usage log lines the scripted engines produce.
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.mocked(console.log).mockRestore();
  });

  /** An engine that emits the given events and settles with the given result. */
  function scriptedEngine(events: RunEvent[], result: Promise<Reply>): Engine {
    return {
      kind: 'local',
      startRun: (_request, client) => {
        for (const event of events) {
          client.onEvent(event);
        }
        return { result, cancel: vi.fn() };
      },
      startupWarnings: async () => [],
    };
  }

  /** The record writes are fire-and-forget; let the queued microtasks drain. */
  function flush(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
  }

  function storedRecords(): Array<Record<string, any>> {
    return (__state.files.get(FILE) ?? '')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));
  }

  it('records a successful run with its route and collected usage', async () => {
    const engine = scriptedEngine(
      [
        { type: 'triaged', intent: 'oneshot', reason: 'simple' },
        { type: 'usage', step: 'triage', model: 'qwen3:8b', inputTokens: 12, outputTokens: 3 },
        { type: 'usage', step: 'answer', model: 'qwen3:8b', outputTokens: 40 },
        { type: 'done', reply: aReply },
      ],
      Promise.resolve(aReply)
    );

    const result = await createHandler(() => engine, hostStub, new EvalLog(Uri.file('/global')))(
      { prompt: 'what is 2+2', references: [], command: 'explain' } as any,
      { history: [] } as any,
      fakeStream() as any,
      fakeToken() as any
    );
    await flush();

    const records = storedRecords();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      record: 'run',
      runId: (result as any).metadata.runId,
      command: 'explain',
      intent: 'oneshot',
      outcome: 'ok',
      usage: [
        { step: 'triage', model: 'qwen3:8b', inputTokens: 12, outputTokens: 3 },
        { step: 'answer', model: 'qwen3:8b', outputTokens: 40 },
      ],
    });
    expect(records[0].errorStep).toBeUndefined();
  });

  it('records a failed run with the failing step and the usage spent', async () => {
    const failure = new RunFailedError('plan', 'model not found', 'hint');
    const result: Promise<Reply> = Promise.reject(failure);
    result.catch(() => {}); // pre-handled; the handler attaches its own catch
    const engine = scriptedEngine(
      [
        { type: 'triaged', intent: 'planning', reason: 'needs steps' },
        { type: 'usage', step: 'triage', model: 'qwen3:8b', inputTokens: 9 },
      ],
      result
    );

    await createHandler(() => engine, hostStub, new EvalLog(Uri.file('/global')))(
      { prompt: 'do work', references: [] } as any,
      { history: [] } as any,
      fakeStream() as any,
      fakeToken() as any
    );
    await flush();

    expect(storedRecords()[0]).toMatchObject({
      record: 'run',
      intent: 'planning',
      outcome: 'error',
      errorStep: 'plan',
      usage: [{ step: 'triage', model: 'qwen3:8b', inputTokens: 9 }],
    });
  });

  it('records a cancelled run, keeping usage that was already spent', async () => {
    const result: Promise<Reply> = Promise.reject(new RunCancelledError());
    result.catch(() => {});
    const engine = scriptedEngine(
      [{ type: 'usage', step: 'triage', model: 'qwen3:8b', inputTokens: 7 }],
      result
    );

    await createHandler(() => engine, hostStub, new EvalLog(Uri.file('/global')))(
      { prompt: 'hi', references: [] } as any,
      { history: [] } as any,
      fakeStream() as any,
      fakeToken(true) as any
    );
    await flush();

    expect(storedRecords()[0]).toMatchObject({
      record: 'run',
      outcome: 'cancelled',
      usage: [{ step: 'triage', model: 'qwen3:8b', inputTokens: 7 }],
    });
  });

  it('runs without an eval log exactly as before', async () => {
    const { engine } = makeEngine();
    const stream = fakeStream();

    await createHandler(() => engine, hostStub)(
      { prompt: 'what is 2+2', references: [] } as any,
      { history: [] } as any,
      stream as any,
      fakeToken() as any
    );

    expect(emitted(stream)).toContain('It is 4.');
    expect(__state.files.has(FILE)).toBe(false);
  });
});

describe('createHandler conversation history', () => {
  /** Run the handler with the given chat history and capture the agent prompts. */
  async function handle(history: unknown[], prompt = 'now rename it too') {
    const { engine, seen } = makeEngine();
    await createHandler(() => engine, hostStub)(
      { prompt, references: [] } as any,
      { history } as any,
      fakeStream() as any,
      fakeToken() as any
    );
    return seen;
  }

  it('folds prior turns into the triage and answerer prompts', async () => {
    const seen = await handle([
      new ChatRequestTurn('create a calculator'),
      new ChatResponseTurn([new ChatResponseMarkdownPart('Created calculator.py.')]),
    ]);

    for (const prompt of [seen.triage, seen.answerer]) {
      expect(prompt).toContain('--- Conversation so far ---');
      expect(prompt).toContain('User: create a calculator');
      expect(prompt).toContain('Assistant: Created calculator.py.');
      expect(prompt).toContain('--- End of conversation ---');
      expect(prompt).toContain('now rename it too');
    }
  });

  it('sends the bare prompt when the session has no history', async () => {
    const seen = await handle([], 'plain');
    expect(seen.triage).toBe('plain');
    expect(seen.answerer).toBe('plain');
  });

  it('ignores turns addressed to other participants', async () => {
    const seen = await handle([
      new ChatRequestTurn('ask the workspace agent', undefined, 'other.agent'),
      new ChatResponseTurn(
        [new ChatResponseMarkdownPart('workspace agent reply')],
        'other.agent'
      ),
      new ChatRequestTurn('create a calculator'),
    ]);

    expect(seen.answerer).toContain('User: create a calculator');
    expect(seen.answerer).not.toContain('ask the workspace agent');
    expect(seen.answerer).not.toContain('workspace agent reply');
  });

  it('joins a response turn from its markdown parts and skips other parts', async () => {
    const seen = await handle([
      new ChatResponseTurn([
        new ChatResponseMarkdownPart('part one. '),
        { kind: 'button' }, // a non-markdown part carries no reusable text
        new ChatResponseMarkdownPart('part two.'),
      ]),
    ]);

    expect(seen.answerer).toContain('Assistant: part one. part two.');
  });

  it('skips a response turn with no markdown text', async () => {
    const seen = await handle([
      new ChatResponseTurn([{ kind: 'button' }]),
      new ChatResponseTurn([new ChatResponseMarkdownPart('  \n ')]),
    ]);

    expect(seen.answerer).not.toContain('Assistant:');
    expect(seen.answerer).not.toContain('--- Conversation so far ---');
  });

  it('restores the slash command of a prior request turn', async () => {
    const seen = await handle([new ChatRequestTurn('this function', 'explain')]);
    expect(seen.answerer).toContain('User: /explain this function');
  });

  it('keeps only the most recent turns', async () => {
    const turns = Array.from(
      { length: settings.history.maxTurns + 2 },
      (_, i) => new ChatRequestTurn(`turn ${i}`)
    );
    const seen = await handle(turns);

    expect(seen.answerer).not.toContain('User: turn 0\n');
    expect(seen.answerer).not.toContain('User: turn 1\n');
    expect(seen.answerer).toContain('User: turn 2');
    expect(seen.answerer).toContain(`User: turn ${settings.history.maxTurns + 1}`);
  });

  it('truncates an oversized turn to the per-turn cap', async () => {
    const huge = 'z'.repeat(settings.history.maxTurnChars + 100);
    const seen = await handle([new ChatRequestTurn(huge)]);

    expect(seen.answerer).toContain('…(truncated)');
    expect(seen.answerer).not.toContain('z'.repeat(settings.history.maxTurnChars + 1));
  });

  it('gives the triage agent the same conversation as the answerer', async () => {
    // Routing a follow-up needs the conversation it follows; triage only
    // omits attachment contents, not the history.
    const seen = await handle([
      new ChatRequestTurn('create a calculator'),
      new ChatResponseTurn([new ChatResponseMarkdownPart('Created calculator.py.')]),
    ]);

    expect(seen.triage).toContain('Assistant: Created calculator.py.');
  });

  /** A response turn carrying the TurnMetadata the handler stores per turn. */
  function responseTurn(
    text: string,
    metadata: { command: string; outcome?: string }
  ) {
    return new ChatResponseTurn(
      [new ChatResponseMarkdownPart(text)],
      undefined,
      { metadata: { runId: 'r', ...metadata } }
    );
  }

  it('drops everything before a /clear marker, including its confirmation', async () => {
    const seen = await handle([
      new ChatRequestTurn('create a calculator'),
      new ChatResponseTurn([new ChatResponseMarkdownPart('Created calculator.py.')]),
      new ChatRequestTurn('', 'clear'),
      responseTurn('Context cleared.', { command: 'clear', outcome: 'ok' }),
      new ChatRequestTurn('write a poem'),
    ]);

    expect(seen.answerer).toContain('User: write a poem');
    expect(seen.answerer).not.toContain('create a calculator');
    expect(seen.answerer).not.toContain('Created calculator.py.');
    expect(seen.answerer).not.toContain('Context cleared');
    expect(seen.answerer).not.toContain('/clear');
  });

  it('sends the bare prompt when /clear was the whole prior conversation', async () => {
    const seen = await handle(
      [
        new ChatRequestTurn('create a calculator'),
        new ChatRequestTurn('', 'clear'),
        responseTurn('Context cleared.', { command: 'clear', outcome: 'ok' }),
      ],
      'plain'
    );
    expect(seen.answerer).toBe('plain');
  });

  it('replaces the turns before a successful /compact with its summary', async () => {
    const seen = await handle([
      new ChatRequestTurn('create a calculator'),
      new ChatResponseTurn([new ChatResponseMarkdownPart('Created calculator.py.')]),
      new ChatRequestTurn('', 'compact'),
      responseTurn('Summary: built calculator.py with add and subtract.', {
        command: 'compact',
        outcome: 'ok',
      }),
      new ChatRequestTurn('now add multiply'),
    ]);

    // The summary stands in for the conversation it summarized...
    expect(seen.answerer).toContain(
      'Assistant: Summary: built calculator.py with add and subtract.'
    );
    expect(seen.answerer).toContain('User: now add multiply');
    // ...the summarized turns and the /compact instruction itself are gone.
    expect(seen.answerer).not.toContain('User: create a calculator');
    expect(seen.answerer).not.toContain('/compact');
  });

  it('keeps the history intact when a /compact run failed or was cancelled', async () => {
    const seen = await handle([
      new ChatRequestTurn('create a calculator'),
      new ChatResponseTurn([new ChatResponseMarkdownPart('Created calculator.py.')]),
      new ChatRequestTurn('', 'compact'),
      responseTurn('**Answerer error:** connection refused', {
        command: 'compact',
        outcome: 'error',
      }),
      new ChatRequestTurn('', 'compact'),
      responseTurn('', { command: 'compact', outcome: 'cancelled' }),
      new ChatRequestTurn('now add multiply'),
    ]);

    // The failed compact neither wiped the history nor left residue in it.
    expect(seen.answerer).toContain('User: create a calculator');
    expect(seen.answerer).toContain('Assistant: Created calculator.py.');
    expect(seen.answerer).toContain('User: now add multiply');
    expect(seen.answerer).not.toContain('connection refused');
    expect(seen.answerer).not.toContain('/compact');
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
    const { engine } = makeEngine(
      async () => ({ intent: 'planning', reason: 'needs steps' }),
      async (_prompt, onPartial) => {
        for (const partial of partials) {
          onPartial?.(partial);
        }
        return aPlan;
      }
    );
    const stream = fakeStream();

    await createHandler(() => engine, hostStub)(
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
    const { engine } = makeEngine(
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

    await createHandler(() => engine, hostStub)(
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
    const { engine } = makeEngine(
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

    await createHandler(() => engine, hostStub)(
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
    const { engine } = makeEngine(
      async () => ({ intent: 'planning', reason: 'needs steps' }),
      async (_prompt, onPartial) => {
        onPartial?.({ summary: 'B' });
        onPartial?.({ summary: 'A different summary' }); // not an extension
        return aPlan;
      }
    );
    const stream = fakeStream();

    await createHandler(() => engine, hostStub)(
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
    const { engine } = makeEngine(
      async () => ({ intent: 'planning', reason: 'needs steps' }),
      async (_prompt, onPartial) => {
        onPartial?.({ summary: 'Add a feature' });
        throw new Error('model not found');
      }
    );
    const stream = fakeStream();

    await createHandler(() => engine, hostStub)(
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
    const { engine } = makeEngine(
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

    await createHandler(() => engine, hostStub)(
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

  it('appends the not-executed note only to a finished plan-only reply', () => {
    // Finished with a plan and no transcript: the /plan path.
    expect(renderReply(progress(aPlan), true)).toContain('nothing was executed');
    // In-flight snapshots never carry the note (it would break the
    // prefix-extension property the streamer relies on)...
    expect(renderReply(progress(aPlan), false)).not.toContain('nothing was executed');
    // ...and neither does a reply whose plan was executed.
    const executed: Reply = {
      intent: 'planning',
      reason: 'needs steps',
      plan: aPlan,
      execution: anExecution,
    };
    expect(renderReply(executed, true)).not.toContain('nothing was executed');
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
    expect(text).toContain('**Search Files** `{"query":"*"}` → `src/a.ts`');
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
    expect(text.endsWith('**Run Command** `{"command":"npm test"}`')).toBe(true);
  });

  it('renders a tool call under its display name without a bullet', () => {
    const text = renderReply(
      withExecution({
        events: [{ kind: 'tool', tool: 'read', input: 'a.md', result: 'text' }],
      }),
      true
    );
    expect(text).toContain('\n\n**Read File** `a.md`');
    expect(text).not.toContain('- **Read File**');
  });

  it('falls back to the raw tool name when the registry does not know it', () => {
    const text = renderReply(
      withExecution({
        events: [{ kind: 'tool', tool: 'mystery', input: '{}', result: 'ok' }],
      }),
      true
    );
    expect(text).toContain('**mystery** `{}` → `ok`');
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

  it('renders a write snippet as a fenced block under the completed line', () => {
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
    expect(text).toContain('**Write File** `a.py` → `Wrote a.py (17 bytes).`');
    expect(text).toContain('\n\n````\nline one\nline two\n````');
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
    expect(pending.endsWith('**Write File** `a.py`')).toBe(true);

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
    expect(settled).toContain('````\nline one\n````');
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
    expect(text).toContain('**Write File** `a.py`\n\n````\nline one\n````');
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

describe('createHandler protocol envelope', () => {
  it('sends the protocol version, environment, and offered tools to the engine', async () => {
    let captured: unknown;
    const engine: Engine = {
      kind: 'local',
      startRun: (request, client) => {
        captured = request;
        client.onEvent({ type: 'triaged', intent: 'oneshot', reason: 'x' });
        const reply = { intent: 'oneshot' as const, reason: 'x', answer: 'ok' };
        client.onEvent({ type: 'done', reply });
        return { result: Promise.resolve(reply), cancel: () => {} };
      },
      startupWarnings: async () => [],
    };

    await createHandler(() => engine, hostStub)(
      { prompt: 'hi', references: [] } as any,
      { history: [] } as any,
      fakeStream() as any,
      fakeToken() as any
    );

    expect(captured).toMatchObject({
      protocolVersion: 1,
      prompt: 'hi',
      offeredTools: ['read', 'search', 'run', 'write', 'edit'],
    });
    expect((captured as { environment: object }).environment).toMatchObject({
      os: expect.any(String),
      shell: expect.any(String),
    });
  });

  it('hands the engine the ToolHost it should execute tools with', async () => {
    let receivedHost: ToolHost | undefined;
    const engine: Engine = {
      kind: 'local',
      startRun: (_request, client) => {
        receivedHost = client.toolHost;
        const reply = { intent: 'oneshot' as const, reason: 'x', answer: 'ok' };
        return { result: Promise.resolve(reply), cancel: () => {} };
      },
      startupWarnings: async () => [],
    };

    await createHandler(() => engine, hostStub)(
      { prompt: 'hi', references: [] } as any,
      { history: [] } as any,
      fakeStream() as any,
      fakeToken() as any
    );

    expect(receivedHost).toBe(hostStub);
  });
});
