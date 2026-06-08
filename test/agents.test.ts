import { describe, it, expect, beforeEach, vi } from 'vitest';

// Replace the Mastra Agent with a fake whose `generate` we control, so these
// tests never construct a real model or hit Ollama.
const { generateMock, agentCtor } = vi.hoisted(() => ({
  generateMock: vi.fn(),
  agentCtor: vi.fn(),
}));

vi.mock('@mastra/core/agent', () => ({
  Agent: class {
    generate = generateMock;
    constructor(config: unknown) {
      agentCtor(config);
    }
  },
}));

import { IntentClassifier, IntentSchema } from '../src/core/intentClassifier';
import { Planner, PlanSchema } from '../src/core/planner';

beforeEach(() => {
  generateMock.mockReset();
  agentCtor.mockReset();
});

describe('IntentClassifier', () => {
  it('returns the structured object from the model', async () => {
    generateMock.mockResolvedValue({
      object: { intent: 'oneshot', reason: 'just a question' },
    });
    const result = await new IntentClassifier().classify('what is a closure');
    expect(result).toEqual({ intent: 'oneshot', reason: 'just a question' });
  });

  it('passes the prompt and the intent schema to the model', async () => {
    generateMock.mockResolvedValue({ object: { intent: 'planning', reason: 'x' } });
    await new IntentClassifier().classify('refactor this');

    const [messages, options] = generateMock.mock.calls[0];
    expect(messages).toEqual([{ role: 'user', content: 'refactor this' }]);
    expect(options).toEqual({ structuredOutput: { schema: IntentSchema } });
  });

  it('is configured with intent-classifier instructions', async () => {
    new IntentClassifier();
    const config = agentCtor.mock.calls[0][0] as { id: string; instructions: string };
    expect(config.id).toBe('intent-classifier');
    expect(config.instructions).toContain('intent classifier');
  });
});

describe('Planner', () => {
  it('returns the structured plan from the model', async () => {
    const plan = {
      summary: 'do the thing',
      steps: [{ title: 'Read it', tool: 'read', detail: 'because' }],
    };
    generateMock.mockResolvedValue({ object: plan });
    await expect(new Planner().plan('do the thing')).resolves.toEqual(plan);
  });

  it('passes the prompt and the plan schema to the model', async () => {
    generateMock.mockResolvedValue({
      object: { summary: 's', steps: [{ title: 't', tool: 'none', detail: 'd' }] },
    });
    await new Planner().plan('build a feature');

    const [messages, options] = generateMock.mock.calls[0];
    expect(messages).toEqual([{ role: 'user', content: 'build a feature' }]);
    expect(options).toEqual({ structuredOutput: { schema: PlanSchema } });
  });
});
