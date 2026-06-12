import { describe, it, expect } from 'vitest';
import { RequestContext } from '@mastra/core/request-context';
import {
  createDevTeamWorkflow,
  stepIds,
  replyProgressKey,
  abortSignalKey,
  triagePrompt,
  fullPrompt,
  executionPrompt,
  Attachment,
  HistoryTurn,
  DevTeamWorkflow,
  ReplyProgress,
  ReplyProgressSink,
  StepUsage,
  UsageSink,
  usageSinkKey,
} from '../src/engine/core/workflow';
import { UsageReporter } from '../src/engine/core/usage';
import { TriageResult } from '../src/engine/core/triage';
import { PartialPlan, PlanProgress, PlanResult } from '../src/engine/core/planner';
import { AnswerProgress } from '../src/engine/core/answerer';
import { ExecutionProgress, ExecutionResult, PartialExecution } from '../src/engine/core/executor';

function fakeTriage(
  impl: (prompt: string, onUsage?: UsageReporter) => Promise<TriageResult>
) {
  return { classify: impl } as any;
}

function fakePlanner(
  impl: (
    prompt: string,
    onPartial?: PlanProgress,
    onUsage?: UsageReporter
  ) => Promise<PlanResult>
) {
  return { plan: impl } as any;
}

function fakeAnswerer(
  impl: (
    prompt: string,
    onPartial?: AnswerProgress,
    onUsage?: UsageReporter
  ) => Promise<string> = async () => 'the answer'
) {
  return { answer: impl } as any;
}

function fakeExecutor(
  impl: (
    prompt: string,
    onPartial?: ExecutionProgress,
    signal?: AbortSignal,
    onUsage?: UsageReporter
  ) => Promise<ExecutionResult> = async () => anExecution
) {
  return { execute: impl } as any;
}

const aPlan: PlanResult = {
  summary: 'Add a feature',
  steps: [{ title: 'Find the file', tool: 'search', detail: 'locate it' }],
};

const anExecution: ExecutionResult = {
  events: [
    { kind: 'tool', tool: 'search', input: '{"query":"*"}', result: 'src/a.ts' },
    { kind: 'text', text: 'Done.' },
  ],
};

async function runWorkflow(workflow: DevTeamWorkflow, prompt: string) {
  const run = await workflow.createRun();
  return run.start({ inputData: { prompt } });
}

