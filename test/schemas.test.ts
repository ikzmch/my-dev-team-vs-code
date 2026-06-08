import { describe, it, expect } from 'vitest';
import { IntentSchema } from '../src/core/intentClassifier';
import { PlanSchema, PlanStepSchema } from '../src/core/planner';

describe('IntentSchema', () => {
  it('accepts a well-formed oneshot result', () => {
    expect(
      IntentSchema.parse({ intent: 'oneshot', reason: 'simple' })
    ).toEqual({ intent: 'oneshot', reason: 'simple' });
  });

  it('accepts the planning intent', () => {
    expect(IntentSchema.safeParse({ intent: 'planning', reason: 'x' }).success).toBe(
      true
    );
  });

  it('rejects an unknown intent value', () => {
    expect(IntentSchema.safeParse({ intent: 'chitchat', reason: 'x' }).success).toBe(
      false
    );
  });

  it('rejects a missing reason', () => {
    expect(IntentSchema.safeParse({ intent: 'oneshot' }).success).toBe(false);
  });
});

describe('PlanStepSchema', () => {
  it.each(['read', 'search', 'run', 'write', 'none'] as const)(
    'accepts the "%s" tool',
    (tool) => {
      expect(
        PlanStepSchema.safeParse({ title: 't', tool, detail: 'd' }).success
      ).toBe(true);
    }
  );

  it('rejects an unknown tool', () => {
    expect(
      PlanStepSchema.safeParse({ title: 't', tool: 'delete', detail: 'd' }).success
    ).toBe(false);
  });
});

describe('PlanSchema', () => {
  const step = { title: 't', tool: 'none' as const, detail: 'd' };

  it('accepts a minimal one-step plan', () => {
    expect(
      PlanSchema.safeParse({ summary: 's', steps: [step] }).success
    ).toBe(true);
  });

  it('rejects a plan with no steps', () => {
    expect(PlanSchema.safeParse({ summary: 's', steps: [] }).success).toBe(false);
  });

  it('rejects a plan with more than eight steps', () => {
    const steps = Array.from({ length: 9 }, () => step);
    expect(PlanSchema.safeParse({ summary: 's', steps }).success).toBe(false);
  });

  it('accepts exactly eight steps', () => {
    const steps = Array.from({ length: 8 }, () => step);
    expect(PlanSchema.safeParse({ summary: 's', steps }).success).toBe(true);
  });
});
