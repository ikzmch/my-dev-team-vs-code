import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  ChatApprover,
  createHandler,
  attachFollowups,
  PARTICIPANT_ID,
} from '../src/ui/chatParticipant';
import { Backend } from '../src/core/backend';
import { ChatTurn, OutputSink } from '../src/core/types';
import {
  __reset,
  __state,
  __setFile,
  Uri,
  Location,
  Position,
  Range,
  ChatRequestTurn,
  ChatResponseTurn,
  ChatResponseMarkdownPart,
} from './mocks/vscode';

beforeEach(() => {
  __reset();
});

function fakeStream() {
  return { markdown: vi.fn(), progress: vi.fn() };
}

/** Backend double that records what history/sink it received. */
function recordingBackend(text = 'RESPONSE', followups?: string[]): Backend & {
  lastHistory: ChatTurn[] | undefined;
} {
  const state = { lastHistory: undefined as ChatTurn[] | undefined };
  return {
    lastHistory: undefined,
    async reply(history: ChatTurn[], _sink: OutputSink) {
      state.lastHistory = history;
      (this as any).lastHistory = history;
      return { text, followups };
    },
  };
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
});

describe('createHandler', () => {
  it('reconstructs prior turns into neutral ChatTurn history', async () => {
    const backend = recordingBackend();
    const handler = createHandler(backend);

    const context = {
      history: [
        new ChatRequestTurn('earlier question'),
        new ChatResponseTurn([new ChatResponseMarkdownPart('earlier answer')]),
      ],
    };
    const request = { prompt: 'now', references: [] as any[], command: undefined };
    const stream = fakeStream();

    await handler(request as any, context as any, stream as any, {} as any);

    expect(backend.lastHistory).toEqual([
      { role: 'user', content: 'earlier question' },
      { role: 'assistant', content: 'earlier answer' },
      { role: 'user', content: 'now' },
    ]);
  });

  it('streams the backend reply text to the chat', async () => {
    const backend = recordingBackend('the answer');
    const handler = createHandler(backend);
    const stream = fakeStream();

    await handler(
      { prompt: 'hi', references: [] } as any,
      { history: [] } as any,
      stream as any,
      {} as any
    );
    expect(stream.markdown).toHaveBeenCalledWith('the answer');
  });

  it('returns followups in the chat result', async () => {
    const backend = recordingBackend('x', ['next?', 'or this?']);
    const handler = createHandler(backend);

    const result = await handler(
      { prompt: 'hi', references: [] } as any,
      { history: [] } as any,
      fakeStream() as any,
      {} as any
    );
    expect((result as any).followups).toEqual(['next?', 'or this?']);
    expect((result as any).metadata.command).toBe('');
  });

  it('inlines an attached file (Uri reference) into the user turn', async () => {
    const uri = __setFile('src/a.ts', 'file body');
    const backend = recordingBackend();
    const handler = createHandler(backend);

    await handler(
      { prompt: 'look at this', references: [{ value: uri }] } as any,
      { history: [] } as any,
      fakeStream() as any,
      {} as any
    );

    const last = backend.lastHistory!.at(-1)!;
    expect(last.content).toContain('look at this');
    expect(last.content).toContain('--- Attached context ---');
    expect(last.content).toContain('File: src/a.ts');
    expect(last.content).toContain('file body');
  });

  it('inlines a selection (Location reference) with its line number', async () => {
    const uri = __setFile('src/b.ts', 'line0\nline1\nline2');
    const location = new Location(uri, new Range(new Position(1, 0), new Position(1, 5)));
    const backend = recordingBackend();
    const handler = createHandler(backend);

    await handler(
      { prompt: 'explain', references: [{ value: location }] } as any,
      { history: [] } as any,
      fakeStream() as any,
      {} as any
    );

    const last = backend.lastHistory!.at(-1)!;
    expect(last.content).toContain('Selection from src/b.ts (line 2)');
    expect(last.content).toContain('line1');
  });

  it('inlines a plain string reference', async () => {
    const backend = recordingBackend();
    const handler = createHandler(backend);

    await handler(
      { prompt: 'q', references: [{ value: 'raw snippet' }] } as any,
      { history: [] } as any,
      fakeStream() as any,
      {} as any
    );
    expect(backend.lastHistory!.at(-1)!.content).toContain('raw snippet');
  });

  it('reports an unreadable attachment instead of throwing', async () => {
    const ghost = Uri.joinPath(__state.workspaceFolders![0].uri, 'ghost.ts');
    const backend = recordingBackend();
    const handler = createHandler(backend);

    await handler(
      { prompt: 'q', references: [{ value: ghost }] } as any,
      { history: [] } as any,
      fakeStream() as any,
      {} as any
    );
    expect(backend.lastHistory!.at(-1)!.content).toContain('could not read attachment');
  });

  it('truncates very large attachments', async () => {
    const backend = recordingBackend();
    const handler = createHandler(backend);
    const huge = 'z'.repeat(25_000);

    await handler(
      { prompt: 'q', references: [{ value: huge }] } as any,
      { history: [] } as any,
      fakeStream() as any,
      {} as any
    );
    expect(backend.lastHistory!.at(-1)!.content).toContain('…(truncated)');
  });

  it('does not add an attachments block when there are no references', async () => {
    const backend = recordingBackend();
    const handler = createHandler(backend);

    await handler(
      { prompt: 'plain', references: [] } as any,
      { history: [] } as any,
      fakeStream() as any,
      {} as any
    );
    expect(backend.lastHistory!.at(-1)!.content).toBe('plain');
  });
});

describe('attachFollowups', () => {
  it('maps result.followups onto prompt/label suggestion objects', () => {
    const participant: any = {};
    attachFollowups(participant);
    const out = participant.followupProvider.provideFollowups({
      followups: ['a', 'b'],
    });
    expect(out).toEqual([
      { prompt: 'a', label: 'a' },
      { prompt: 'b', label: 'b' },
    ]);
  });

  it('returns an empty array when there are no followups', () => {
    const participant: any = {};
    attachFollowups(participant);
    expect(participant.followupProvider.provideFollowups({})).toEqual([]);
  });
});

describe('module constants', () => {
  it('exposes the participant id', () => {
    expect(PARTICIPANT_ID).toBe('myDevTeam.agent');
  });
});
