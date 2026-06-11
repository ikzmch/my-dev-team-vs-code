import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  ChatApprover,
  createHandler,
  attachFollowups,
  PARTICIPANT_ID,
} from '../src/ui/chatParticipant';
import { createDevTeamWorkflow } from '../src/core/workflow';
import { TriageResult } from '../src/core/triage';
import { PlanResult } from '../src/core/planner';
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
  plan: (prompt: string) => Promise<PlanResult> = async () => aPlan
) {
  const seen = { prompt: undefined as string | undefined };
  const workflow = createDevTeamWorkflow(
    {
      classify: async (prompt: string) => {
        seen.prompt = prompt;
        return classify(prompt);
      },
    } as any,
    { plan } as any
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
});

describe('createHandler', () => {
  it('renders the detected intent for a oneshot request', async () => {
    const { workflow } = makeWorkflow(async () => ({
      intent: 'oneshot',
      reason: 'simple question',
    }));
    const stream = fakeStream();

    await createHandler(workflow)(
      { prompt: 'what is 2+2', references: [] } as any,
      { history: [] } as any,
      stream as any,
      {} as any
    );

    const text = emitted(stream);
    expect(text).toContain('**Detected intent:** `oneshot`');
    expect(text).toContain('**Reason:** simple question');
    expect(text).toContain('answer the question directly');
    expect(stream.progress).toHaveBeenCalledWith('Understanding your request…');
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
      {} as any
    );

    const text = emitted(stream);
    expect(text).toContain('**Detected intent:** `planning`');
    expect(text).toContain('**Plan:** Add a feature');
    expect(text).toContain('1. **Find the file** _(search)_ — locate it');
    // tool "none" must not render a tool suffix.
    expect(text).toContain('2. **Think** — reason about it');
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
      {} as any
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
      {} as any
    );

    const text = emitted(stream);
    expect(text).toContain('**Planner error:**');
    expect(text).toContain('model not found');
    expect(text).toContain('Ollama');
  });

  it('returns the command in the chat result metadata', async () => {
    const { workflow } = makeWorkflow();

    const result = await createHandler(workflow)(
      { prompt: 'hi', references: [], command: 'explain' } as any,
      { history: [] } as any,
      fakeStream() as any,
      {} as any
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
      {} as any
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
      {} as any
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
      {} as any
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
      {} as any
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
      {} as any
    );
    expect(seen.prompt).toContain('…(truncated)');
  });

  it('does not add an attachments block when there are no references', async () => {
    const { workflow, seen } = makeWorkflow();

    await createHandler(workflow)(
      { prompt: 'plain', references: [] } as any,
      { history: [] } as any,
      fakeStream() as any,
      {} as any
    );
    expect(seen.prompt).toBe('plain');
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