describe('dev-team workflow routing', () => {
  it('routes a oneshot request to the answerer and skips planner and executor', async () => {
    let plannerCalled = false;
    let executorCalled = false;
    const workflow = createDevTeamWorkflow(
      fakeTriage(async () => ({ intent: 'oneshot', reason: 'simple question' })),
      fakePlanner(async () => {
        plannerCalled = true;
        return aPlan;
      }),
      fakeAnswerer(async () => 'It is 4.'),
      fakeExecutor(async () => {
        executorCalled = true;
        return anExecution;
      })
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
    expect(executorCalled).toBe(false);
  });

  it('routes a planning request through the planner and the executor', async () => {
    let answererCalled = false;
    const workflow = createDevTeamWorkflow(
      fakeTriage(async () => ({ intent: 'planning', reason: 'multi-step' })),
      fakePlanner(async () => aPlan),
      fakeAnswerer(async () => {
        answererCalled = true;
        return 'unused';
      }),
      fakeExecutor()
    );

    const result = await runWorkflow(workflow, 'add a feature');

    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.result.intent).toBe('planning');
      expect(result.result.reason).toBe('multi-step');
      expect(result.result.plan).toEqual(aPlan);
      expect(result.result.execution).toEqual(anExecution);
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
      fakeAnswerer(),
      fakeExecutor()
    );

    await runWorkflow(workflow, 'refactor the module');

    expect(seen.triage).toBe('refactor the module');
    expect(seen.planner).toBe('refactor the module');
  });

  it('hands the executor the prompt plus the drafted plan', async () => {
    const seen: Record<string, string> = {};
    const workflow = createDevTeamWorkflow(
      fakeTriage(async () => ({ intent: 'planning', reason: 'x' })),
      fakePlanner(async () => aPlan),
      fakeAnswerer(),
      fakeExecutor(async (p) => {
        seen.executor = p;
        return anExecution;
      })
    );

    await runWorkflow(workflow, 'refactor the module');

    expect(seen.executor).toContain('refactor the module');
    expect(seen.executor).toContain('--- Drafted plan ---');
    expect(seen.executor).toContain('Add a feature');
    expect(seen.executor).toContain('1. Find the file (tool: search) - locate it');
  });

  it('hands the original prompt to the answerer on the oneshot path', async () => {
    const seen: Record<string, string> = {};
    const workflow = createDevTeamWorkflow(
      fakeTriage(async () => ({ intent: 'oneshot', reason: 'x' })),
      fakePlanner(async () => aPlan),
      fakeAnswerer(async (p) => {
        seen.answerer = p;
        return 'ok';
      }),
      fakeExecutor()
    );

    await runWorkflow(workflow, 'what is a closure');

    expect(seen.answerer).toBe('what is a closure');
  });

  it('gives triage attachment labels only; planner and executor the full text', async () => {
    const attachments: Attachment[] = [
      { label: 'File: src/a.ts', text: 'file body' },
    ];
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
      fakeAnswerer(),
      fakeExecutor(async (p) => {
        seen.executor = p;
        return anExecution;
      })
    );

    const run = await workflow.createRun();
    await run.start({ inputData: { prompt: 'refactor this', attachments } });

    expect(seen.triage).toContain('refactor this');
    expect(seen.triage).toContain('File: src/a.ts');
    expect(seen.triage).not.toContain('file body');
    expect(seen.planner).toContain('--- Attached context ---');
    expect(seen.planner).toContain('file body');
    expect(seen.executor).toContain('file body');
    expect(seen.executor).toContain('--- Drafted plan ---');
  });

  it('hands the conversation history to triage, planner, and executor', async () => {
    const history: HistoryTurn[] = [
      { role: 'user', text: 'create a calculator' },
      { role: 'assistant', text: 'Created calculator.py.' },
    ];
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
      fakeAnswerer(),
      fakeExecutor(async (p) => {
        seen.executor = p;
        return anExecution;
      })
    );

    const run = await workflow.createRun();
    await run.start({ inputData: { prompt: 'now rename it', history } });

    for (const prompt of [seen.triage, seen.planner, seen.executor]) {
      expect(prompt).toContain('--- Conversation so far ---');
      expect(prompt).toContain('User: create a calculator');
      expect(prompt).toContain('Assistant: Created calculator.py.');
      expect(prompt).toContain('now rename it');
    }
  });

  it('hands the conversation history to the answerer on the oneshot path', async () => {
    const history: HistoryTurn[] = [
      { role: 'user', text: 'what is a closure' },
      { role: 'assistant', text: 'A closure is a function plus its scope.' },
    ];
    const seen: Record<string, string> = {};
    const workflow = createDevTeamWorkflow(
      fakeTriage(async () => ({ intent: 'oneshot', reason: 'x' })),
      fakePlanner(async () => aPlan),
      fakeAnswerer(async (p) => {
        seen.answerer = p;
        return 'ok';
      }),
      fakeExecutor()
    );

    const run = await workflow.createRun();
    await run.start({ inputData: { prompt: 'show an example', history } });

    expect(seen.answerer).toContain('--- Conversation so far ---');
    expect(seen.answerer).toContain('User: what is a closure');
    expect(seen.answerer).toContain('show an example');
  });

  it('gives the answerer the full attachment text on the oneshot path', async () => {
    const attachments: Attachment[] = [
      { label: 'File: src/a.ts', text: 'file body' },
    ];
    const seen: Record<string, string> = {};
    const workflow = createDevTeamWorkflow(
      fakeTriage(async () => ({ intent: 'oneshot', reason: 'x' })),
      fakePlanner(async () => aPlan),
      fakeAnswerer(async (p) => {
        seen.answerer = p;
        return 'ok';
      }),
      fakeExecutor()
    );

    const run = await workflow.createRun();
    await run.start({ inputData: { prompt: 'explain this', attachments } });

    expect(seen.answerer).toContain('explain this');
    expect(seen.answerer).toContain('--- Attached context ---');
    expect(seen.answerer).toContain('file body');
  });

  it('emits a step-start event per step so the UI can show progress', async () => {
    const workflow = createDevTeamWorkflow(
      fakeTriage(async () => ({ intent: 'planning', reason: 'x' })),
      fakePlanner(async () => aPlan),
      fakeAnswerer(),
      fakeExecutor()
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
    expect(startedSteps).toContain(stepIds.execute);
  });

  it('never starts the executor step on the oneshot path', async () => {
    // The UI maps a step start onto a progress label, so an executor step
    // starting on a oneshot run would flash a wrong "Executing…" label.
    const workflow = createDevTeamWorkflow(
      fakeTriage(async () => ({ intent: 'oneshot', reason: 'x' })),
      fakePlanner(async () => aPlan),
      fakeAnswerer(),
      fakeExecutor()
    );

    const startedSteps: string[] = [];
    const run = await workflow.createRun();
    const unwatch = run.watch((event) => {
      if (event.type === 'workflow-step-start') {
        startedSteps.push(event.payload.id);
      }
    });
    await run.start({ inputData: { prompt: 'what is 2+2' } });
    unwatch();

    expect(startedSteps).toContain(stepIds.answer);
    expect(startedSteps).not.toContain(stepIds.execute);
  });
});

