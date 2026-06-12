import { describe, it, expect } from 'vitest';
import { RequestContext } from '@mastra/core/request-context';
import {
  createDevTeamWorkflow,
  stepIds,
  replyProgressKey,
  DevTeamWorkflow,
  ReplyProgress,
  ReplyProgressSink,
} from '../src/core/workflow';
import { TriageResult } from '../src/core/triage';
import { PartialPlan, PlanProgress, PlanResult } from '../src/core/planner';
import { AnswerProgress } from '../src/core/answerer';

function fakeTriage(impl: (prompt: string) => Promise<TriageResult>) {
  return { classify: impl } as any;
}

function fakePlanner(
  impl: (prompt: string, onPartial?: PlanProgress) => Promise<PlanResult>
) {
  return { plan: impl } as any;
}

function fakeAnswerer(
  impl: (prompt: string, onPartial?: AnswerProgress) => Promise<string> = async () =>
    'the answer'
) {
  return { answer: impl } as any;
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
  it('routes a oneshot request to the answerer and skips the planner', async () => {
    let plannerCalled = false;
    const workflow = createDevTeamWorkflow(
      fakeTriage(async () => ({ intent: 'oneshot', reason: 'simple question' })),
      fakePlanner(async () => {
        plannerCalled = true;
        return aPlan;
      }),
      fakeAnswerer(async () => 'It is 4.')
    );

    const result = await runWorkflow(workflow, 'what is 2+2');

    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.result).toEqual({
        intent: 'oneshot',
        reason: 'simple question',
        answer: 'It is 4.',
      });
    }
    expect(plannerCalled).toBe(false);
  });

  it('routes a planning request through the planner and skips the answerer', async () => {
    let answererCalled = false;
    const workflow = createDevTeamWorkflow(
      fakeTriage(async () => ({ intent: 'planning', reason: 'multi-step' })),
      fakePlanner(async () => aPlan),
      fakeAnswerer(async () => {
        answererCalled = true;
        return 'unused';
      })
    );

    const result = await runWorkflow(workflow, 'add a feature');

    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.result.intent).toBe('planning');
      expect(result.result.reason).toBe('multi-step');
      expect(result.result.plan).toEqual(aPlan);
      expect(result.result.answer).toBeUndefined();
    }
    expect(answererCalled).toBe(false);
  });

  it('hands the original prompt to both the triage agent and the planner', async () => {
    const seen: Record<string, string> = {};
    const workflow = createDevTeamWorkflow(
      fakeTriage(async (p) => {
        seen.triage = p;
        return { intent: 'planning', reason: 'x' };
      }),
      fakePlanner(async (p) => {
        seen.planner = p;
        return aPlan;
      }),
      fakeAnswerer()
    );

    await runWorkflow(workflow, 'refactor the module');

    expect(seen.triage).toBe('refactor the module');
    expect(seen.planner).toBe('refactor the module');
  });

  it('hands the original prompt to the answerer on the oneshot path', async () => {
    const seen: Record<string, string> = {};
    const workflow = createDevTeamWorkflow(
      fakeTriage(async () => ({ intent: 'oneshot', reason: 'x' })),
      fakePlanner(async () => aPlan),
      fakeAnswerer(async (p) => {
        seen.answerer = p;
        return 'ok';
      })
    );

    await runWorkflow(workflow, 'what is a closure');

    expect(seen.answerer).toBe('what is a closure');
  });

  it('emits a step-start event per step so the UI can show progress', async () => {
    const workflow = createDevTeamWorkflow(
      fakeTriage(async () => ({ intent: 'planning', reason: 'x' })),
      fakePlanner(async () => aPlan),
      fakeAnswerer()
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

    expect(startedSteps).toContain(stepIds.triage);
    expect(startedSteps).toContain(stepIds.plan);
  });
});

