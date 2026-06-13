import { describe, it, expect } from 'vitest';
import { EvalRecord } from '../src/client/evalLog';
import {
  cacheHitRate,
  estimatedShare,
  formatTokenCount,
  rollupUsage,
  sumUsage,
} from '../src/client/usageStats';

describe('sumUsage', () => {
  it('sums a run\'s steps and counts the calls', () => {
    const summary = sumUsage([
      { step: 'triage', model: 'q', inputTokens: 10, outputTokens: 3 },
      { step: 'answer', model: 'q', inputTokens: 5, outputTokens: 40 },
    ]);
    expect(summary).toMatchObject({
      inputTokens: 15,
      outputTokens: 43,
      totalTokens: 58,
      calls: 2,
      hasEstimates: false,
    });
  });

  it('treats missing sides as zero and surfaces any estimate', () => {
    const summary = sumUsage([
      { step: 'triage', model: 'q', outputTokens: 4 },
      { step: 'answer', model: 'q', inputTokens: 2, estimated: true },
    ]);
    expect(summary).toMatchObject({
      inputTokens: 2,
      outputTokens: 4,
      totalTokens: 6,
      calls: 2,
      estimatedCalls: 1,
      hasEstimates: true,
    });
  });

  it('folds reasoning and cached-input tokens', () => {
    const summary = sumUsage([
      { step: 'plan', model: 'o', inputTokens: 100, reasoningTokens: 8, cachedInputTokens: 64 },
    ]);
    expect(summary).toMatchObject({ reasoningTokens: 8, cachedInputTokens: 64 });
  });

  it('is empty for no entries', () => {
    expect(sumUsage([])).toMatchObject({ totalTokens: 0, calls: 0, hasEstimates: false });
  });
});

describe('rollupUsage', () => {
  const records: EvalRecord[] = [
    {
      record: 'run',
      ts: '2026-06-12T10:00:00.000Z',
      runId: 'r1',
      command: 'explain',
      intent: 'oneshot',
      outcome: 'ok',
      usage: [
        { step: 'triage', model: 'qwen', inputTokens: 10, outputTokens: 2 },
        { step: 'answer', model: 'opus', inputTokens: 100, outputTokens: 50 },
      ],
    },
    {
      record: 'run',
      ts: '2026-06-13T11:00:00.000Z',
      runId: 'r2',
      command: '',
      intent: 'planning',
      outcome: 'ok',
      usage: [{ step: 'execute', model: 'opus', inputTokens: 200, outputTokens: 80, estimated: true }],
    },
    // Feedback records carry no usage and must be ignored by the rollup.
    { record: 'feedback', ts: '2026-06-13T11:05:00.000Z', kind: 'helpful', runId: 'r2' },
  ];

  it('totals across runs and ignores feedback records', () => {
    const rollup = rollupUsage(records);
    expect(rollup.runs).toBe(2);
    expect(rollup.overall).toMatchObject({
      inputTokens: 310,
      outputTokens: 132,
      totalTokens: 442,
      calls: 3,
      hasEstimates: true,
    });
  });

  it('breaks down by model, sorted by total descending', () => {
    const rollup = rollupUsage(records);
    expect(rollup.byModel.map((b) => b.key)).toEqual(['opus', 'qwen']);
    expect(rollup.byModel[0].usage).toMatchObject({ totalTokens: 430, calls: 2 });
    expect(rollup.byModel[1].usage).toMatchObject({ totalTokens: 12, calls: 1 });
  });

  it('breaks down by step, sorted by total descending', () => {
    const rollup = rollupUsage(records);
    expect(rollup.byStep.map((b) => b.key)).toEqual(['execute', 'answer', 'triage']);
    expect(rollup.byStep[0].usage).toMatchObject({ totalTokens: 280, calls: 1 });
  });

  it('tracks how many of the calls were estimated', () => {
    const rollup = rollupUsage(records);
    expect(rollup.overall.calls).toBe(3);
    expect(rollup.overall.estimatedCalls).toBe(1);
  });

  it('charges each feedback click the tokens its run spent', () => {
    const rollup = rollupUsage(records);
    // The lone 👍 is on r2 (the execute run: 200 in + 80 out = 280).
    expect(rollup.feedback.helpful).toMatchObject({ runs: 1 });
    expect(rollup.feedback.helpful.usage).toMatchObject({ totalTokens: 280 });
    expect(rollup.feedback.unhelpful.runs).toBe(0);
  });

  it('skips feedback whose run left no usage in the log', () => {
    const orphans: EvalRecord[] = [
      { record: 'feedback', ts: '2026-06-13T00:00:00.000Z', kind: 'helpful', runId: 'gone' },
      { record: 'feedback', ts: '2026-06-13T00:00:01.000Z', kind: 'unhelpful' },
    ];
    const rollup = rollupUsage(orphans);
    expect(rollup.feedback.helpful.runs).toBe(0);
    expect(rollup.feedback.unhelpful.runs).toBe(0);
  });

  it('breaks down by route, using the command then the intent', () => {
    const rollup = rollupUsage(records);
    const keys = rollup.byRoute.map((b) => b.key).sort();
    expect(keys).toEqual(['explain', 'planning']);
  });

  it('breaks down by day, sorted ascending', () => {
    const rollup = rollupUsage(records);
    expect(rollup.byDay.map((b) => b.key)).toEqual(['2026-06-12', '2026-06-13']);
  });

  it('is empty for no records', () => {
    const rollup = rollupUsage([]);
    expect(rollup.runs).toBe(0);
    expect(rollup.byModel).toEqual([]);
    expect(rollup.overall.totalTokens).toBe(0);
  });

  it('has no input-by-source when no run carried a breakdown', () => {
    expect(rollupUsage(records).inputBySource).toEqual([]);
  });
});

