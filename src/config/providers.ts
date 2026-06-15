/**
 * The single provider descriptor registry: the one place a model provider is
 * described. Models, tools, commands, and agents are all discovered from `.md`
 * files; providers cannot be (each needs a hand-written `build` that imports
 * its own `@ai-sdk/*` package), but everything *about* a provider that used to
 * be restated across five files now derives from one descriptor here:
 *
 *   - the model-frontmatter `provider` enum and `ProviderName` (engine/config/models.ts)
 *   - the user-facing `providerLabels` (engine/config/models.ts, ui/modelCommands.ts)
 *   - which models can run - the keyless flag and the API-key maps (config/credentials.ts)
 *   - the base-URL / endpoint settings (config/settings.ts)
 *   - the lazy provider build + availability wiring (engine/core/models.ts)
 *
 * Adding a provider is one descriptor (plus its `@ai-sdk/*` import) instead of a
 * five-file edit. This module lives in `config/` (not `engine/`) on purpose: the
 * import discipline forbids `config/` from reaching into engine internals, and
 * both the engine and the client config layer must read the same registry, so
 * the shared source of truth sits at the config layer they both already import.
 * It depends only on the AI SDK packages (external deps, freely importable),
 * never on settings/credentials/backend - those resolve a provider's config and
 * pass it into `build`, so there is no cycle.
 */
import { createOllama } from 'ollama-ai-provider-v2';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGroq } from '@ai-sdk/groq';

/** The AI SDK model type all providers produce. */
export type RoutedModel = ReturnType<ReturnType<typeof createOllama>>;

/**
 * A provider's resolved runtime configuration, passed into `build`. The caller
 * (engine/core/models.ts) resolves these from settings/credentials/backend so
 * the descriptor stays free of those dependencies.
 */
export interface ProviderConfig {
  /** Resolved API key. Undefined for a keyless provider (Ollama). */
  apiKey?: string;
  /**
   * Resolved base URL: for Ollama the server origin (no `/api` suffix); for a
   * cloud provider an optional gateway override (undefined uses the SDK default
   * endpoint).
   */
  baseUrl?: string;
}

/**
 * The registered providers, defined first as a `const` tuple so their ids stay
 * string literals - `ProviderName` is read off this, then the typed
 * `providerDescriptors` view below widens each entry to `ProviderDescriptor`
 * (whose `id` is `ProviderName`, so consumers get the literal union, not
 * `string`). The build arrow params are annotated so the const needs no
 * contextual type.
 */
const rawDescriptors = [
  {
    id: 'ollama',
    label: 'Ollama',
    keyless: true,
    baseUrlSetting: 'ollama.endpoint',
    build: ({ baseUrl }: ProviderConfig) => {
      const ollama = createOllama({ baseURL: `${baseUrl}/api` });
      return (model: string) => ollama(model);
    },
  },
  {
    id: 'openai',
    label: 'OpenAI',
    keyless: false,
    secretKey: 'myDevTeam.openai.apiKey',
    envKey: 'OPENAI_API_KEY',
    baseUrlSetting: 'openai.baseUrl',
    build: ({ apiKey, baseUrl }: ProviderConfig) => {
      const openai = createOpenAI({ apiKey, ...(baseUrl ? { baseURL: baseUrl } : {}) });
      return (model: string) => openai(model) as RoutedModel;
    },
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    keyless: false,
    secretKey: 'myDevTeam.anthropic.apiKey',
    envKey: 'ANTHROPIC_API_KEY',
    baseUrlSetting: 'anthropic.baseUrl',
    build: ({ apiKey, baseUrl }: ProviderConfig) => {
      const anthropic = createAnthropic({ apiKey, ...(baseUrl ? { baseURL: baseUrl } : {}) });
      return (model: string) => anthropic(model) as RoutedModel;
    },
  },
  {
    id: 'groq',
    label: 'Groq',
    keyless: false,
    secretKey: 'myDevTeam.groq.apiKey',
    envKey: 'GROQ_API_KEY',
    baseUrlSetting: 'groq.baseUrl',
    build: ({ apiKey, baseUrl }: ProviderConfig) => {
      const groq = createGroq({ apiKey, ...(baseUrl ? { baseURL: baseUrl } : {}) });
      return (model: string) => groq(model) as RoutedModel;
    },
  },
] as const;

/** Every registered provider id, as a literal union. */
export type ProviderName = (typeof rawDescriptors)[number]['id'];

/** Everything the rest of the code needs to know about one provider. */
export interface ProviderDescriptor {
  /**
   * Stable id: the model-frontmatter `provider` value, the `provider:<id>` pin,
   * the disable-list entry, and the key in every per-provider map.
   */
  id: ProviderName;
  /** User-facing display name (model picker, "which model ran" line, Set API Key). */
  label: string;
  /** A keyless provider needs no API key to run (the local Ollama server). */
  keyless: boolean;
  /** SecretStorage key the API key is stored under (cloud providers only). */
  secretKey?: string;
  /** Environment-variable fallback for the API key (cloud providers only). */
  envKey?: string;
  /**
   * The `myDevTeam.<this>` VS Code setting holding the base-URL / endpoint
   * override (e.g. `ollama.endpoint`, `openai.baseUrl`).
   */
  baseUrlSetting: string;
  /** Turn a resolved config into the provider's model factory. */
  build: (config: ProviderConfig) => (model: string) => RoutedModel;
}

/** The registered providers as descriptors (ids as the `ProviderName` union). */
export const providerDescriptors: readonly ProviderDescriptor[] = rawDescriptors;

/**
 * Provider ids in registry order, as a non-empty tuple so it can seed the
 * model-frontmatter `z.enum` directly.
 */
export const providerIds = providerDescriptors.map((d) => d.id) as [
  ProviderName,
  ...ProviderName[]
];

const byId = new Map<ProviderName, ProviderDescriptor>(
  providerDescriptors.map((d): [ProviderName, ProviderDescriptor] => [d.id, d])
);

/** The descriptor for a known provider id. */
export function providerDescriptor(id: ProviderName): ProviderDescriptor {
  return byId.get(id)!;
}

/** User-facing display names per provider id, derived from the registry. */
export const providerLabels = Object.fromEntries(
  providerDescriptors.map((d) => [d.id, d.label])
) as Record<ProviderName, string>;

/** Cloud providers - the ones that take an API key (everything not keyless). */
export const cloudProviderDescriptors: readonly ProviderDescriptor[] =
  providerDescriptors.filter((d) => !d.keyless);
