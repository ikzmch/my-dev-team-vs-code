import { describe, it, expect, beforeEach, vi } from 'vitest';

// The factory's local branch constructs the real agent set; keep Mastra from
// touching a real model.
vi.mock('@mastra/core/agent', () => ({
  Agent: class {
    generate = vi.fn();
    stream = vi.fn();
  },
}));

import { createEngineProvider } from '../src/client/engineFactory';
import { AnonymousAuthProvider } from '../src/client/auth';
import { LocalEngine } from '../src/engine/localEngine';
import { __reset, __setConfig, window } from './mocks/vscode';

beforeEach(() => {
  __reset();
  vi.mocked(window.showWarningMessage).mockClear();
});

describe('createEngineProvider', () => {
  it('returns the local engine by default and memoises it', () => {
    const getEngine = createEngineProvider();
    const first = getEngine();
    expect(first).toBeInstanceOf(LocalEngine);
    expect(first.kind).toBe('local');
    expect(getEngine()).toBe(first);
    expect(window.showWarningMessage).not.toHaveBeenCalled();
  });

  it('falls back to local with one warning while remote is unavailable', () => {
    __setConfig('myDevTeam.engine', 'remote');
    const getEngine = createEngineProvider();

    expect(getEngine().kind).toBe('local');
    getEngine();
    expect(window.showWarningMessage).toHaveBeenCalledTimes(1);
    const warning = vi.mocked(window.showWarningMessage).mock.calls[0][0] as string;
    expect(warning).toContain('myDevTeam.engine');
  });

  it('warns again only after switching away and back to remote', () => {
    const getEngine = createEngineProvider();
    __setConfig('myDevTeam.engine', 'remote');
    getEngine();
    getEngine();
    __setConfig('myDevTeam.engine', 'local');
    getEngine();
    __setConfig('myDevTeam.engine', 'remote');
    getEngine();

    expect(window.showWarningMessage).toHaveBeenCalledTimes(2);
  });
});

describe('AnonymousAuthProvider', () => {
  it('supplies the anonymous credential', async () => {
    await expect(new AnonymousAuthProvider().getCredentials()).resolves.toEqual({
      kind: 'anonymous',
    });
  });
});
