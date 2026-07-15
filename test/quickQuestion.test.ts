import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  QUICK_QUESTION_COMMAND_ID,
  registerQuickQuestion,
} from '../src/ui/quickQuestion';
import {
  Engine,
  RunCancelledError,
  RunFailedError,
} from '../src/protocol/engine';
import { RunEvent } from '../src/protocol/events';
import { Reply, RunRequest } from '../src/protocol/types';
import { EvalLog } from '../src/client/evalLog';
import {
  __getContentProvider,
  __openTabLabels,
  __reset,
  __setInputBoxResponse,
  commands,
  Uri,
} from './mocks/vscode';

beforeEach(() => {
  __reset();
});

const answerReply = {
  intent: 'oneshot',
  reason: 'Requested via /ask.',
  answer: 'Use sorted().',
} as Reply;

/**
 * A fake engine whose run emits the given events synchronously and settles
 * with the reply (or the error). `startRun` records the request for
 * assertions.
 */
function fakeEngine(opts: {
  reply?: Reply;
  error?: unknown;
  events?: RunEvent[];
  result?: Promise<Reply>;
}) {
  const startRun = vi.fn((_request: RunRequest, client: { onEvent: (e: RunEvent) => void }) => {
    for (const event of opts.events ?? []) {
      client.onEvent(event);
    }
    return {
      result:
        opts.result ??
        (opts.error ? Promise.reject(opts.error) : Promise.resolve(opts.reply)),
      cancel: vi.fn(),
    };
  });
  const engine = {
    kind: 'local',
    startRun,
    startupWarnings: async () => [],
    listModels: async () => [],
  } as unknown as Engine;
  return { engine, startRun };
}

function fakeContext() {
  return { subscriptions: [] as unknown[] };
}

/** Register the command against the engine and return the startRun spy. */
function register(
  opts: Parameters<typeof fakeEngine>[0],
  evalLog?: EvalLog,
  onRunUsage?: (usage: readonly unknown[]) => void
) {
  const { engine, startRun } = fakeEngine(opts);
  registerQuickQuestion(
    fakeContext() as any,
    () => engine,
    evalLog,
    onRunUsage as any
  );
  return startRun;
}

/** The markdown the answer preview currently serves (via its open tab's name). */
function previewContent(): string | undefined {
  const label = __openTabLabels().find((l) => l.startsWith('Preview Quick answer'));
  if (!label) {
    return undefined;
  }
  const fileName = label.replace('Preview ', '');
  return __getContentProvider('devteam-answer')?.provideTextDocumentContent(
    Uri.from({ scheme: 'devteam-answer', path: `/${fileName}` }) as any
  );
}

