import { describe, it, expect } from 'vitest';
import {
  PROTOCOL_VERSION,
  ReplySchema,
  RunRequestSchema,
  Reply,
} from '../src/protocol/types';
import { ReplyFolder, RunEvent } from '../src/protocol/events';
import { clientTools, clientToolNames } from '../src/protocol/toolContract';

describe('protocol schemas', () => {
  it('pins the protocol version', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });

  it('accepts a minimal run request and rejects a malformed one', () => {
    expect(() =>
      RunRequestSchema.parse({
        protocolVersion: 1,
        prompt: 'hi',
        offeredTools: ['read'],
      })
    ).not.toThrow();
    // Missing offeredTools.
    expect(() =>
      RunRequestSchema.parse({ protocolVersion: 1, prompt: 'hi' })
    ).toThrow();
    // Non-integer version.
    expect(() =>
      RunRequestSchema.parse({ protocolVersion: 1.5, prompt: 'hi', offeredTools: [] })
    ).toThrow();
  });

  it('accepts every reply shape the engine can produce', () => {
    const oneshot: Reply = { intent: 'oneshot', reason: 'r', answer: 'a' };
    const planning: Reply = {
      intent: 'planning',
      reason: 'r',
      plan: { summary: 's', steps: [{ title: 't', tool: 'read', detail: 'd' }] },
      execution: {
        events: [
          { kind: 'text', text: 'hi' },
          { kind: 'tool', tool: 'read', input: 'a.ts', result: 'ok', failed: false },
        ],
      },
    };
    expect(ReplySchema.parse(oneshot)).toEqual(oneshot);
    expect(ReplySchema.parse(planning)).toEqual(planning);
    expect(() => ReplySchema.parse({ intent: 'maybe', reason: 'r' })).toThrow();
  });

  it('validates tool inputs per the contract schemas', () => {
    expect(() => clientTools.read.inputSchema.parse({ path: 'a.ts' })).not.toThrow();
    expect(() => clientTools.read.inputSchema.parse({})).toThrow();
    expect(() =>
      clientTools.search.inputSchema.parse({ query: 'x', mode: 'glob' })
    ).not.toThrow();
    expect(() =>
      clientTools.search.inputSchema.parse({ query: 'x', mode: 'everywhere' })
    ).toThrow();
  });

  it('exposes the five tools in a stable order', () => {
    expect(clientToolNames).toEqual(['read', 'search', 'run', 'write', 'edit']);
  });

  it('requires a non-empty oldText for the edit tool', () => {
    // An empty oldText matches everywhere; the schema rejects it before the
    // implementation has to.
    expect(() =>
      clientTools.edit.inputSchema.parse({ path: 'a.ts', oldText: 'x', newText: 'y' })
    ).not.toThrow();
    expect(() =>
      clientTools.edit.inputSchema.parse({ path: 'a.ts', oldText: '', newText: 'y' })
    ).toThrow();
  });
});

describe('ReplyFolder', () => {
  it('folds a oneshot event stream back into grow-only snapshots', () => {
    const folder = new ReplyFolder();

    expect(
      folder.apply({ type: 'triaged', intent: 'oneshot', reason: 'simple' })
    ).toEqual({ intent: 'oneshot', reason: 'simple' });
    expect(folder.apply({ type: 'answer-delta', text: 'It' })).toEqual({
      intent: 'oneshot',
      reason: 'simple',
      answer: 'It',
    });
    expect(folder.apply({ type: 'answer-delta', text: ' is 4.' })).toEqual({
      intent: 'oneshot',
      reason: 'simple',
      answer: 'It is 4.',
    });
  });

  it('folds plan snapshots and indexed execution events', () => {
    const folder = new ReplyFolder();
    folder.apply({ type: 'triaged', intent: 'planning', reason: 'steps' });
    folder.apply({ type: 'plan-snapshot', plan: { summary: 'Add' } });
    const afterPlan = folder.apply({
      type: 'plan-snapshot',
      plan: { summary: 'Add a feature', steps: [{ title: 'Find' }] },
    });
    expect(afterPlan?.plan).toEqual({
      summary: 'Add a feature',
      steps: [{ title: 'Find' }],
    });

    folder.apply({
      type: 'execution-event',
      index: 0,
      event: { kind: 'tool', tool: 'search', input: '*' },
    });
    // The same index again replaces the event (the call gained its result).
    folder.apply({
      type: 'execution-event',
      index: 0,
      event: { kind: 'tool', tool: 'search', input: '*', result: 'a.ts' },
    });
    const finalProgress = folder.apply({
      type: 'execution-event',
      index: 1,
      event: { kind: 'text', text: 'Done.' },
    });

    expect(finalProgress?.execution).toEqual({
      events: [
        { kind: 'tool', tool: 'search', input: '*', result: 'a.ts' },
        { kind: 'text', text: 'Done.' },
      ],
    });
  });

  it('ignores events arriving before the triage decision', () => {
    const folder = new ReplyFolder();
    expect(folder.apply({ type: 'answer-delta', text: 'stray' })).toBeUndefined();
    expect(
      folder.apply({ type: 'plan-snapshot', plan: { summary: 's' } })
    ).toBeUndefined();
  });

  it('reports no visual change for usage and tool-call events', () => {
    const folder = new ReplyFolder();
    folder.apply({ type: 'triaged', intent: 'oneshot', reason: 'r' });
    expect(
      folder.apply({ type: 'usage', step: 'triage', inputTokens: 1 })
    ).toBeUndefined();
    expect(
      folder.apply({ type: 'tool-call', callId: '1', tool: 'read', args: {} })
    ).toBeUndefined();
    expect(
      folder.apply({ type: 'error', message: 'boom' } as RunEvent)
    ).toBeUndefined();
  });

  it('replaces the folded state with the validated reply on done', () => {
    const folder = new ReplyFolder();
    folder.apply({ type: 'triaged', intent: 'oneshot', reason: 'r' });
    folder.apply({ type: 'answer-delta', text: 'partial' });
    const reply: Reply = { intent: 'oneshot', reason: 'r', answer: 'complete' };
    expect(folder.apply({ type: 'done', reply })).toEqual(reply);
  });
});
