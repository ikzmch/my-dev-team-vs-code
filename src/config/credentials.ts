/**
 * Cloud-provider API keys, kept out of VS Code settings.json (which syncs to
 * disk and Settings Sync) on purpose. Keys live in the editor's SecretStorage:
 * `loadStoredApiKeys` reads them once at activation into the in-memory cache
 * below, and the `Set API Key` command writes them and refreshes the cache.
 * An environment variable is the fallback, so a key in `OPENAI_API_KEY` /
 * `ANTHROPIC_API_KEY` works with no setup (and tests need no SecretStorage).
 *
 * The provider wiring (engine/core/models.ts) reads these the same "single
 * source of truth, read live" way it reads the Ollama endpoint. Phase C moves
 * keys server-side behind the AuthProvider seam; until then they stay on the
 * user's machine and never travel on the protocol.
 */
import * as vscode from 'vscode';

/** The cloud providers that take an API key (Ollama is keyless and local). */
export type CloudProvider = 'openai' | 'anthropic';

/** SecretStorage keys the editor stores the API keys under. */
const SECRET_KEYS: Record<CloudProvider, string> = {
  openai: 'myDevTeam.openai.apiKey',
  anthropic: 'myDevTeam.anthropic.apiKey',
};

/** Environment-variable fallbacks, used when SecretStorage holds no key. */
const ENV_KEYS: Record<CloudProvider, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
};

const stored: Partial<Record<CloudProvider, string>> = {};

/**
 * Load any stored keys from SecretStorage into the in-memory cache. Call once
 * on activation; failures are swallowed so a SecretStorage hiccup never blocks
 * startup (the env-var fallback still applies).
 */
export async function loadStoredApiKeys(secrets: vscode.SecretStorage): Promise<void> {
  for (const provider of Object.keys(SECRET_KEYS) as CloudProvider[]) {
    try {
      const value = await secrets.get(SECRET_KEYS[provider]);
      if (value && value.trim()) {
        stored[provider] = value.trim();
      }
    } catch {
      // Leave the cache empty for this provider; the env fallback still works.
    }
  }
}

/**
 * Store (or, with an empty value, clear) a provider's key in SecretStorage and
 * refresh the in-memory cache so the next run sees it without a reload.
 */
export async function setApiKey(
  secrets: vscode.SecretStorage,
  provider: CloudProvider,
  key: string
): Promise<void> {
  const trimmed = key.trim();
  if (trimmed) {
    await secrets.store(SECRET_KEYS[provider], trimmed);
    stored[provider] = trimmed;
  } else {
    await secrets.delete(SECRET_KEYS[provider]);
    delete stored[provider];
  }
}

function keyFor(provider: CloudProvider): string | undefined {
  return stored[provider] ?? process.env[ENV_KEYS[provider]]?.trim() ?? undefined;
}

export const credentials = {
  /** The OpenAI API key (SecretStorage first, then `OPENAI_API_KEY`). */
  get openaiApiKey(): string | undefined {
    return keyFor('openai');
  },
  /** The Anthropic API key (SecretStorage first, then `ANTHROPIC_API_KEY`). */
  get anthropicApiKey(): string | undefined {
    return keyFor('anthropic');
  },
  /** Whether a usable key exists for the given cloud provider. */
  has(provider: CloudProvider): boolean {
    return keyFor(provider) !== undefined;
  },
};
