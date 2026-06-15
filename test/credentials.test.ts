import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  credentials,
  loadStoredApiKeys,
  setApiKey,
} from '../src/config/credentials';
import { __reset, __state, secrets } from './mocks/vscode';

beforeEach(async () => {
  __reset();
  // Each test controls the env and the cache explicitly; clear both first
  // (the in-memory cache is module state that persists across tests).
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.GROQ_API_KEY;
  await setApiKey(secrets, 'openai', '');
  await setApiKey(secrets, 'anthropic', '');
  await setApiKey(secrets, 'groq', '');
});

afterEach(() => {
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.GROQ_API_KEY;
  vi.restoreAllMocks();
});

describe('credentials', () => {
  it('falls back to the environment variable when SecretStorage holds no key', async () => {
    await loadStoredApiKeys(secrets);
    expect(credentials.has('openai')).toBe(false);
    process.env.OPENAI_API_KEY = 'env-key';
    expect(credentials.has('openai')).toBe(true);
    expect(credentials.apiKey('openai')).toBe('env-key');
  });

  it('prefers a stored key over the environment variable', async () => {
    process.env.ANTHROPIC_API_KEY = 'env-key';
    await setApiKey(secrets, 'anthropic', 'stored-key');
    expect(credentials.apiKey('anthropic')).toBe('stored-key');
    // It was persisted to SecretStorage under the provider's key.
    expect(__state.secrets.get('myDevTeam.anthropic.apiKey')).toBe('stored-key');
  });

  it('loads a previously-stored key into the cache on startup', async () => {
    __state.secrets.set('myDevTeam.openai.apiKey', 'persisted');
    await loadStoredApiKeys(secrets);
    expect(credentials.apiKey('openai')).toBe('persisted');
  });

  it('clearing a key removes it from SecretStorage and the cache', async () => {
    await setApiKey(secrets, 'openai', 'k');
    expect(credentials.has('openai')).toBe(true);
    await setApiKey(secrets, 'openai', '   ');
    expect(credentials.has('openai')).toBe(false);
    expect(__state.secrets.has('myDevTeam.openai.apiKey')).toBe(false);
  });

  it('never throws when SecretStorage reads fail', async () => {
    const failing = {
      get: vi.fn(async () => {
        throw new Error('locked');
      }),
      store: vi.fn(),
      delete: vi.fn(),
    } as any;
    await expect(loadStoredApiKeys(failing)).resolves.toBeUndefined();
  });
});
