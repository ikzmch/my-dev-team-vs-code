/**
 * Operational limits — the tunable numbers that govern how much work the tools
 * and UI will do. These are configuration, not logic: change them here without
 * touching the code that enforces them.
 */
export const settings = {
  /** Shell command timeout for the `run` tool, in milliseconds. */
  runCommandTimeoutMs: 60_000,

  /** Caps on the `search` tool's file scans. */
  search: {
    /** Max files returned by a glob search. */
    globMaxResults: 200,
    /** Max files scanned when searching file contents. */
    contentScanLimit: 500,
    /** Max matches collected before a content search stops early. */
    contentMaxMatches: 50,
  },

  /** Max characters of a file shown in the write-approval before/after preview. */
  writePreviewMaxChars: 800,

  /** Max characters of an attached file/selection inlined into the prompt. */
  maxAttachmentChars: 20_000,
} as const;