describe('prompt assembly', () => {
  const attachments: Attachment[] = [
    { label: 'File: src/a.ts', text: 'const a = 1;' },
    { label: 'Selection from src/b.ts (line 2)', text: 'line1' },
  ];

  const history: HistoryTurn[] = [
    { role: 'user', text: 'create a calculator' },
    { role: 'assistant', text: 'Created calculator.py with add and subtract.' },
  ];

  it('returns the bare prompt when there are no attachments and no history', () => {
    expect(triagePrompt({ prompt: 'hi' })).toBe('hi');
    expect(fullPrompt({ prompt: 'hi' })).toBe('hi');
    expect(triagePrompt({ prompt: 'hi', attachments: [], history: [] })).toBe('hi');
    expect(fullPrompt({ prompt: 'hi', attachments: [], history: [] })).toBe('hi');
  });

  it('lists attachment labels without contents for triage', () => {
    const prompt = triagePrompt({ prompt: 'refactor', attachments });
    expect(prompt).toContain('refactor');
    expect(prompt).toContain('File: src/a.ts');
    expect(prompt).toContain('Selection from src/b.ts (line 2)');
    expect(prompt).not.toContain('const a = 1;');
    expect(prompt).not.toContain('line1');
  });

  it('inlines each attachment as a labelled fenced block for the full prompt', () => {
    const prompt = fullPrompt({ prompt: 'refactor', attachments });
    expect(prompt).toContain('refactor');
    expect(prompt).toContain('--- Attached context ---');
    expect(prompt).toContain('File: src/a.ts\n```\nconst a = 1;\n```');
    expect(prompt).toContain('Selection from src/b.ts (line 2)\n```\nline1\n```');
  });

  it('prepends a delimited conversation section to the triage prompt', () => {
    const prompt = triagePrompt({ prompt: 'now rename it', history });
    expect(prompt.startsWith('--- Conversation so far ---\n')).toBe(true);
    expect(prompt).toContain('User: create a calculator');
    expect(prompt).toContain('Assistant: Created calculator.py with add and subtract.');
    // The current request follows the closed-off section.
    expect(prompt.indexOf('now rename it')).toBeGreaterThan(
      prompt.indexOf('--- End of conversation ---')
    );
  });

  it('prepends the conversation section to the full prompt, before the attachments', () => {
    const prompt = fullPrompt({ prompt: 'now rename it', attachments, history });
    expect(prompt.startsWith('--- Conversation so far ---\n')).toBe(true);
    expect(prompt).toContain('User: create a calculator');
    const conversationEnd = prompt.indexOf('--- End of conversation ---');
    expect(prompt.indexOf('now rename it')).toBeGreaterThan(conversationEnd);
    expect(prompt.indexOf('--- Attached context ---')).toBeGreaterThan(
      prompt.indexOf('now rename it')
    );
    expect(prompt).toContain('const a = 1;');
  });

  it('includes the conversation section in the execution prompt', () => {
    const plan: PlanResult = {
      summary: 'Rename it',
      steps: [{ title: 'Rename', tool: 'write', detail: 'rename the file' }],
    };
    const prompt = executionPrompt({ prompt: 'now rename it', history }, plan);
    expect(prompt).toContain('--- Conversation so far ---');
    expect(prompt).toContain('User: create a calculator');
    expect(prompt.indexOf('--- Drafted plan ---')).toBeGreaterThan(
      prompt.indexOf('--- End of conversation ---')
    );
  });

  it('appends the numbered plan with tool hints to the execution prompt', () => {
    const plan: PlanResult = {
      summary: 'Do the work',
      steps: [
        { title: 'Find the file', tool: 'search', detail: 'locate it' },
        { title: 'Think', tool: 'none', detail: 'reason about it' },
      ],
    };
    const prompt = executionPrompt({ prompt: 'refactor', attachments }, plan);
    expect(prompt).toContain('refactor');
    expect(prompt).toContain('--- Attached context ---');
    expect(prompt).toContain('const a = 1;');
    expect(prompt).toContain('--- Drafted plan ---\nDo the work\n');
    expect(prompt).toContain('1. Find the file (tool: search) - locate it');
    // "none" is a schema artifact, not a real tool; the executor must not see it.
    expect(prompt).toContain('2. Think - reason about it');
    expect(prompt).not.toContain('(tool: none)');
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
      fakeAnswerer(),
      fakeExecutor(async () => anExecution)
    );

    const seen: ReplyProgress[] = [];
    const run = await workflow.createRun();
    await run.start({
      inputData: { prompt: 'add a feature' },
      requestContext: sinkContext((progress) => seen.push(progress)),
    });

    expect(seen.slice(0, 3)).toEqual([
      { intent: 'planning', reason: 'multi-step' },
      { intent: 'planning', reason: 'multi-step', plan: partials[0] },
      { intent: 'planning', reason: 'multi-step', plan: partials[1] },
    ]);
  });

  it('streams the completed plan and every execution snapshot through the sink', async () => {
    const partials: PartialExecution[] = [
      { events: [{ kind: 'tool', tool: 'search', input: '{"query":"*"}' }] },
      {
        events: [
          { kind: 'tool', tool: 'search', input: '{"query":"*"}', result: 'src/a.ts' },
        ],
      },
    ];
    const workflow = createDevTeamWorkflow(
      fakeTriage(async () => ({ intent: 'planning', reason: 'multi-step' })),
      fakePlanner(async () => aPlan),
      fakeAnswerer(),
      fakeExecutor(async (_prompt, onPartial) => {
        for (const partial of partials) {
          onPartial?.(partial);
        }
        return anExecution;
      })
    );

    const seen: ReplyProgress[] = [];
    const run = await workflow.createRun();
    await run.start({
      inputData: { prompt: 'add a feature' },
      requestContext: sinkContext((progress) => seen.push(progress)),
    });

    const base = { intent: 'planning', reason: 'multi-step', plan: aPlan };
    expect(seen.slice(-3)).toEqual([
      base,
      { ...base, execution: partials[0] },
      { ...base, execution: partials[1] },
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
      }),
      fakeExecutor()
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
      fakeAnswerer(),
      fakeExecutor()
    );

    const result = await runWorkflow(workflow, 'add a feature');
    expect(result.status).toBe('success');
    expect(receivedCallback).toBeUndefined();
  });

  it('forwards the request-context abort signal to the executor', async () => {
    let receivedSignal: AbortSignal | undefined | 'unset' = 'unset';
    const workflow = createDevTeamWorkflow(
      fakeTriage(async () => ({ intent: 'planning', reason: 'x' })),
      fakePlanner(async () => aPlan),
      fakeAnswerer(),
      fakeExecutor(async (_prompt, _onPartial, signal) => {
        receivedSignal = signal;
        return anExecution;
      })
    );

    const controller = new AbortController();
    const requestContext = new RequestContext();
    requestContext.set(abortSignalKey, controller.signal);
    const run = await workflow.createRun();
    const result = await run.start({
      inputData: { prompt: 'add a feature' },
      requestContext,
    });

    expect(result.status).toBe('success');
    expect(receivedSignal).toBe(controller.signal);
  });

  it('hands the executor no callback when no sink was provided', async () => {
    let receivedCallback: ExecutionProgress | undefined | 'unset' = 'unset';
    const workflow = createDevTeamWorkflow(
      fakeTriage(async () => ({ intent: 'planning', reason: 'x' })),
      fakePlanner(async () => aPlan),
      fakeAnswerer(),
      fakeExecutor(async (_prompt, onPartial) => {
        receivedCallback = onPartial;
        return anExecution;
      })
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
      }),
      fakeExecutor()
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
      fakeAnswerer(),
      fakeExecutor()
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
      fakeAnswerer(),
      fakeExecutor()
    );

    const result = await runWorkflow(workflow, 'do work');

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error.message).toContain('model not found');
      expect(result.steps[stepIds.plan]?.status).toBe('failed');
    }
  });

  it('fails the run on the execute step when the executor throws', async () => {
    const workflow = createDevTeamWorkflow(
      fakeTriage(async () => ({ intent: 'planning', reason: 'needs steps' })),
      fakePlanner(async () => aPlan),
      fakeAnswerer(),
      fakeExecutor(async () => {
        throw new Error('model not found');
      })
    );

    const result = await runWorkflow(workflow, 'do work');

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error.message).toContain('model not found');
      expect(result.steps[stepIds.execute]?.status).toBe('failed');
      expect(result.steps[stepIds.plan]?.status).toBe('success');
    }
  });

  it('fails the run on the answer step when the answerer throws', async () => {
    const workflow = createDevTeamWorkflow(
      fakeTriage(async () => ({ intent: 'oneshot', reason: 'simple' })),
      fakePlanner(async () => aPlan),
      fakeAnswerer(async () => {
        throw new Error('model not found');
      }),
      fakeExecutor()
    );

    const result = await runWorkflow(workflow, 'what is 2+2');

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error.message).toContain('model not found');
      expect(result.steps[stepIds.answer]?.status).toBe('failed');
    }
  });
});

