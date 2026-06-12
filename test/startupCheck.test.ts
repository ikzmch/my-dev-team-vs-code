import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { checkOllamaAtStartup, routedModels } from '../src/ui/startupCheck';
import { selectModel } from '../src/config/models';
import { agents } from '../src/config/agents';
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

describe('routedModels', () => {
  it('returns the deduplicated models the router selects for the agents', () => {
    const expected = new Set(
      Object.values(agents).map((a) => selectModel(a.capabilities).model)
    );
    expect(new Set(routedModels())).toEqual(expected);
    expect(routedModels()).toHaveLength(expected.size);
  });
});

describe('checkOllamaAtStartup', () => {
  it('probes /api/tags on the configured endpoint', async () => {
    __setConfig('myDevTeam.ollama.endpoint', 'http://gpu-box:11434');
    fetchMock.mockResolvedValue(tagsResponse(routedModels()));

    await checkOllamaAtStartup();

    expect(fetchMock).toHaveBeenCalledWith(
      'http://gpu-box:11434/api/tags',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it('stays silent when the server is up and every routed model is pulled', async () => {
    fetchMock.mockResolvedValue(tagsResponse(routedModels()));

    await checkOllamaAtStartup();

    expect(window.showWarningMessage).not.toHaveBeenCalled();
  });

  it('accepts the ":latest" alias Ollama reports for untagged pulls', async () => {
    fetchMock.mockResolvedValue(
      tagsResponse(routedModels().map((m) => `${m}:latest`))
    );

    await checkOllamaAtStartup();

    expect(window.showWarningMessage).not.toHaveBeenCalled();
  });

  it('warns with the endpoint when the server is unreachable', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    await checkOllamaAtStartup();

    expect(window.showWarningMessage).toHaveBeenCalledTimes(1);
    const warning = vi.mocked(window.showWarningMessage).mock.calls[0][0] as string;
    expect(warning).toContain(defaults.ollamaEndpoint);
    expect(warning).toContain('myDevTeam.ollama.endpoint');
  });

  it('treats a non-OK response as unreachable', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503 });

    await checkOllamaAtStartup();

    const warning = vi.mocked(window.showWarningMessage).mock.calls[0][0] as string;
    expect(warning).toContain(defaults.ollamaEndpoint);
  });

  it('warns naming exactly the models that are missing', async () => {
    const [needed, ...rest] = routedModels();
    fetchMock.mockResolvedValue(tagsResponse(rest));

    await checkOllamaAtStartup();

    expect(window.showWarningMessage).toHaveBeenCalledTimes(1);
    const warning = vi.mocked(window.showWarningMessage).mock.calls[0][0] as string;
    expect(warning).toContain(needed);
    for (const present of rest) {
      expect(warning).not.toContain(present);
    }
    expect(warning).toContain('ollama pull');
  });

  it('never throws, even on a malformed tags payload', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ models: 'nope' }) });

    await expect(checkOllamaAtStartup()).resolves.toBeUndefined();
  });
});
