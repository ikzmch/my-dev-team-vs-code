import { describe, it, expect } from 'vitest';
import {
  createDevTeamWorkflow,
  stepIds,
  DevTeamWorkflow,
} from '../src/core/workflow';
import { IntentResult } from '../src/core/intentClassifier';
import { PlanResult } from '../src/core/planner';

function fakeClassifier(impl: (prompt: string) => Promise<IntentResult>) {
  return { classify: impl } as any;
}

function fakePlanner(impl: (prompt: string) => Promise<PlanResult>) {
  return { plan: impl } as any;
}

const aPlan: PlanResult = {
  summary: 'Add a feature',
  steps: [{ title: 'Find the file', tool: 'search', detail: 'locate it' }],
};

async function runWorkflow(workflow: DevTeamWorkflow, prompt: string) {
  const run = await workflow.createRun();
  return run.start({ inputData: { prompt } });
}

describe('dev-team workflow routing', () => {
  it('routes a oneshot request to answer-directly and skips the planner', async () => {
    let plannerCalled = false;
    const workflow = createDevTeamWorkflow(
      fakeClassifier(async () => ({ intent: 'oneshot', reason: 'simple question' })),
      fakePlanner(async () => {
        plannerCalled = true;
        return aPlan;
      })
    );

    const result = await runWorkflow(workflow, 'what is 2+2');

    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.result).toEqual({ intent: 'oneshot', reason: 'simple question' });
    }
    expect(plannerCalled).toBe(false);
  });

  it('routes a planning request through the planner and returns the plan', async () => {
    const workflow = createDevTeamWorkflow(
      fakeClassifier(async () => ({ intent: 'planning', reason: 'multi-step' })),
      fakePlanner(async () => aPlan)
    );

    const result = await runWorkflow(workflow, 'add a feature');

    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.result.intent).toBe('planning');
      expect(result.result.reason).toBe('multi-step');
      expect(result.result.plan).toEqual(aPlan);
    }
  });

  it('hands the original prompt to both the classifier and the planner', async () => {
    const seen: Record<string, string> = {};
    const workflow = createDevTeamWorkflow(
      fakeClassifier(async (p) => {
        seen.classifier = p;
        return { intent: 'planning', reason: 'x' };
      }),
      fakePlanner(async (p) => {
        seen.planner = p;
        return aPlan;
      })
    );

    await runWorkflow(workflow, 'refactor the module');

    expect(seen.classifier).toBe('refactor the module');
    expect(seen.planner).toBe('refactor the module');
  });

  it('emits a step-start event per step so the UI can show progress', async () => {
    const workflow = createDevTeamWorkflow(
      fakeClassifier(async () => ({ intent: 'planning', reason: 'x' })),
      fakePlanner(async () => aPlan)
    );

    const startedSteps: string[] = [];
    const run = await workflow.createRun();
    const unwatch = run.watch((event) => {
      if (event.type === 'workflow-step-start') {
        startedSteps.push(event.payload.id);
      }
    });
    await run.start({ inputData: { prompt: 'add a feature' } });
    unwatch();

    expect(startedSteps).toContain(stepIds.classify);
    expect(startedSteps).toContain(stepIds.plan);
  });
});

describe('dev-team workflow failures', () => {
  it('fails the run on the classify step when the classifier throws', async () => {
    const workflow = createDevTeamWorkflow(
      fakeClassifier(async () => {
        throw new Error('connection refused');
      }),
      fakePlanner(async () => aPlan)
    );

    const result = await runWorkflow(workflow, 'hi');

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error.message).toContain('connection refused');
      expect(result.steps[stepIds.classify]?.status).toBe('failed');
    }
  });

  it('fails the run on the plan step when the planner throws', async () => {
    const workflow = createDevTeamWorkflow(
      fakeClassifier(async () => ({ intent: 'planning', reason: 'needs steps' })),
      fakePlanner(async () => {
        throw new Error('model not found');
      })
    );

    const result = await runWorkflow(workflow, 'do work');

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error.message).toContain('model not found');
      expect(result.steps[stepIds.plan]?.status).toBe('failed');
    }
  });
});