describe('dev-team workflow usage reporting', () => {
  function usageContext(sink: UsageSink) {
    const requestContext = new RequestContext();
    requestContext.set(usageSinkKey, sink);
    return requestContext;
  }

  it('tags each agent usage report with its protocol step on the planning path', async () => {
    const workflow = createDevTeamWorkflow(
      fakeTriage(async (_p, onUsage) => {
        onUsage?.({ model: 'm-triage', inputTokens: 1, outputTokens: 2 });
        return { intent: 'planning', reason: 'x' };
      }),
      fakePlanner(async (_p, _onPartial, onUsage) => {
        onUsage?.({ model: 'm-plan', inputTokens: 3, outputTokens: 4 });
        return aPlan;
      }),
      fakeAnswerer(),
      fakeExecutor(async (_p, _onPartial, _signal, onUsage) => {
        onUsage?.({ model: 'm-exec', inputTokens: 5, outputTokens: 6 });
        return anExecution;
      })
    );

    const seen: StepUsage[] = [];
    const run = await workflow.createRun();
    await run.start({
      inputData: { prompt: 'add a feature' },
      requestContext: usageContext((usage) => seen.push(usage)),
    });

    expect(seen).toEqual([
      { step: 'triage', model: 'm-triage', inputTokens: 1, outputTokens: 2 },
      { step: 'plan', model: 'm-plan', inputTokens: 3, outputTokens: 4 },
      { step: 'execute', model: 'm-exec', inputTokens: 5, outputTokens: 6 },
    ]);
  });

  it('tags the answerer report with the answer step on the oneshot path', async () => {
    const workflow = createDevTeamWorkflow(
      fakeTriage(async () => ({ intent: 'oneshot', reason: 'x' })),
      fakePlanner(async () => aPlan),
      fakeAnswerer(async (_p, _onPartial, onUsage) => {
        onUsage?.({ model: 'm-answer', inputTokens: 7 });
        return 'ok';
      }),
      fakeExecutor()
    );

    const seen: StepUsage[] = [];
    const run = await workflow.createRun();
    await run.start({
      inputData: { prompt: 'what is 2+2' },
      requestContext: usageContext((usage) => seen.push(usage)),
    });

    expect(seen).toEqual([{ step: 'answer', model: 'm-answer', inputTokens: 7 }]);
  });

  it('hands the agents no usage reporter when no sink was provided', async () => {
    let received: UsageReporter | undefined | 'unset' = 'unset';
    const workflow = createDevTeamWorkflow(
      fakeTriage(async (_p, onUsage) => {
        received = onUsage;
        return { intent: 'oneshot', reason: 'x' };
      }),
      fakePlanner(async () => aPlan),
      fakeAnswerer(),
      fakeExecutor()
    );

    const result = await runWorkflow(workflow, 'hi');
    expect(result.status).toBe('success');
    expect(received).toBeUndefined();
  });
});
