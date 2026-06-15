/**
 * The engine's runtime configuration seam: the user-tunable settings the engine
 * actually reads, injected rather than read in-process. This module imports no
 * `vscode`, so the engine can run wherever - in the extension host (the local
 * engine) or in a separate process (the sidecar child) - and still get the
 * user's choices.
 *
 * Who sets it:
 *  - in the host, the client injects a *live view* backed by `config/settings.ts`
 *    (so a settings change takes effect on the next request, as before);
 *  - in the sidecar child, the parent sends a serialized snapshot at startup and
 *    again whenever the user changes a setting, and the child re-injects it.
 *
 * It lives in `config/` (the shared layer, like `config/providers.ts`) so both
 * the engine and the client config layer can import it without breaking the
 * engine import discipline. Until something injects, a built-in default matching
 * the shipped settings keeps reads safe.
 */

/** The user-tunable settings the engine reads. Plain, serializable data. */
export interface RuntimeConfig {
  /** The user's `myDevTeam.ollama.endpoint`, or undefined when unset. */
  ollamaEndpoint: string | undefined;
  /** Per-provider base-URL overrides, keyed by the descriptor `baseUrlSetting`. */
  providerBaseUrls: Record<string, string | undefined>;
  /** Providers the user disabled (`myDevTeam.disabledProviders`). */
  disabledProviders: readonly string[];
  /** Model ids the user disabled (`myDevTeam.disabledModels`). */
  disabledModels: readonly string[];
  /** The user's triage model choice (`myDevTeam.triage.model`); empty defers to the backend floor. */
  triageModel: string;
  /** Whether complexity routing is on (`myDevTeam.complexityRouting`). */
  complexityRoutingEnabled: boolean;
  /** The user's request-rate override (`myDevTeam.provider.requestsPerMinute`), or undefined. */
  requestsPerMinute: number | undefined;
  /** Leading snippet lines shown under a write/edit in the transcript (`myDevTeam.chat.toolSnippetLines`). */
  toolSnippetLines: number;
  /** When a drafted plan must be approved (`myDevTeam.planApproval`). */
  planApproval: 'auto' | 'always' | 'never';
  /** Whether to capture and show a model's thinking (`myDevTeam.thinking.showInChat`). */
  thinkingShowInChat: boolean;
  /** Whether to run the end-of-run summarizer (`myDevTeam.summary.showInChat`). */
  summaryShowInChat: boolean;
}

/** Sane defaults matching the shipped settings, used until something injects. */
const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = {
  ollamaEndpoint: undefined,
  providerBaseUrls: {},
  disabledProviders: [],
  disabledModels: [],
  triageModel: '',
  complexityRoutingEnabled: true,
  requestsPerMinute: undefined,
  toolSnippetLines: 5,
  planApproval: 'auto',
  thinkingShowInChat: true,
  summaryShowInChat: true,
};

let current: RuntimeConfig = DEFAULT_RUNTIME_CONFIG;

/** Inject the runtime config the engine reads (a live view in the host, a snapshot in the child). */
export function setRuntimeConfig(config: RuntimeConfig): void {
  current = config;
}

/** The runtime config the engine reads. Never throws; returns the defaults until injected. */
export function runtimeConfig(): RuntimeConfig {
  return current;
}
