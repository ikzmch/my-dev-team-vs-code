import { describe, it, expect } from 'vitest';
import { TriageSchema } from '../src/core/triage';
import { PlanSchema, PlanStepSchema } from '../src/core/planner';

describe('TriageSchema', () => {
  it('accepts a well-formed oneshot result', () => {
    expect(
      TriageSchema.parse({ intent: 'oneshot', reason: 'simple' })
    ).toEqual({ intent: 'oneshot', reason: 'simple' });
  });

  it('accepts the planning intent', () => {
    expect(TriageSchema.safeParse({ intent: 'planning', reason: 'x' }).success).toBe(
      true
    );
  });

  it('rejects an unknown intent value', () => {
    expect(TriageSchema.safeParse({ intent: 'chitchat', reason: 'x' }).success).toBe(
      false
    );
  });

  it('rejects a missing reason', () => {
    expect(TriageSchema.safeParse({ intent: 'oneshot' }).success).toBe(false);
  });

  it('describes the intent boundary as the deliverable, file changes as planning', () => {
    // The description is part of what the model sees in structured-output
    // mode, so it must reinforce the triage prompt: any file to create or
    // modify routes to planning, even a single small one.
    const description = TriageSchema.shape.intent.description ?? '';
    expect(description).toContain('create or modify');
    expect(description).toContain('even one small file');
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

  it('describes detail as plain prose, never code', () => {
    // The description is part of what the model sees in structured-output
    // mode, so it must reinforce the planner prompt's no-code rule.
    const description = PlanStepSchema.shape.detail.description ?? '';
    expect(description).toContain('Never any code');
    expect(description).toContain('executor writes the code');
  });

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
