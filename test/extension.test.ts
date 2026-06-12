import { describe, it, expect, beforeEach, vi } from 'vitest';

// Keep the agent core from touching a real model when the wired handler runs.
const { generateMock } = vi.hoisted(() => ({ generateMock: vi.fn() }));
vi.mock('@mastra/core/agent', () => ({
  Agent: class {
    generate = generateMock;
  },
}));

import { activate, deactivate } from '../src/extension';
import {
  __reset,
  __state,
  chat,
  ChatResultFeedbackKind,
} from './mocks/vscode';

// activate() fires the Ollama startup health check; stub fetch so tests never
// touch the network. The fake server reports no pulled models, which the
// check only ever turns into a warning - activation must not depend on it.
const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ models: [] }) }));
vi.stubGlobal('fetch', fetchMock);

beforeEach(() => {
  __reset();
  generateMock.mockReset();
  fetchMock.mockClear();
  vi.mocked(chat.createChatParticipant).mockClear();
});

function fakeContext() {
  return { subscriptions: [] as unknown[] };
}

describe('activate', () => {
  it('registers the four tools and creates the chat participant', () => {
    const context = fakeContext();
    activate(context as any);

    expect([...__state.registeredTools.keys()]).toHaveLength(4);
    expect(chat.createChatParticipant).toHaveBeenCalledWith(
      'myDevTeam.agent',
      expect.any(Function)
    );
    // Four tools + the participant get pushed for disposal.
    expect(context.subscriptions).toHaveLength(5);
  });

  it('fires the Ollama health check without blocking activation', () => {
    activate(fakeContext() as any);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/tags'),
      expect.anything()
    );
  });

  it('wires a feedback listener that classifies helpful vs unhelpful', () => {
    const participant = {
      followupProvider: undefined as unknown,
      onDidReceiveFeedback: vi.fn(),
      dispose: vi.fn(),
    };
    vi.mocked(chat.createChatParticipant).mockReturnValueOnce(participant as any);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    activate(fakeContext() as any);

    const feedbackCb = participant.onDidReceiveFeedback.mock.calls[0][0] as (
      fb: unknown
    ) => void;
    feedbackCb({ kind: ChatResultFeedbackKind.Helpful });
    feedbackCb({ kind: ChatResultFeedbackKind.Unhelpful });

    expect(logSpy).toHaveBeenCalledWith('[My Dev Team] feedback: helpful');
    expect(logSpy).toHaveBeenCalledWith('[My Dev Team] feedback: unhelpful');
    logSpy.mockRestore();
  });

  it('the wired handler drives the workflow and streams the reply', async () => {
    generateMock.mockResolvedValue({
      object: { intent: 'oneshot', reason: 'simple' },
    });
    const participant = {
      followupProvider: undefined as unknown,
      onDidReceiveFeedback: vi.fn(),
      dispose: vi.fn(),
    };
    vi.mocked(chat.createChatParticipant).mockReturnValueOnce(participant as any);

    activate(fakeContext() as any);
    const handler = vi.mocked(chat.createChatParticipant).mock.calls[0][1] as Function;

    const stream = { markdown: vi.fn(), progress: vi.fn() };
    await handler(
      { prompt: 'what is x', references: [] },
      { history: [] },
      stream,
      {
        isCancellationRequested: false,
        onCancellationRequested: () => ({ dispose: () => {} }),
      }
    );

    expect(stream.markdown).toHaveBeenCalled();
    const emitted = stream.markdown.mock.calls.map((c: unknown[]) => c[0]).join('');
    expect(emitted).toContain('Detected intent');
  });
});

describe('deactivate', () => {
  it('is a no-op that does not throw', () => {
    expect(() => deactivate()).not.toThrow();
  });
});
