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
  ollamaEndpoint: 'http://localhost:11434',
  runCommandTimeoutMs: 60_000,
  search: {
    globMaxResults: 200,
    contentScanLimit: 500,
    contentMaxMatches: 50,
  },
} as const;

/** Read a user-set positive integer, falling back when unset or invalid. */
function userLimit(key: string, fallback: number): number {
  const value = vscode.workspace.getConfiguration(CONFIG_SECTION).get<unknown>(key);
  return typeof value === 'number' && Number.isFinite(value) && value >= 1
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

export const settings = {
  /**
   * Where the Ollama server listens (`myDevTeam.ollama.endpoint`). The
   * provider wiring (core/models.ts), the chat error hints (messages.ts), and
   * the activation health check (ui/startupCheck.ts) all derive from this one
   * value so they can never disagree.
   */
  get ollamaEndpoint(): string {
    return userEndpoint();
  },

  /** Shell command timeout for the `run` tool, in milliseconds (`myDevTeam.run.commandTimeoutMs`). */
  get runCommandTimeoutMs(): number {
    return userLimit('run.commandTimeoutMs', defaults.runCommandTimeoutMs);
  },

  /** Output buffer cap for the `run` tool, in bytes. */
  runCommandMaxBufferBytes: 10 * 1024 * 1024,

  /** Max characters the `read` tool returns before truncating. */
  readMaxChars: 200_000,

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

  /** Max characters of a file shown in the write-approval before/after preview. */
  writePreviewMaxChars: 800,

  /** Limits on the executor's tool-calling loop and its transcript previews. */
  executor: {
    /** Max model->tools->model iterations before the loop is cut off. */
    maxSteps: 12,
    /** Max characters of a tool call's argument JSON kept in the transcript. */
    inputPreviewMaxChars: 200,
    /** Max characters of a tool result kept in the transcript. */
    resultPreviewMaxChars: 400,
  },

  /** Max characters of an attached file/selection inlined into the prompt. */
  maxAttachmentChars: 20_000,

  /** How long the activation health check waits for Ollama, in milliseconds. */
  startupProbeTimeoutMs: 3_000,
};
