import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  loadStoredApiKeys,
  setApiKey,
  secretStorageSource,
} from '../src/client/secrets';
import { __reset, __state, secrets } from './mocks/vscode';

beforeEach(() => {
  __reset();
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.GROQ_API_KEY;
});

afterEach(() => {
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.GROQ_API_KEY;
});

describe('client SecretStorage source', () => {
  it('stores a key under the provider SecretStorage key and reads it back', async () => {
    await setApiKey(secrets, 'openai', 'sk-test');
    expect(__state.secrets.get('myDevTeam.openai.apiKey')).toBe('sk-test');
    expect(secretStorageSource.apiKey('openai')).toBe('sk-test');
  });

  it('prefers a stored key over the environment variable', async () => {
    process.env.ANTHROPIC_API_KEY = 'env-key';
    await setApiKey(secrets, 'anthropic', 'stored-key');
    expect(secretStorageSource.apiKey('anthropic')).toBe('stored-key');
  });

  it('falls back to the environment variable when nothing is stored', async () => {
    // Clear any stored key from a prior test, then rely on the env fallback.
    await setApiKey(secrets, 'groq', '');
    expect(secretStorageSource.apiKey('groq')).toBeUndefined();
    process.env.GROQ_API_KEY = 'gsk-env';
    expect(secretStorageSource.apiKey('groq')).toBe('gsk-env');
  });

  it('clearing a key removes it from SecretStorage and the cache', async () => {
    await setApiKey(secrets, 'openai', 'k');
    expect(secretStorageSource.apiKey('openai')).toBe('k');
    await setApiKey(secrets, 'openai', '   ');
    expect(secretStorageSource.apiKey('openai')).toBeUndefined();
    expect(__state.secrets.has('myDevTeam.openai.apiKey')).toBe(false);
  });

  it('loads a previously-stored key into the cache on startup', async () => {
    __state.secrets.set('myDevTeam.openai.apiKey', 'persisted');
    await loadStoredApiKeys(secrets);
    expect(secretStorageSource.apiKey('openai')).toBe('persisted');
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