describe('runQuickQuestion', () => {
  it('runs the question as the pinned /ask route with no history and no tools', async () => {
    __setInputBoxResponse('how do I sort a list in Python?');
    const startRun = register({ reply: answerReply });

    await commands.executeCommand(QUICK_QUESTION_COMMAND_ID);

    expect(startRun).toHaveBeenCalledTimes(1);
    const request = startRun.mock.calls[0][0] as RunRequest;
    expect(request.command).toBe('ask');
    expect(request.prompt).toBe('how do I sort a list in Python?');
    expect(request.offeredTools).toEqual([]);
    expect(request.history ?? []).toEqual([]);
    // The client offers no tool host capability either - the structural
    // guarantee that a side question cannot touch the workspace.
    const client = startRun.mock.calls[0][1] as { toolHost: { tools: readonly string[] } };
    expect(client.toolHost.tools).toEqual([]);
  });

  it('renders the answer into a markdown preview beside the editor', async () => {
    __setInputBoxResponse('how do I sort a list in Python?');
    register({ reply: answerReply });

    await commands.executeCommand(QUICK_QUESTION_COMMAND_ID);

    const content = previewContent();
    expect(content).toContain('# Quick answer');
    expect(content).toContain('> how do I sort a list in Python?');
    expect(content).toContain('Use sorted().');
    expect(content).not.toContain('Working');
  });

  it('streams the growing answer into the preview while the run is live', async () => {
    __setInputBoxResponse('how do I sort a list in Python?');
    let settle!: (reply: Reply) => void;
    register({
      // The folder only tracks events after the triage decision, exactly as
      // the engine emits them.
      events: [
        { type: 'triaged', intent: 'oneshot', reason: 'Requested via /ask.' },
        { type: 'answer-delta', text: 'Use ' },
      ],
      result: new Promise<Reply>((resolve) => {
        settle = resolve;
      }),
    });

    const run = commands.executeCommand(QUICK_QUESTION_COMMAND_ID);
    // The run starts after the input box's microtasks settle; once it has, the
    // events were delivered and the preview shows the partial answer and the
    // working note while the result is still pending.
    await vi.waitFor(() => {
      const streaming = previewContent();
      expect(streaming).toContain('Use ');
      expect(streaming).toContain('Working');
    });

    settle(answerReply);
    await run;
    expect(previewContent()).toContain('Use sorted().');
  });

  it('does nothing when the input box is dismissed or empty', async () => {
    for (const response of [undefined, '', '   ']) {
      __setInputBoxResponse(response);
      const startRun = register({ reply: answerReply });
      await commands.executeCommand(QUICK_QUESTION_COMMAND_ID);
      expect(startRun).not.toHaveBeenCalled();
      __reset();
    }
  });

  it('reports usage to the session counter and records the run to the eval log', async () => {
    __setInputBoxResponse('how do I sort a list in Python?');
    const usageEvent: RunEvent = {
      type: 'usage',
      step: 'answer',
      model: 'test-model',
      inputTokens: 10,
      outputTokens: 5,
    };
    const evalLog = { recordRun: vi.fn(async () => {}) };
    const onRunUsage = vi.fn();
    register({ reply: answerReply, events: [usageEvent] }, evalLog as unknown as EvalLog, onRunUsage);

    await commands.executeCommand(QUICK_QUESTION_COMMAND_ID);

    expect(onRunUsage).toHaveBeenCalledWith([
      expect.objectContaining({ step: 'answer', model: 'test-model', inputTokens: 10 }),
    ]);
    expect(evalLog.recordRun).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'ask',
        intent: 'oneshot',
        outcome: 'ok',
        usage: [expect.objectContaining({ step: 'answer' })],
      })
    );
  });

  it('renders the failure (and its hint) into the preview when the run fails', async () => {
    __setInputBoxResponse('how do I sort a list in Python?');
    const evalLog = { recordRun: vi.fn(async () => {}) };
    register(
      { error: new RunFailedError('answer', 'connection refused', 'Is Ollama running?') },
      evalLog as unknown as EvalLog
    );

    await commands.executeCommand(QUICK_QUESTION_COMMAND_ID);

    const content = previewContent();
    expect(content).toContain('The question failed:');
    expect(content).toContain('connection refused');
    expect(content).toContain('Is Ollama running?');
    expect(evalLog.recordRun).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'error', errorStep: 'answer' })
    );
  });

  it('closes the preview when the question is cancelled', async () => {
    __setInputBoxResponse('how do I sort a list in Python?');
    const evalLog = { recordRun: vi.fn(async () => {}) };
    register({ error: new RunCancelledError() }, evalLog as unknown as EvalLog);

    await commands.executeCommand(QUICK_QUESTION_COMMAND_ID);

    expect(__openTabLabels().filter((l) => l.startsWith('Preview Quick answer'))).toEqual([]);
    expect(evalLog.recordRun).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'cancelled' })
    );
  });

  it('keeps concurrent questions in separate previews', async () => {
    __setInputBoxResponse('first question?');
    register({ reply: answerReply });
    await commands.executeCommand(QUICK_QUESTION_COMMAND_ID);
    __setInputBoxResponse('second question?');
    await commands.executeCommand(QUICK_QUESTION_COMMAND_ID);

    // Two distinct tabs: the per-question id keeps them apart.
    expect(
      __openTabLabels().filter((l) => l.startsWith('Preview Quick answer'))
    ).toHaveLength(2);
  });
});
