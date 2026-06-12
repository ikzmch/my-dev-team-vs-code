/**
 * Operational limits — the tunable numbers that govern how much work the tools
 * and UI will do. These are configuration, not logic: change them here without
 * touching the code that enforces them.
 */
export const settings = {
  /** Shell command timeout for the `run` tool, in milliseconds. */
  runCommandTimeoutMs: 60_000,

  /** Output buffer cap for the `run` tool, in bytes. */
  runCommandMaxBufferBytes: 10 * 1024 * 1024,

  /** Max characters the `read` tool returns before truncating. */
  readMaxChars: 200_000,

  /** Caps on the `search` tool's file scans. */
  search: {
    /** Max files returned by a glob search. */
    globMaxResults: 200,
    /** Max files scanned when searching file contents. */
    contentScanLimit: 500,
    /** Max matches collected before a content search stops early. */
    contentMaxMatches: 50,
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

  /** Max characters of an attached file/selection inlined into the prompt. */
  maxAttachmentChars: 20_000,
} as const;