describe('dev-team workflow reply progress', () => {
  function sinkContext(sink: ReplyProgressSink) {
    const requestContext = new RequestContext();
    requestContext.set(replyProgressKey, sink);
    return requestContext;
  }

  it('streams the triage decision and every plan snapshot through the sink', async () => {
    const partials: PartialPlan[] = [
      { summary: 'Add' },
      { summary: 'Add a feature', steps: [{ title: 'Find the file' }] },
    ];
    const workflow = createDevTeamWorkflow(
      fakeTriage(async () => ({ intent: 'planning', reason: 'multi-step' })),
      fakePlanner(async (_prompt, onPartial) => {
        for (const partial of partials) {
          onPartial?.(partial);
        }
        return aPlan;
      }),
      fakeAnswerer()
    );

    const seen: ReplyProgress[] = [];
    const run = await workflow.createRun();
    await run.start({
      inputData: { prompt: 'add a feature' },
      requestContext: sinkContext((progress) => seen.push(progress)),
    });

    expect(seen).toEqual([
      { intent: 'planning', reason: 'multi-step' },
      { intent: 'planning', reason: 'multi-step', plan: partials[0] },
      { intent: 'planning', reason: 'multi-step', plan: partials[1] },
    ]);
  });

  it('streams the triage decision and every answer snapshot through the sink', async () => {
    const snapshots = ['It', 'It is', 'It is 4.'];
    const workflow = createDevTeamWorkflow(
      fakeTriage(async () => ({ intent: 'oneshot', reason: 'simple' })),
      fakePlanner(async () => aPlan),
      fakeAnswerer(async (_prompt, onPartial) => {
        for (const snapshot of snapshots) {
          onPartial?.(snapshot);
        }
        return 'It is 4.';
      })
    );

    const seen: ReplyProgress[] = [];
    const run = await workflow.createRun();
    await run.start({
      inputData: { prompt: 'what is 2+2' },
      requestContext: sinkContext((progress) => seen.push(progress)),
    });

    expect(seen).toEqual([
      { intent: 'oneshot', reason: 'simple' },
      { intent: 'oneshot', reason: 'simple', answer: 'It' },
      { intent: 'oneshot', reason: 'simple', answer: 'It is' },
      { intent: 'oneshot', reason: 'simple', answer: 'It is 4.' },
    ]);
  });

  it('hands the planner no callback when no sink was provided', async () => {
    let receivedCallback: PlanProgress | undefined | 'unset' = 'unset';
    const workflow = createDevTeamWorkflow(
      fakeTriage(async () => ({ intent: 'planning', reason: 'x' })),
      fakePlanner(async (_prompt, onPartial) => {
        receivedCallback = onPartial;
        return aPlan;
      }),
      fakeAnswerer()
    );

    const result = await runWorkflow(workflow, 'add a feature');
    expect(result.status).toBe('success');
    expect(receivedCallback).toBeUndefined();
  });

  it('hands the answerer no callback when no sink was provided', async () => {
    let receivedCallback: AnswerProgress | undefined | 'unset' = 'unset';
    const workflow = createDevTeamWorkflow(
      fakeTriage(async () => ({ intent: 'oneshot', reason: 'x' })),
      fakePlanner(async () => aPlan),
      fakeAnswerer(async (_prompt, onPartial) => {
        receivedCallback = onPartial;
        return 'ok';
      })
    );

    const result = await runWorkflow(workflow, 'what is 2+2');
    expect(result.status).toBe('success');
    expect(receivedCallback).toBeUndefined();
  });
});

describe('dev-team workflow failures', () => {
  it('fails the run on the triage step when the triage agent throws', async () => {
    const workflow = createDevTeamWorkflow(
      fakeTriage(async () => {
        throw new Error('connection refused');
      }),
      fakePlanner(async () => aPlan),
      fakeAnswerer()
    );

    const result = await runWorkflow(workflow, 'hi');

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error.message).toContain('connection refused');
      expect(result.steps[stepIds.triage]?.status).toBe('failed');
    }
  });

  it('fails the run on the plan step when the planner throws', async () => {
    const workflow = createDevTeamWorkflow(
      fakeTriage(async () => ({ intent: 'planning', reason: 'needs steps' })),
      fakePlanner(async () => {
        throw new Error('model not found');
      }),
      fakeAnswerer()
    );

    const result = await runWorkflow(workflow, 'do work');

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error.message).toContain('model not found');
      expect(result.steps[stepIds.plan]?.status).toBe('failed');
    }
  });

  it('fails the run on the answer step when the answerer throws', async () => {
    const workflow = createDevTeamWorkflow(
      fakeTriage(async () => ({ intent: 'oneshot', reason: 'simple' })),
      fakePlanner(async () => aPlan),
      fakeAnswerer(async () => {
        throw new Error('model not found');
      })
    );

    const result = await runWorkflow(workflow, 'what is 2+2');

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error.message).toContain('model not found');
      expect(result.steps[stepIds.answer]?.status).toBe('failed');
    }
  });
});
