import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EvalLog, EVAL_LOG_FILENAME } from '../src/client/evalLog';
import { settings } from '../src/config/settings';
import { __reset, __setConfig, __state, Uri, workspace } from './mocks/vscode';

const STORAGE = '/global';
const FILE = `${STORAGE}/${EVAL_LOG_FILENAME}`;

function makeLog(): EvalLog {
  return new EvalLog(Uri.file(STORAGE));
}

function storedLines(): Array<Record<string, unknown>> {
  const raw = __state.files.get(FILE) ?? '';
  return raw
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

beforeEach(() => {
  __reset();
  __setConfig('myDevTeam.telemetry.evalLog', true);
});

describe('EvalLog', () => {
  it('appends a run record as one JSON line with a timestamp', async () => {
    await makeLog().recordRun({
      runId: 'r1',
      command: 'explain',
      intent: 'planning',
      outcome: 'ok',
      usage: [{ step: 'triage', model: 'qwen3:8b', inputTokens: 10, outputTokens: 5 }],
    });

    const lines = storedLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      record: 'run',
      runId: 'r1',
      command: 'explain',
      intent: 'planning',
      outcome: 'ok',
      usage: [{ step: 'triage', model: 'qwen3:8b', inputTokens: 10, outputTokens: 5 }],
    });
    expect(typeof lines[0].ts).toBe('string');
    expect(Number.isNaN(Date.parse(lines[0].ts as string))).toBe(false);
  });

  it('appends feedback records after run records, preserving order', async () => {
    const log = makeLog();
    await log.recordRun({ runId: 'r1', outcome: 'ok', usage: [] });
    await log.recordFeedback({ kind: 'helpful', runId: 'r1', intent: 'oneshot' });

    const lines = storedLines();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ record: 'run', runId: 'r1' });
    expect(lines[1]).toMatchObject({
      record: 'feedback',
      kind: 'helpful',
      runId: 'r1',
      intent: 'oneshot',
    });
  });

  it('stores nothing when the opt-in setting is off (the default)', async () => {
    __setConfig('myDevTeam.telemetry.evalLog', false);
    await makeLog().recordRun({ runId: 'r1', outcome: 'ok', usage: [] });
    expect(__state.files.has(FILE)).toBe(false);

    // A truthy non-boolean is not an opt-in either.
    __setConfig('myDevTeam.telemetry.evalLog', 'yes');
    await makeLog().recordFeedback({ kind: 'helpful' });
    expect(__state.files.has(FILE)).toBe(false);
  });

  it('creates the storage directory before writing', async () => {
    await makeLog().recordRun({ runId: 'r1', outcome: 'ok', usage: [] });
    expect(workspace.fs.createDirectory).toHaveBeenCalledWith(
      expect.objectContaining({ path: STORAGE })
    );
  });

  it('drops the oldest whole lines once the file exceeds the cap', async () => {
    const cap = settings.telemetry.evalLogMaxChars;
    const filler = JSON.stringify({ record: 'run', pad: 'x'.repeat(1_000) }) + '\n';
    const oldest = JSON.stringify({ record: 'run', runId: 'oldest' }) + '\n';
    __state.files.set(FILE, oldest + filler.repeat(Math.ceil(cap / filler.length)));

    await makeLog().recordRun({ runId: 'newest', outcome: 'ok', usage: [] });

    const raw = __state.files.get(FILE)!;
    expect(raw.length).toBeLessThanOrEqual(cap);
    expect(raw).not.toContain('oldest');
    expect(raw.endsWith('\n')).toBe(true);
    const lines = storedLines();
    // Trimming cut whole lines: every survivor still parses, newest included.
    expect(lines[lines.length - 1]).toMatchObject({ record: 'run', runId: 'newest' });
  });

  it('swallows a write failure and keeps recording afterwards', async () => {
    vi.mocked(workspace.fs.writeFile).mockRejectedValueOnce(new Error('disk full'));
    const log = makeLog();

    await expect(
      log.recordRun({ runId: 'lost', outcome: 'ok', usage: [] })
    ).resolves.toBeUndefined();
    await log.recordRun({ runId: 'kept', outcome: 'ok', usage: [] });

    const lines = storedLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ runId: 'kept' });
  });

  it('serializes concurrent appends so no record is lost', async () => {
    const log = makeLog();
    await Promise.all([
      log.recordRun({ runId: 'a', outcome: 'ok', usage: [] }),
      log.recordRun({ runId: 'b', outcome: 'ok', usage: [] }),
      log.recordFeedback({ kind: 'unhelpful', runId: 'a' }),
    ]);

    const lines = storedLines();
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => l.runId)).toEqual(['a', 'b', 'a']);
  });
});
