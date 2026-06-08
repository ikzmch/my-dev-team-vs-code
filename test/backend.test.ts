import { describe, it, expect, beforeEach } from 'vitest';
import { StubBackend } from '../src/core/backend';
import { ChatTurn, OutputSink } from '../src/core/types';
import { IntentResult } from '../src/core/intentClassifier';
import { PlanResult } from '../src/core/planner';

/** Recording OutputSink so tests can assert on progress/markdown traffic. */
function makeSink(): OutputSink & { progressMsgs: string[]; markdownMsgs: string[] } {
  const progressMsgs: string[] = [];
  const markdownMsgs: string[] = [];
  return {
    progressMsgs,
    markdownMsgs,
    markdown: (t) => markdownMsgs.push(t),
    progress: (t) => progressMsgs.push(t),
  };
}

function fakeClassifier(impl: () => Promise<IntentResult>) {
  return { classify: impl } as any;
}

function fakePlanner(impl: () => Promise<PlanResult>) {
  return { plan: impl } as any;
}

function userHistory(content: string): ChatTurn[] {
  return [{ role: 'user', content }];
}

beforeEach(() => {});

describe('StubBackend without a classifier', () => {
  it('echoes the prompt and notes the executor is not wired', async () => {
    const backend = new StubBackend();
    const reply = await backend.reply(userHistory('hi there'), makeSink());
    expect(reply.text).toContain('**(stub backend)** You said:');
    expect(reply.text).toContain('> hi there');
    expect(reply.text).toContain('I stop after planning for now.');
    expect(reply.text).not.toContain('Detected intent');
  });

  it('uses the most recent user turn as the prompt', async () => {
    const backend = new StubBackend();
    const history: ChatTurn[] = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'second' },
    ];
    const reply = await backend.reply(history, makeSink());
    expect(reply.text).toContain('> second');
    expect(reply.text).not.toContain('> first');
  });

  it('handles an empty history with an empty prompt', async () => {
    const backend = new StubBackend();
    const reply = await backend.reply([], makeSink());
    expect(reply.text).toContain('**(stub backend)** You said:');
  });

  it('quotes multi-line prompts with markdown blockquote prefixes', async () => {
    const backend = new StubBackend();
    const reply = await backend.reply(userHistory('line1\nline2'), makeSink());
    expect(reply.text).toContain('> line1\n> line2');
  });
});

describe('StubBackend with a classifier', () => {
  it('renders the oneshot path', async () => {
    const backend = new StubBackend(
      fakeClassifier(async () => ({ intent: 'oneshot', reason: 'simple question' }))
    );
    const sink = makeSink();
    const reply = await backend.reply(userHistory('what is 2+2'), sink);

    expect(reply.text).toContain('**Detected intent:** `oneshot`');
    expect(reply.text).toContain('**Reason:** simple question');
    expect(reply.text).toContain('answer the question directly');
    expect(sink.progressMsgs).toContain('Understanding your request…');
  });

  it('falls back to a generic plan note when no planner is provided', async () => {
    const backend = new StubBackend(
      fakeClassifier(async () => ({ intent: 'planning', reason: 'multi-step' }))
    );
    const reply = await backend.reply(userHistory('refactor module'), makeSink());
    expect(reply.text).toContain('**Detected intent:** `planning`');
    expect(reply.text).toContain('draft a plan, then execute it with tools');
  });

  it('surfaces a classifier failure with the Ollama hint', async () => {
    const backend = new StubBackend(
      fakeClassifier(async () => {
        throw new Error('connection refused');
      })
    );
    const reply = await backend.reply(userHistory('hi'), makeSink());
    expect(reply.text).toContain('**Intent classifier error:** connection refused');
    expect(reply.text).toContain('Ollama');
  });
});

describe('StubBackend planning path with a planner', () => {
  const planning = fakeClassifier(async () => ({
    intent: 'planning' as const,
    reason: 'needs steps',
  }));

  it('formats a multi-step plan as a numbered checklist', async () => {
    const backend = new StubBackend(
      planning,
      fakePlanner(async () => ({
        summary: 'Add a feature',
        steps: [
          { title: 'Find the file', tool: 'search', detail: 'locate it' },
          { title: 'Think', tool: 'none', detail: 'reason about it' },
        ],
      }))
    );
    const sink = makeSink();
    const reply = await backend.reply(userHistory('add a feature'), sink);

    expect(reply.text).toContain('**Plan:** Add a feature');
    expect(reply.text).toContain('1. **Find the file** _(search)_ — locate it');
    // tool "none" must not render a tool suffix.
    expect(reply.text).toContain('2. **Think** — reason about it');
    expect(reply.text).not.toContain('Think** _(none)_');
    expect(sink.progressMsgs).toContain('Drafting a plan…');
  });

  it('surfaces a planner failure with the Ollama hint', async () => {
    const backend = new StubBackend(
      planning,
      fakePlanner(async () => {
        throw new Error('model not found');
      })
    );
    const reply = await backend.reply(userHistory('do work'), makeSink());
    expect(reply.text).toContain('**Planner error:** model not found');
    expect(reply.text).toContain('Ollama');
  });
});
