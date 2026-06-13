/**
 * Operational limits - the tunable numbers that govern how much work the tools
 * and UI will do. The user-tunable subset (Ollama endpoint, run-command
 * timeout, search caps) is read live from VS Code settings (the
 * `contributes.configuration` section in package.json, `myDevTeam.*`), with
 * the constants in `defaults` as fallbacks; invalid user values (wrong type,
 * non-positive numbers, non-http endpoints) fall back too, so the rest of the
 * code can always trust what it reads here. The remaining limits are
 * compile-time constants: change them here without touching the code that
 * enforces them.
 */
import * as vscode from 'vscode';

/** The settings namespace contributed in package.json. */
const CONFIG_SECTION = 'myDevTeam';

/**
 * Fallbacks for the user-tunable settings. Keep these in sync with the
 * `default` values declared in package.json `contributes.configuration` so
 * the Settings UI shows the values actually in effect.
 */
export const defaults = {
  engine: 'local' as const,
  model: 'auto',
  ollamaEndpoint: 'http://localhost:11434',
  runCommandTimeoutMs: 60_000,
  read: {
    maxLines: 200,
  },
  search: {
    globMaxResults: 200,
    contentScanLimit: 500,
    contentMaxMatches: 50,
  },
  chat: {
    toolSnippetLines: 5,
  },
  usage: {
    showInChat: true,
  },
  instructions: {
    files: ['AGENTS.md', 'CLAUDE.md'],
  },
  telemetry: {
    evalLog: false,
    shadowTriage: false,
  },
} as const;

/** Read a user-set integer (at least `min`), falling back when unset or invalid. */
function userLimit(key: string, fallback: number, min = 1): number {
  const value = vscode.workspace.getConfiguration(CONFIG_SECTION).get<unknown>(key);
  return typeof value === 'number' && Number.isFinite(value) && value >= min
    ? Math.floor(value)
    : fallback;
}

/**
 * Read the configured Ollama endpoint: an http(s) origin without the `/api`
 * suffix, normalised without a trailing slash. Anything else falls back to
 * the default so provider wiring and error hints never see a broken URL.
 */
function userEndpoint(): string {
  const value = vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .get<unknown>('ollama.endpoint');
  if (typeof value !== 'string') {
    return defaults.ollamaEndpoint;
  }
  const trimmed = value.trim().replace(/\/+$/, '');
  return /^https?:\/\/.+/.test(trimmed) ? trimmed : defaults.ollamaEndpoint;
}

/**
 * An optional custom base URL for a cloud provider (`myDevTeam.<provider>.baseUrl`),
 * for Azure / OpenAI-compatible gateways or an Anthropic proxy. An http(s)
 * origin, trailing slash trimmed; anything else (including unset) yields
 * undefined so the SDK falls back to the provider's own default endpoint.
 */
function userBaseUrl(key: string): string | undefined {
  const value = vscode.workspace.getConfiguration(CONFIG_SECTION).get<unknown>(key);
  if (typeof value !== 'string' || !value.trim()) {
    return undefined;
  }
  const trimmed = value.trim().replace(/\/+$/, '');
  return /^https?:\/\/.+/.test(trimmed) ? trimmed : undefined;
}

