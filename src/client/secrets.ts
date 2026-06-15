/**
 * The host's SecretStorage-backed secret source, for the in-process local
 * engine. Cloud keys can be stored in the editor's SecretStorage (via the "Set
 * API Key" command) and are read SecretStorage-first with the environment
 * variable as a fallback. This module owns the `vscode` dependency, so the
 * engine's `config/credentials.ts` seam stays `vscode`-free and the sidecar
 * child (which never loads this) keeps its env-only default.
 *
 * The cache is loaded once at activation (`loadStoredApiKeys`) because the
 * provider wiring reads keys synchronously while routing, and SecretStorage is
 * async. `setApiKey` writes a key and refreshes the cache so the next run sees
 * it. The SecretStorage key names come from the provider registry.
 */
import * as vscode from 'vscode';
import {
  cloudProviderDescriptors,
  ProviderDescriptor,
  ProviderName,
} from '../config/providers';
import { apiKeyFromEnv, SecretSource } from '../config/credentials';

const cloudById = new Map<ProviderName, ProviderDescriptor>(
  cloudProviderDescriptors.map((d) => [d.id, d])
);

const stored: Partial<Record<ProviderName, string>> = {};

/**
 * Load any stored keys from SecretStorage into the in-memory cache. Call once on
 * activation; failures are swallowed so a SecretStorage hiccup never blocks
 * startup (the env-var fallback still applies).
 */
export async function loadStoredApiKeys(secrets: vscode.SecretStorage): Promise<void> {
  for (const descriptor of cloudProviderDescriptors) {
    if (!descriptor.secretKey) {
      continue;
    }
    try {
      const value = await secrets.get(descriptor.secretKey);
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
  provider: ProviderName,
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

/**
 * The local engine's secret source: a stored SecretStorage key wins, else the
 * provider's environment variable. Injected into `config/credentials.ts` at
 * activation via `setSecretSource`.
 */
export const secretStorageSource: SecretSource = {
  apiKey: (provider) => stored[provider] ?? apiKeyFromEnv(provider),
};
