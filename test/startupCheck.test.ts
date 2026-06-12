import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { checkEngineAtStartup } from '../src/ui/startupCheck';
import { LocalEngine, routedModels } from '../src/engine/localEngine';
import { Engine } from '../src/protocol/engine';
import { selectModel } from '../src/engine/config/models';
import { agents } from '../src/engine/config/agents';
import { defaults } from '../src/config/settings';
import { __reset, __setConfig, window } from './mocks/vscode';

const fetchMock = vi.fn();

beforeEach(() => {
  __reset();
  fetchMock.mockReset();
  vi.mocked(window.showWarningMessage).mockClear();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A successful /api/tags response listing the given model names. */
function tagsResponse(models: string[]) {
  return {
    ok: true,
    json: async () => ({ models: models.map((name) => ({ name, model: name })) }),
  };
}

/** A LocalEngine that never constructs real agents; only the probe is used. */
function probeOnlyEngine(): LocalEngine {
  return new LocalEngine({
    triage: {} as any,
    planner: {} as any,
    answerer: {} as any,
    createExecutor: () => ({} as any),
  });
}

describe('routedModels', () => {
  it('returns the deduplicated models the router selects for the agents', () => {
    const expected = new Set(
      Object.values(agents).map((a) => selectModel(a.capabilities).model)
    );
    expect(new Set(routedModels())).toEqual(expected);
    expect(routedModels()).toHaveLength(expected.size);
  });
});

describe('LocalEngine.startupWarnings', () => {
  it('probes /api/tags on the configured endpoint', async () => {
    __setConfig('myDevTeam.ollama.endpoint', 'http://gpu-box:11434');
    fetchMock.mockResolvedValue(tagsResponse(routedModels()));

    await probeOnlyEngine().startupWarnings();

    expect(fetchMock).toHaveBeenCalledWith(
      'http://gpu-box:11434/api/tags',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it('reports nothing when the server is up and every routed model is pulled', async () => {
    fetchMock.mockResolvedValue(tagsResponse(routedModels()));
    await expect(probeOnlyEngine().startupWarnings()).resolves.toEqual([]);
  });

  it('accepts the ":latest" alias Ollama reports for untagged pulls', async () => {
    fetchMock.mockResolvedValue(
      tagsResponse(routedModels().map((m) => `${m}:latest`))
    );
    await expect(probeOnlyEngine().startupWarnings()).resolves.toEqual([]);
  });

  it('warns with the endpoint when the server is unreachable', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    const warnings = await probeOnlyEngine().startupWarnings();

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(defaults.ollamaEndpoint);
    expect(warnings[0]).toContain('myDevTeam.ollama.endpoint');
  });

  it('treats a non-OK response as unreachable', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503 });

    const warnings = await probeOnlyEngine().startupWarnings();
    expect(warnings[0]).toContain(defaults.ollamaEndpoint);
  });

  it('warns naming exactly the models that are missing', async () => {
    const [needed, ...rest] = routedModels();
    fetchMock.mockResolvedValue(tagsResponse(rest));

    const warnings = await probeOnlyEngine().startupWarnings();

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(needed);
    for (const present of rest) {
      expect(warnings[0]).not.toContain(present);
    }
    expect(warnings[0]).toContain('ollama pull');
  });

  it('never throws on a malformed tags payload; it reports unreachable', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ models: 'nope' }) });

    const warnings = await probeOnlyEngine().startupWarnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(defaults.ollamaEndpoint);
  });
});

describe('checkEngineAtStartup', () => {
  it('shows one warning message per reported warning', async () => {
    const engine: Engine = {
      kind: 'local',
      startRun: () => {
        throw new Error('not used');
      },
      startupWarnings: async () => ['warning one', 'warning two'],
    };

    await checkEngineAtStartup(engine);

    expect(window.showWarningMessage).toHaveBeenCalledTimes(2);
    expect(window.showWarningMessage).toHaveBeenCalledWith('warning one');
    expect(window.showWarningMessage).toHaveBeenCalledWith('warning two');
  });

  it('shows nothing when the engine reports no warnings', async () => {
    const engine: Engine = {
      kind: 'local',
      startRun: () => {
        throw new Error('not used');
      },
      startupWarnings: async () => [],
    };

    await checkEngineAtStartup(engine);
    expect(window.showWarningMessage).not.toHaveBeenCalled();
  });

  it('swallows a probe that rejects instead of failing activation', async () => {
    const engine: Engine = {
      kind: 'local',
      startRun: () => {
        throw new Error('not used');
      },
      startupWarnings: async () => {
        throw new Error('probe broke');
      },
    };

    await expect(checkEngineAtStartup(engine)).resolves.toBeUndefined();
    expect(window.showWarningMessage).not.toHaveBeenCalled();
  });
});
