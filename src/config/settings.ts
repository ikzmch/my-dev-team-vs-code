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
 * One configured MCP server (stdio transport): a name (used to namespace its
 * tools and to label its approval prompts) plus the command, arguments, and
 * environment to launch it with. Parsed from the `myDevTeam.mcp.servers` object
 * map by `settings.mcp.servers`.
 */
export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * Fallbacks for the user-tunable settings. Keep these in sync with the
 * `default` values declared in package.json `contributes.configuration` so
 * the Settings UI shows the values actually in effect.
 */
export const defaults = {
  engine: 'local' as const,
  model: 'auto',
  triageModel: '',
  complexityRouting: true,
  planApproval: 'auto' as const,
  approval: {
    fileChanges: false,
  },
  disabledProviders: [] as readonly string[],
  disabledModels: [] as readonly string[],
  ollamaEndpoint: 'http://localhost:11434',
  requestsPerMinute: 0,
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
  write: {
    protectedPaths: ['.vscode'],
  },
  usage: {
    showInChat: true,
  },
  changes: {
    showInChat: true,
  },
  summary: {
    showInChat: true,
  },
  thinking: {
    showInChat: true,
  },
  instructions: {
    files: ['AGENTS.md', 'CLAUDE.md'],
  },
  skills: {
    directories: ['.devteam/skills', '.claude/skills'],
  },
  mcp: {
    servers: {} as Readonly<Record<string, unknown>>,
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

/**
 * Read a user-set list of identifiers (provider names / model ids), keeping only
 * the non-blank string entries and trimming them. A non-array (unset or wrong
 * type) yields the empty list, so a typo can never disable everything by
 * accident - the caller then treats nothing as disabled.
 */
function userStringList(key: string): readonly string[] {
  const value = vscode.workspace.getConfiguration(CONFIG_SECTION).get<unknown>(key);
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    .map((entry) => entry.trim());
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
   * request; triage is configured separately by `triageModel`, not this. The
   * `/model` command and the status-bar item write this setting.
   */
  get model(): string {
    const value = vscode.workspace.getConfiguration(CONFIG_SECTION).get<unknown>('model');
    return typeof value === 'string' && value.trim() ? value.trim() : defaults.model;
  },

  /**
   * What the quick triage step uses (`myDevTeam.triage.model`), kept separate
   * from `model` so the cheap classifier need not ride on the executor's model.
   * A registry id pins one model, "provider:<name>" routes within a provider,
   * "auto" routes among all available models; empty (the default) defers to the
   * build's `agents.triage.model` floor (the "ollama" provider unless changed).
   * Read live and resolved in engine/core/models.ts (`triageRouting`), where the
   * disable layers still apply - this can never reach a disabled provider/model.
   */
  get triageModel(): string {
    const value = vscode.workspace.getConfiguration(CONFIG_SECTION).get<unknown>('triage.model');
    return typeof value === 'string' ? value.trim() : defaults.triageModel;
  },

  /**
   * Whether triage's complexity judgement sizes the executor's model
   * (`myDevTeam.complexityRouting`). On by default: simple work routes to a
   * cheaper/smaller model and complex work to the strongest in the candidate
   * pool (the model registry's `tier`). When off, the executor routes by
   * capability alone, as before. A pinned model bypasses it regardless. Read
   * live; anything but the literal `false` counts as on.
   */
  get complexityRoutingEnabled(): boolean {
    return (
      vscode.workspace
        .getConfiguration(CONFIG_SECTION)
        .get<unknown>('complexityRouting') !== false
    );
  },

  /**
   * When a drafted plan must be approved before it executes
   * (`myDevTeam.planApproval`). `auto` (the default) pauses only when the
   * planner judged the work `complex`; `always` pauses on every plan; `never`
   * runs straight through (the pre-gate behaviour). The gate offers Approve,
   * Cancel, and Revise (re-plan with a comment). Read live; only the literal
   * `always`/`never` switch off `auto`, so a typo is the safe default.
   */
  get planApproval(): 'auto' | 'always' | 'never' {
    const value = vscode.workspace
      .getConfiguration(CONFIG_SECTION)
      .get<unknown>('planApproval');
    return value === 'always' || value === 'never' ? value : defaults.planApproval;
  },

  /**
   * Approval gates the user can switch on. Only `run` is gated unconditionally
   * (a shell command reaches outside the workspace and is not git-recoverable);
   * the file-changing tools are gated only when the user opts in here.
   */
  approval: {
    /**
     * Whether `write`/`edit` must be approved before they change a file
     * (`myDevTeam.approval.fileChanges`). Off by default: a git-backed workspace
     * makes a write recoverable, and prompting on every file would make a
     * routine multi-file change unusable, so changes apply straight away. Turn
     * it on to confirm every write and edit with the same Approve/Decline prompt
     * the `run` tool uses. Read live, so flipping it takes effect on the next
     * request; anything but the literal `true` counts as off.
     */
    get fileChanges(): boolean {
      return (
        vscode.workspace
          .getConfiguration(CONFIG_SECTION)
          .get<unknown>('approval.fileChanges') === true
      );
    },
  },

  /**
   * Providers the user switched off (`myDevTeam.disabledProviders`): the router
   * never routes to their models and the `/model` picker shows them disabled,
   * even when a key is set. This is the per-user layer on top of the backend's
   * own floor (config/backend.json); it narrows further but can never
   * re-enable a provider the backend disabled. Read live. Names that are not
   * registered providers are simply harmless.
   */
  get disabledProviders(): readonly string[] {
    return userStringList('disabledProviders');
  },

  /**
   * Individual model ids the user switched off (`myDevTeam.disabledModels`),
   * same two-layer semantics as `disabledProviders` but per model. A disabled
   * model never runs even if pinned; the run falls back to Auto. Read live.
   */
  get disabledModels(): readonly string[] {
    return userStringList('disabledModels');
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
   * Optional custom base URL for a cloud provider, read from the VS Code
   * setting named by the provider descriptor's `baseUrlSetting`
   * (`myDevTeam.<provider>.baseUrl`): an Azure / OpenAI-compatible gateway or a
   * proxy. Undefined (unset or invalid) uses the provider's own default
   * endpoint. Generic over the provider so adding one needs no new getter -
   * the provider wiring (engine/core/models.ts) passes the descriptor's key.
   */
  providerBaseUrl(settingKey: string): string | undefined {
    return userBaseUrl(settingKey);
  },

  /** Outgoing model-request rate limiting and rate-limit retry behaviour. */
  provider: {
    /**
     * Max model requests per minute sent to each provider
     * (`myDevTeam.provider.requestsPerMinute`). The rate limiter spaces calls
     * so no provider receives more than this many requests per rolling minute,
     * keeping runs under a provider's quota (e.g. a Groq free-tier limit).
     * Applied per provider, so a local Ollama call never spends a cloud
     * provider's budget. `0` (the default) disables throttling. Read live.
     */
    get requestsPerMinute(): number {
      return userLimit('provider.requestsPerMinute', defaults.requestsPerMinute, 0);
    },
    /**
     * How many times a rate-limited (HTTP 429) request is retried before the
     * step is failed. Each retry waits the delay the provider suggests (its
     * `retry-after` header or the "try again in Ns" hint in the error),
     * clamped to `maxRetryWaitMs`.
     */
    maxRateLimitRetries: 5,
    /** Cap on a single rate-limit retry wait, in milliseconds. */
    maxRetryWaitMs: 60_000,
    /**
     * Buffer added to a provider-suggested retry delay, in milliseconds: the
     * suggested time is approximate, so we wait a touch longer to avoid
     * tripping the same limit again immediately.
     */
    retryBufferMs: 250,
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
    /**
     * Max size, in bytes, of a file the `read` tool will load. The line/char
     * caps bound the *result*, but the whole file is read into the extension
     * host before they apply, so without this a `read` of a multi-GB or giant
     * minified file (the executor can be steered to one by injected workspace
     * text) would exhaust memory. Over this, `read` refuses by its stat instead
     * of loading the file, mirroring the attachment reader and the content scan.
     * Generous (10 MB) so every ordinary source file passes; compile-time.
     */
    maxFileSizeBytes: 10 * 1024 * 1024,
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
    /** Max match lines collected before a content search stops early (`myDevTeam.search.contentMaxMatches`). */
    get contentMaxMatches(): number {
      return userLimit('search.contentMaxMatches', defaults.search.contentMaxMatches);
    },
    /**
     * Max match lines reported from a single file, so one busy file (e.g. a log)
     * cannot eat the whole `contentMaxMatches` budget. Compile-time.
     */
    contentMaxMatchesPerFile: 5,
    /**
     * Max characters of a matched line kept in a content-search preview; a
     * longer line is trimmed (a `…` marker appended). Compile-time.
     */
    contentPreviewMaxChars: 200,
    /**
     * Folders the `search` tool never looks into. Passing an explicit exclude
     * to findFiles replaces VS Code's default excludes, so the usual noise
     * folders are listed here.
     */
    excludeGlob: '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/coverage/**}',
    /** Files larger than this are skipped by a content search. */
    maxFileSizeBytes: 1024 * 1024,
    /**
     * Ceiling on the candidate file list the JavaScript content scan (the
     * no-ripgrep fallback) materialises from `findFiles`. The files-examined
     * budget (`contentScanLimit`) bounds the *work*, but `findFiles('**\/*')`
     * with no `maxResults` first builds one Uri per workspace file, so on a very
     * large repo the array itself is the cost. Generous (far above the scan
     * budget) so it never drops files the budget would have reached; when the
     * candidate list is capped here the scan reports `truncated`. Compile-time.
     */
    scanCandidateLimit: 25_000,
  },

  /**
   * Self-repair for the structured-output steps (triage, the planner). Small
   * local models routinely emit JSON that fails schema validation; rather than
   * fail the whole run on one bad generation, the step re-asks the same agent
   * with the validation error appended. Compile-time: the cost is bounded model
   * calls, not something an end user tunes.
   */
  structuredOutput: {
    /**
     * Extra generations allowed after a schema-validation failure before the
     * step fails for real. `0` disables self-repair (the first bad object fails
     * the run, as before); `1` (the default) gives one corrective retry.
     */
    repairAttempts: 1,
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

  /**
   * Containment for the ungated `write`/`edit` tools (tools/workspaceTools.ts).
   * The tools are deliberately ungated because a git-backed workspace makes
   * their changes recoverable - but that reasoning fails for locations that are
   * not git-tracked and that the system executes on its own, so those are
   * refused outright regardless of approval.
   */
  write: {
    /**
     * Root-relative path prefixes `write`/`edit` refuse to touch
     * (`myDevTeam.write.protectedPaths`), *in addition to* the always-protected
     * `.git/` (hardcoded in workspaceTools.ts, not user-removable: a write to
     * `.git/hooks/*` runs on the next git command, code execution that never
     * passes the run tool's approval gate). The configurable entries cover the
     * other auto-running locations (the default `.vscode`, whose tasks.json can
     * run on folder open). Each entry is matched segment by segment, so `.git`
     * does not catch `.gitignore`. Invalid entries (non-string, empty, or
     * containing `..`) make the whole list fall back to the default. An empty
     * array drops the configurable prefixes but keeps `.git` protected.
     */
    get protectedPaths(): readonly string[] {
      const value = vscode.workspace
        .getConfiguration(CONFIG_SECTION)
        .get<unknown>('write.protectedPaths');
      if (!Array.isArray(value)) {
        return defaults.write.protectedPaths;
      }
      const valid = value.every(
        (entry) =>
          typeof entry === 'string' && entry.trim().length > 0 && !entry.includes('..')
      );
      return valid
        ? (value as string[]).map((entry) => entry.trim())
        : defaults.write.protectedPaths;
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

  changes: {
    /**
     * Whether a reply that changed files ends with a `**Changes:**` line
     * summing them ("N files changed, +X -Y", `myDevTeam.changes.showInChat`).
     * On by default; the line only appears when a turn actually wrote files, so
     * it is far less chatty than the per-turn token line. Anything but the
     * literal `false` counts as on.
     */
    get showInChatEnabled(): boolean {
      return (
        vscode.workspace
          .getConfiguration(CONFIG_SECTION)
          .get<unknown>('changes.showInChat') !== false
      );
    },
  },

  summary: {
    /**
     * Whether an executed plan ends with a three-section **Summary** recap
     * (what ships / how it's built / tests and docs, `myDevTeam.summary.showInChat`).
     * On by default. This gates the work, not just the display: when off, the
     * engine skips the extra summarizer model call entirely, and it is skipped
     * anyway on a run that changed no files. Anything but the literal `false`
     * counts as on.
     */
    get showInChatEnabled(): boolean {
      return (
        vscode.workspace
          .getConfiguration(CONFIG_SECTION)
          .get<unknown>('summary.showInChat') !== false
      );
    },
  },

  thinking: {
    /**
     * Whether a reasoning model's thinking is surfaced live as transient
     * progress while `@devteam` works (`myDevTeam.thinking.showInChat`). On by
     * default. The engine condenses the model's verbose `<think>` output to its
     * latest line before showing it, and never keeps it past the run. Like the
     * summary flag this gates the work, not just the display: when off, the
     * executor and answerer skip capturing reasoning entirely. Anything but the
     * literal `false` counts as on.
     */
    get showInChatEnabled(): boolean {
      return (
        vscode.workspace
          .getConfiguration(CONFIG_SECTION)
          .get<unknown>('thinking.showInChat') !== false
      );
    },
    /**
     * Max characters of one condensed thinking line shown to the user; a longer
     * line is trimmed with an ellipsis. Compile-time: it bounds a transient
     * status line, not something an end user tunes.
     */
    lineMaxChars: 200,
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
   * The workspace's skills (named, described instruction packages the executor
   * loads on demand), read by the client per request from the configured
   * directories and shipped on the run request.
   */
  skills: {
    /**
     * Root-relative directories scanned for `<dir>/<name>/SKILL.md` files
     * (`myDevTeam.skills.directories`). An empty array disables workspace
     * skills (the built-in skills still ship). An entry that is absolute or
     * contains ".." would escape the workspace, so such a list falls back to
     * the default.
     */
    get directories(): readonly string[] {
      const value = vscode.workspace
        .getConfiguration(CONFIG_SECTION)
        .get<unknown>('skills.directories');
      if (!Array.isArray(value)) {
        return defaults.skills.directories;
      }
      const valid = value.every(
        (dir) =>
          typeof dir === 'string' &&
          dir.trim().length > 0 &&
          !dir.includes('..') &&
          !/^([a-zA-Z]:[\\/]|[\\/])/.test(dir.trim())
      );
      return valid
        ? (value as string[]).map((dir) => dir.trim().replace(/[\\/]+$/, ''))
        : defaults.skills.directories;
    },
    /** Max skills read from the workspace in one request. */
    maxSkills: 24,
    /**
     * Max characters of one skill file: the client caps the raw text it ships
     * and the engine caps the parsed body, so a large skill cannot crowd the
     * executor's context window.
     */
    maxChars: 8_000,
  },

  /**
   * User-configured MCP (Model Context Protocol) servers whose tools the
   * executor may call (client/mcp.ts). Servers are launched over stdio, their
   * tools discovered and offered to the model, and every call is approved
   * through the same gate as the `run` tool. Untrusted input, so no server is
   * contacted in an untrusted workspace.
   */
  mcp: {
    /**
     * The configured servers (`myDevTeam.mcp.servers`): a name -> definition
     * object map (Claude-Desktop-shaped). Each value must carry a non-empty
     * string `command`, with optional string-array `args` and string-map `env`;
     * the name must be a plain identifier (letters, digits, `_`, `-`) so it can
     * namespace the server's tools cleanly. Invalid entries are dropped rather
     * than failing - a typo in one server must not disable the rest. Empty (the
     * default, or a non-object value) turns the feature off. Read live; new
     * servers take effect on a window reload (a server is a launched process the
     * hub connects once and reuses).
     */
    get servers(): readonly McpServerConfig[] {
      const value = vscode.workspace
        .getConfiguration(CONFIG_SECTION)
        .get<unknown>('mcp.servers');
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return [];
      }
      const out: McpServerConfig[] = [];
      for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
        const trimmed = name.trim();
        if (!/^[\w-]+$/.test(trimmed) || typeof raw !== 'object' || raw === null) {
          continue;
        }
        const entry = raw as Record<string, unknown>;
        if (typeof entry.command !== 'string' || !entry.command.trim()) {
          continue;
        }
        const args =
          Array.isArray(entry.args) && entry.args.every((a) => typeof a === 'string')
            ? (entry.args as string[])
            : undefined;
        const env =
          entry.env &&
          typeof entry.env === 'object' &&
          !Array.isArray(entry.env) &&
          Object.values(entry.env).every((v) => typeof v === 'string')
            ? (entry.env as Record<string, string>)
            : undefined;
        out.push({
          name: trimmed,
          command: entry.command.trim(),
          ...(args ? { args } : {}),
          ...(env ? { env } : {}),
        });
      }
      return out;
    },
    /** Max MCP tools offered to the model across all servers in one run. */
    maxTools: 64,
    /** How long to wait for a server to connect before skipping it, in ms. */
    connectTimeoutMs: 10_000,
    /** How long a single MCP tool call may run before it is abandoned, in ms. */
    callTimeoutMs: 60_000,
    /** Cap on an MCP tool result handed back to the model, in characters. */
    resultMaxChars: 50_000,
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
