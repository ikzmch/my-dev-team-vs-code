import { describe, it, expect } from 'vitest';
import { renderUsageReport } from '../src/ui/usageView';
import { rollupUsage } from '../src/client/usageStats';
import { EvalRecord } from '../src/client/evalLog';

const records: EvalRecord[] = [
  {
    record: 'run',
    ts: '2026-06-13T11:00:00.000Z',
    runId: 'r1',
    command: 'explain',
    intent: 'oneshot',
    outcome: 'ok',
    usage: [
      { step: 'triage', model: 'qwen', inputTokens: 10, outputTokens: 2 },
      {
        step: 'answer',
        model: 'opus',
        inputTokens: 100,
        outputTokens: 50,
        cachedInputTokens: 40,
        estimated: true,
        inputBreakdown: { prompt: 8, attachments: 80, instructions: 12 },
      },
    ],
  },
  { record: 'feedback', ts: '2026-06-13T11:01:00.000Z', kind: 'helpful', runId: 'r1' },
];

describe('renderUsageReport', () => {
  const report = renderUsageReport(rollupUsage(records));

  it('headers with the run count and the overall summary', () => {
    expect(report).toContain('# My Dev Team - token usage');
    expect(report).toContain('1 run recorded.');
    expect(report).toContain('**162** tokens');
    expect(report).toContain('2 model calls');
  });

  it('notes that the totals include estimates', () => {
    expect(report).toContain('_(includes estimates)_');
  });

  it('highlights the input/output ratio, cache hits, estimate share, and value per token', () => {
    expect(report).toContain('## Highlights');
    // 110 in / 52 out -> 2.1 : 1.
    expect(report).toContain('110 in / 52 out (2.1 : 1)');
    // 40 of 110 cached input -> 36%.
    expect(report).toContain('40 of 110 input tokens (36%)');
    // 1 of 2 calls estimated -> 50%.
    expect(report).toContain('1 of 2 calls (50%)');
    // The lone 👍 is charged r1's 162 tokens; no 👎.
    expect(report).toContain('👍 162 over 1 run (avg 162)');
    expect(report).toContain('👎 no rated runs');
  });

  it('renders the input-by-source table with friendly labels and shares', () => {
    expect(report).toContain('## Input by source (estimated)');
    // 80 of 100 estimated input tokens come from attachments -> 80%.
    expect(report).toContain('| Attachments | 80 | 80% |');
    expect(report).toContain('| Your prompt |');
    expect(report).toContain('| Project instructions |');
  });

  it('includes the run-level highlights when the records carry them', () => {
    const recs: EvalRecord[] = [
      {
        record: 'run',
        ts: '2026-06-12T10:00:00.000Z',
        runId: 'a',
        conversationId: 'c1',
        durationMs: 2000,
        outcome: 'ok',
        usage: [{ step: 'answer', model: 'm', inputTokens: 1000, outputTokens: 200 }],
      },
      {
        record: 'run',
        ts: '2026-06-12T10:05:00.000Z',
        runId: 'b',
        conversationId: 'c1',
        durationMs: 2000,
        outcome: 'ok',
        usage: [{ step: 'answer', model: 'm', inputTokens: 3000, outputTokens: 200 }],
      },
      {
        record: 'run',
        ts: '2026-06-12T11:00:00.000Z',
        runId: 'c',
        command: 'explain',
        intent: 'oneshot',
        triagePredicted: 'planning',
        durationMs: 0,
        outcome: 'ok',
        usage: [{ step: 'answer', model: 'm', inputTokens: 50, outputTokens: 50 }],
      },
    ];
    const richReport = renderUsageReport(rollupUsage(recs));
    expect(richReport).toContain('**Speed:**');
    expect(richReport).toContain('**Triage agreement:** matched the pinned route on 0 of 1');
    expect(richReport).toContain('**Context growth:** input grew from ~1.0k to ~3.0k');
  });

  it('includes the by-step, by-model, by-route, and by-day tables', () => {
    expect(report).toContain('## By step');
    expect(report).toContain('| answer |');
    expect(report).toContain('## By model');
    expect(report).toContain('| opus |');
    expect(report).toContain('## By route');
    expect(report).toContain('| explain |');
    expect(report).toContain('## By day');
    expect(report).toContain('| 2026-06-13 |');
  });
});
