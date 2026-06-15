/**
 * Cloud-provider API keys, kept out of VS Code settings.json (which syncs to
 * disk and Settings Sync) on purpose. Keys live in the editor's SecretStorage:
 * `loadStoredApiKeys` reads them once at activation into the in-memory cache
 * below, and the `Set API Key` command writes them and refreshes the cache.
 * An environment variable is the fallback, so a key in `OPENAI_API_KEY` /
 * `ANTHROPIC_API_KEY` / `GROQ_API_KEY` works with no setup (and tests need no
 * SecretStorage).
 *
 * Which providers take a key, and the SecretStorage / env-var names per
 * provider, all derive from the single provider registry (config/providers.ts):
 * a cloud provider is any descriptor that is not keyless. The provider wiring
 * (engine/core/models.ts) reads these the same "single source of truth, read
 * live" way it reads the Ollama endpoint. Phase C moves keys server-side behind
 * the AuthProvider seam; until then they stay on the user's machine and never
 * travel on the protocol.
 */
import * as vscode from 'vscode';
import {
  cloudProviderDescriptors,
  ProviderDescriptor,
  ProviderName,
} from './providers';

/** The cloud providers that take an API key (Ollama is keyless and local). */
export type CloudProvider = ProviderName;

const cloudById = new Map<ProviderName, ProviderDescriptor>(
  cloudProviderDescriptors.map((d) => [d.id, d])
);

const stored: Partial<Record<ProviderName, string>> = {};

/**
 * Load any stored keys from SecretStorage into the in-memory cache. Call once
 * on activation; failures are swallowed so a SecretStorage hiccup never blocks
 * startup (the env-var fallback still applies).
 */
export async function loadStoredApiKeys(secrets: vscode.SecretStorage): Promise<void> {
  for (const descriptor of cloudProviderDescriptors) {
    try {
      const value = await secrets.get(descriptor.secretKey!);
      if (value && value.trim()) {
        stored[descriptor.id] = value.trim();
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
  const secretKey = cloudById.get(provider)?.secretKey;
  if (!secretKey) {
    return;
  }
  const trimmed = key.trim();
  if (trimmed) {
    await secrets.store(secretKey, trimmed);
    stored[provider] = trimmed;
  } else {
    await secrets.delete(secretKey);
    delete stored[provider];
  }
}

function keyFor(provider: ProviderName): string | undefined {
  const descriptor = cloudById.get(provider);
  if (!descriptor) {
    return undefined;
  }
  return stored[provider] ?? process.env[descriptor.envKey!]?.trim() ?? undefined;
}

export const credentials = {
  /** The configured API key for a cloud provider (SecretStorage first, then its env var). */
  apiKey(provider: ProviderName): string | undefined {
    return keyFor(provider);
  },
  /** Whether a usable key exists for the given provider (always false for a keyless one). */
  has(provider: ProviderName): boolean {
    return keyFor(provider) !== undefined;
  },
};
