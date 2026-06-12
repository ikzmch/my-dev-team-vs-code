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

import { Triage, TriageSchema } from '../src/core/triage';
import { Planner, PlanSchema, PartialPlan } from '../src/core/planner';
import { Answerer } from '../src/core/answerer';

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
 * Fake of the MastraModelOutput the answerer consumes: a text-delta stream
 * plus the final full text.
 */
function fakeTextOutput(deltas: string[], final = deltas.join('')) {
  return {
    textStream: new ReadableStream({
      start(controller) {
        for (const delta of deltas) {
          controller.enqueue(delta);
        }
        controller.close();
      },
    }),
    text: Promise.resolve(final),
  };
}

describe('Triage', () => {
  it('returns the structured object from the model', async () => {
    generateMock.mockResolvedValue({
      object: { intent: 'oneshot', reason: 'just a question' },
    });
    const result = await new Triage().classify('what is a closure');
    expect(result).toEqual({ intent: 'oneshot', reason: 'just a question' });
  });

  it('passes the prompt and the triage schema to the model', async () => {
    generateMock.mockResolvedValue({ object: { intent: 'planning', reason: 'x' } });
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
    steps: [{ title: 'Read it', tool: 'read', detail: 'because' }],
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

  it('rejects when the final object does not match the plan schema', async () => {
    streamMock.mockResolvedValue(fakeStreamOutput([], { summary: 's', steps: [] }));
    await expect(new Planner().plan('bad')).rejects.toThrow();
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

  it('is configured with answerer instructions', async () => {
    new Answerer();
    const config = agentCtor.mock.calls[0][0] as { id: string; instructions: string };
    expect(config.id).toBe('answerer');
    expect(config.instructions).toContain('answerer');
  });
});
