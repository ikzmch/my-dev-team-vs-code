import { describe, it, expect } from 'vitest';
import { TriageSchema } from '../src/engine/core/triage';
import { PlanSchema, PlanStepSchema } from '../src/engine/core/planner';

describe('TriageSchema', () => {
  it('accepts a well-formed oneshot result', () => {
    expect(
      TriageSchema.parse({ intent: 'oneshot', complexity: 'simple', reason: 'simple' })
    ).toEqual({ intent: 'oneshot', complexity: 'simple', reason: 'simple' });
  });

  it('accepts the planning intent', () => {
    expect(
      TriageSchema.safeParse({ intent: 'planning', complexity: 'complex', reason: 'x' })
        .success
    ).toBe(true);
  });

  it('rejects an unknown intent value', () => {
    expect(
      TriageSchema.safeParse({ intent: 'chitchat', complexity: 'simple', reason: 'x' })
        .success
    ).toBe(false);
  });

  it('rejects an unknown complexity value', () => {
    expect(
      TriageSchema.safeParse({ intent: 'oneshot', complexity: 'trivial', reason: 'x' })
        .success
    ).toBe(false);
  });

  it('rejects a missing reason', () => {
    expect(
      TriageSchema.safeParse({ intent: 'oneshot', complexity: 'simple' }).success
    ).toBe(false);
  });

  it('requires a complexity', () => {
    expect(TriageSchema.safeParse({ intent: 'oneshot', reason: 'x' }).success).toBe(
      false
    );
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
  it('accepts a step with a title and detail', () => {
    // Plan steps no longer carry a tool label: which tool a step needs is the
    // executor's decision at run time.
    expect(PlanStepSchema.safeParse({ title: 't', detail: 'd' }).success).toBe(true);
  });

  it('requires both a title and a detail', () => {
    expect(PlanStepSchema.safeParse({ title: 't' }).success).toBe(false);
    expect(PlanStepSchema.safeParse({ detail: 'd' }).success).toBe(false);
  });

  it('describes detail as plain prose, never code', () => {
    // The description is part of what the model sees in structured-output
    // mode, so it must reinforce the planner prompt's no-code rule.
    const description = PlanStepSchema.shape.detail.description ?? '';
    expect(description).toContain('Never any code');
    expect(description).toContain('executor writes the code');
  });
});

describe('PlanSchema', () => {
  const step = { title: 't', detail: 'd' };

  it('accepts a minimal one-step plan', () => {
    expect(
      PlanSchema.safeParse({ summary: 's', steps: [step], complexity: 'simple' }).success
    ).toBe(true);
  });

  it('rejects a plan with no steps', () => {
    expect(
      PlanSchema.safeParse({ summary: 's', steps: [], complexity: 'simple' }).success
    ).toBe(false);
  });

  it('rejects a plan with more than eight steps', () => {
    const steps = Array.from({ length: 9 }, () => step);
    expect(
      PlanSchema.safeParse({ summary: 's', steps, complexity: 'simple' }).success
    ).toBe(false);
  });

  it('accepts exactly eight steps', () => {
    const steps = Array.from({ length: 8 }, () => step);
    expect(
      PlanSchema.safeParse({ summary: 's', steps, complexity: 'moderate' }).success
    ).toBe(true);
  });

  it('requires a complexity (the planner judges it)', () => {
    expect(PlanSchema.safeParse({ summary: 's', steps: [step] }).success).toBe(false);
  });

  it('rejects an unknown complexity value', () => {
    expect(
      PlanSchema.safeParse({ summary: 's', steps: [step], complexity: 'trivial' }).success
    ).toBe(false);
  });
});
