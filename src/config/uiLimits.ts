/**
 * Compile-time UI constants the client reads: how the front-end sizes and
 * places what it renders. The client-side analog of `config/limits.ts` (which
 * holds the engine's operational constants). Like that module it lives in
 * `config/` so any client layer - `ui/`, `tools/`, `client/` - can import it
 * without coupling to another (e.g. the tool host reads the approval-prompt cap
 * here rather than importing it from `ui/`).
 *
 * These are *not* user-tunable - those live in `config/settings.ts` - and they
 * are not read by the engine. The point is that a rendering threshold has one
 * named home instead of a magic number sitting inline at its use site.
 */
export const uiLimits = {
  planPreview: {
    /**
     * Under `myDevTeam.planApproval.preview: auto`, a drafted plan opens the
     * read-only editor preview when its rendered document reaches this many
     * characters (one of several "is it big" signals; see `isBigPlan`).
     */
    minChars: 1_400,
    /** ...or when the plan has at least this many steps. */
    minSteps: 8,
  },
  approval: {
    /** Max characters of an MCP call's argument preview shown in its approval prompt. */
    mcpArgsPreviewMaxChars: 500,
  },
  statusBar: {
    /** Priority of the single "My Dev Team" status-bar item (higher sits further left). */
    priority: 100,
  },
};