export const settings = {
  /**
   * Which engine handles `@devteam` runs (`myDevTeam.engine`): the
   * in-process local engine, or (Phase B) a remote backend speaking the same
   * protocol. Read live per request, so switching needs no reload. Anything
   * but the literal "remote" falls back to "local" - the safe default.
   */
  get engine(): 'local' | 'remote' {
    const value = vscode.workspace
      .getConfiguration(CONFIG_SECTION)
      .get<unknown>('engine');
    return value === 'remote' ? 'remote' : defaults.engine;
  },

  /**
   * What the user chose for the planner, answerer, and executor
   * (`myDevTeam.model`): a registry id (pin one model), a "provider:<name>"
   * (route within one provider), or "auto" to let the capability router pick
   * the best available model per agent. Read live and sent on every run
   * request; triage always stays on its routed local model regardless. The
   * `/model` command and the status-bar item write this setting.
   */
  get model(): string {
    const value = vscode.workspace.getConfiguration(CONFIG_SECTION).get<unknown>('model');
    return typeof value === 'string' && value.trim() ? value.trim() : defaults.model;
  },

  /**
   * Where the Ollama server listens (`myDevTeam.ollama.endpoint`). The
   * provider wiring (core/models.ts), the chat error hints (messages.ts), and
   * the activation health check (ui/startupCheck.ts) all derive from this one
   * value so they can never disagree.
   */
  get ollamaEndpoint(): string {
    return userEndpoint();
  },

  /**
   * Optional custom base URL for the OpenAI provider
   * (`myDevTeam.openai.baseUrl`): an Azure / OpenAI-compatible gateway.
   * Undefined uses the OpenAI default endpoint.
   */
  get openaiBaseUrl(): string | undefined {
    return userBaseUrl('openai.baseUrl');
  },

  /**
   * Optional custom base URL for the Anthropic provider
   * (`myDevTeam.anthropic.baseUrl`): a proxy or gateway. Undefined uses the
   * Anthropic default endpoint.
   */
  get anthropicBaseUrl(): string | undefined {
    return userBaseUrl('anthropic.baseUrl');
  },

  /** Shell command timeout for the `run` tool, in milliseconds (`myDevTeam.run.commandTimeoutMs`). */
  get runCommandTimeoutMs(): number {
    return userLimit('run.commandTimeoutMs', defaults.runCommandTimeoutMs);
  },

  /** Output buffer cap for the `run` tool, in bytes. */
  runCommandMaxBufferBytes: 10 * 1024 * 1024,

  /**
   * Cap on the `run` tool's model-facing result, in characters. The buffer
   * above bounds what is captured from the process; this bounds what is
   * handed back to the model, so one chatty command cannot flood a small
   * model's context window. The output's head and tail are kept around a
   * truncation marker.
   */
  runResultMaxChars: 200_000,

  /**
   * Cap on the session log the "Dev Team" terminal mirror keeps, in
   * characters. The backlog replays the full run history when the user first
   * opens (or reopens) the terminal; beyond the cap the oldest output is
   * dropped.
   */
  runMirrorBacklogMaxChars: 200_000,

  /** Caps on the `read` tool's output. */
  read: {
    /** Max lines one `read` call returns (`myDevTeam.read.maxLines`). */
    get maxLines(): number {
      return userLimit('read.maxLines', defaults.read.maxLines);
    },
    /** Backstop in characters, so a few enormous lines cannot flood the context. */
    maxChars: 200_000,
  },

  /** Caps on the `search` tool's file scans. */
  search: {
    /** Max files returned by a glob search (`myDevTeam.search.globMaxResults`). */
    get globMaxResults(): number {
      return userLimit('search.globMaxResults', defaults.search.globMaxResults);
    },
    /** Max files scanned when searching file contents (`myDevTeam.search.contentScanLimit`). */
    get contentScanLimit(): number {
      return userLimit('search.contentScanLimit', defaults.search.contentScanLimit);
    },
    /** Max matches collected before a content search stops early (`myDevTeam.search.contentMaxMatches`). */
    get contentMaxMatches(): number {
      return userLimit('search.contentMaxMatches', defaults.search.contentMaxMatches);
    },
    /**
     * Folders the `search` tool never looks into. Passing an explicit exclude
     * to findFiles replaces VS Code's default excludes, so the usual noise
     * folders are listed here.
     */
    excludeGlob: '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/coverage/**}',
    /** Files larger than this are skipped by a content search. */
    maxFileSizeBytes: 1024 * 1024,
  },

  /** Limits on the executor's tool-calling loop and its transcript previews. */
  executor: {
    /** Max model->tools->model iterations before the loop is cut off. */
    maxSteps: 12,
    /** Max characters of a tool call's argument JSON kept in the transcript. */
    inputPreviewMaxChars: 200,
    /** Max characters of a tool result kept in the transcript. */
    resultPreviewMaxChars: 400,
    /**
     * Leading lines of a snippet-bearing argument (config `snippetArg`, e.g.
     * the file contents for write) shown beneath the call line in the
     * transcript (`myDevTeam.chat.toolSnippetLines`; 0 hides snippets).
     */
    get snippetLines(): number {
      return userLimit('chat.toolSnippetLines', defaults.chat.toolSnippetLines, 0);
    },
  },

  /** How per-run token usage is surfaced to the user (client/usageStats.ts). */
  usage: {
    /**
     * Whether each reply ends with a `**Tokens:**` line summing the run's
     * model calls (`myDevTeam.usage.showInChat`). On by default; the
     * status-bar session total and the "Show Token Usage" report are
     * independent of this flag. Anything but the literal `false` counts as on.
     */
    get showInChatEnabled(): boolean {
      return (
        vscode.workspace
          .getConfiguration(CONFIG_SECTION)
          .get<unknown>('usage.showInChat') !== false
      );
    },
  },

  /** The local eval log run/feedback records land in (client/evalLog.ts). */
  telemetry: {
    /**
     * Whether finished runs and 👍/👎 feedback are appended to the local eval
     * log (`myDevTeam.telemetry.evalLog`). Off by default - storing the
     * signal is opt-in. Anything but the literal `true` counts as off.
     */
    get evalLogEnabled(): boolean {
      return (
        vscode.workspace
          .getConfiguration(CONFIG_SECTION)
          .get<unknown>('telemetry.evalLog') === true
      );
    },
    /** Cap on the eval log file, in characters; the oldest records are dropped past it. */
    evalLogMaxChars: 1_000_000,

    /**
     * Whether a slash-command run also runs triage in the background to record
     * what it would have decided (`myDevTeam.telemetry.shadowTriage`), so the
     * usage report can score triage against the pinned route. Off by default -
     * it adds one local triage call per pinned run. Only meaningful with the
     * eval log on (that is where the signal lands); the client sets the run's
     * shadow flag only when both are true. Anything but the literal `true` is off.
     */
    get shadowTriageEnabled(): boolean {
      return (
        vscode.workspace
          .getConfiguration(CONFIG_SECTION)
          .get<unknown>('telemetry.shadowTriage') === true
      );
    },
  },

  /**
   * The workspace's standing instruction file (AGENTS.md/CLAUDE.md), read by
   * the client per request and folded into the agent prompts.
   */
  instructions: {
    /**
     * Root-relative file names probed in order; the first that exists wins
     * (`myDevTeam.instructions.files`). An empty array disables the feature.
     * Only plain names are accepted - a path separator or ".." would escape
     * the workspace root, so such entries fall back to the default list.
     */
    get files(): readonly string[] {
      const value = vscode.workspace
        .getConfiguration(CONFIG_SECTION)
        .get<unknown>('instructions.files');
      if (!Array.isArray(value)) {
        return defaults.instructions.files;
      }
      const valid = value.every(
        (name) =>
          typeof name === 'string' &&
          name.trim().length > 0 &&
          !/[\\/]/.test(name) &&
          !name.includes('..')
      );
      return valid ? (value as string[]).map((name) => name.trim()) : defaults.instructions.files;
    },
    /**
     * Max characters of the instruction file inlined into the prompts; kept
     * small because the standing rules ride along on every agent call of a
     * small local model.
     */
    maxChars: 8_000,
  },

  /**
   * Caps on the inline prompt references the client resolves into context
   * (`client/references.ts`): `#codebase` (a quick workspace search) and
   * `#changes` (the uncommitted git diff). Compile-time constants - resolving
   * is opt-in (the user types the marker), so these bound the opt-in cost.
   */
  references: {
    /** Most distinctive search terms derived from the prompt for `#codebase`. */
    codebaseMaxTerms: 4,
    /** Max matching files a `#codebase` search lists. */
    codebaseMaxFiles: 8,
    /** Of the listed files, how many include a head snippet. */
    codebaseSnippetFiles: 3,
    /** Head lines per `#codebase` snippet. */
    codebaseSnippetLines: 20,
    /** Max characters of the assembled `#codebase` attachment text. */
    codebaseMaxChars: 8_000,
    /** Max characters of the `#changes` (git diff) attachment text. */
    changesMaxChars: 12_000,
  },

  /** Max characters of an attached file/selection inlined into the prompt. */
  maxAttachmentChars: 20_000,

  /**
   * Max size, in bytes, of an attached file the handler will read at all.
   * Only `maxAttachmentChars` of it survive into the prompt anyway, so a
   * file beyond this cap is answered with a too-large notice instead of
   * being pulled fully into memory just to be thrown away.
   */
  maxAttachmentReadBytes: 10_000_000,

  /**
   * Caps on the conversation history folded into the agent prompts. The chat
   * handler keeps only the most recent turns and truncates each turn's text,
   * so a long session can never crowd a small local model's context window.
   */
  history: {
    /** Most recent prior turns kept (user prompts + the participant's replies). */
    maxTurns: 10,
    /** Max characters of one prior turn's text inlined into the prompt. */
    maxTurnChars: 2_000,
  },

  /** How long the activation health check waits for Ollama, in milliseconds. */
  startupProbeTimeoutMs: 3_000,
};