describe('rollupUsage input-by-source', () => {
  const withBreakdown: EvalRecord[] = [
    {
      record: 'run',
      ts: '2026-06-12T10:00:00.000Z',
      runId: 'a',
      outcome: 'ok',
      usage: [
        {
          step: 'plan',
          model: 'm',
          inputTokens: 100,
          inputBreakdown: { prompt: 10, attachments: 80, history: 10 },
        },
      ],
    },
    {
      record: 'run',
      ts: '2026-06-12T11:00:00.000Z',
      runId: 'b',
      outcome: 'ok',
      usage: [
        {
          step: 'execute',
          model: 'm',
          inputTokens: 50,
          inputBreakdown: { prompt: 5, attachments: 20, plan: 25 },
        },
      ],
    },
  ];

  it('sums each section across runs, sorted by tokens descending', () => {
    const { inputBySource } = rollupUsage(withBreakdown);
    expect(inputBySource[0]).toEqual({ source: 'attachments', tokens: 100 });
    expect(Object.fromEntries(inputBySource.map((s) => [s.source, s.tokens]))).toEqual({
      attachments: 100,
      plan: 25,
      prompt: 15,
      history: 10,
    });
  });
});

describe('cacheHitRate', () => {
  it('is cached input over total input', () => {
    const summary = sumUsage([
      { step: 'plan', model: 'o', inputTokens: 200, cachedInputTokens: 50 },
    ]);
    expect(cacheHitRate(summary)).toBeCloseTo(0.25);
  });

  it('is zero when there are no input tokens', () => {
    expect(cacheHitRate(sumUsage([]))).toBe(0);
  });
});

describe('estimatedShare', () => {
  it('is the estimated calls over all calls', () => {
    const summary = sumUsage([
      { step: 'triage', model: 'q', inputTokens: 1, estimated: true },
      { step: 'answer', model: 'q', inputTokens: 1 },
    ]);
    expect(estimatedShare(summary)).toBeCloseTo(0.5);
  });

  it('is zero when there are no calls', () => {
    expect(estimatedShare(sumUsage([]))).toBe(0);
  });
});

describe('formatTokenCount', () => {
  it('shows exact counts under 1000', () => {
    expect(formatTokenCount(0)).toBe('0');
    expect(formatTokenCount(42)).toBe('42');
    expect(formatTokenCount(999)).toBe('999');
  });

  it('uses one-decimal k and M above', () => {
    expect(formatTokenCount(1234)).toBe('1.2k');
    expect(formatTokenCount(1_500_000)).toBe('1.5M');
  });

  it('clamps negatives and non-finite to 0', () => {
    expect(formatTokenCount(-5)).toBe('0');
    expect(formatTokenCount(NaN)).toBe('0');
  });
});
