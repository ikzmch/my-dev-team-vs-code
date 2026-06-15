/**
 * User-facing copy for the chat UI: error text and the markdown templates
 * the reply renderer uses. Kept out of the logic so the wording can be tuned
 * without editing control flow. Functions take only the dynamic bits; static
 * prose lives here.
 *
 * Knows nothing about agents and almost nothing about models: the error
 * templates render a detail the protocol delivered, and the troubleshooting
 * hints are templates the LocalEngine fills in - which model is routed where
 * is engine knowledge the client does not have. The exception is the `model`
 * section: model selection is a user-facing choice (the user picks one and is
 * told which ran), so those labels travel on the protocol and this copy frames
 * them.
 */
import type { ModelSelection, ProgressStatus } from '../protocol/types';

/**
 * Wrap untrusted content (a command, a file path, a written-file snippet) in a
 * fenced code block whose backtick run is longer than any run inside the
 * content, so the content cannot break out of the fence and inject markdown.
 * `min` is the baseline fence length (3 for a plain block, 4 where a snippet
 * may itself contain a triple-backtick fence).
 */
function fence(content: string, min: number): string {
  const longestRun = (content.match(/`+/g) ?? []).reduce(
    (max, run) => Math.max(max, run.length),
    0
  );
  const ticks = '`'.repeat(Math.max(min, longestRun + 1));
  return `${ticks}\n${content}\n${ticks}`;
}

export const messages = {
  /**
   * Hint the LocalEngine appends to a step failure, naming the model the
   * router actually selected for the failing agent and the endpoint the
   * provider wiring actually uses, so the troubleshooting text can never
   * drift from either. Travels to the UI as the protocol error's `hint`.
   */
  ollamaHint: (endpoint: string, model: string) =>
    `Is Ollama running on ${endpoint} with \`${model}\` pulled?\n\n`,

  /**
   * Hint appended to a step failure whose agent used a cloud model: the model
   * needs an API key. The provider names which environment-variable fallback
   * applies. Travels to the UI as the protocol error's `hint`, like the Ollama
   * one.
   */
  cloudKeyHint: (label: string, provider: 'openai' | 'anthropic' | 'groq') => {
    const envVar = {
      openai: 'OPENAI_API_KEY',
      anthropic: 'ANTHROPIC_API_KEY',
      groq: 'GROQ_API_KEY',
    }[provider];
    return (
      `\`${label}\` needs an API key. Set the ${envVar} environment variable ` +
      `(in the environment VS Code is launched from), or - for the local ` +
      `engine - run the "My Dev Team: Set API Key" command, then try again.\n\n`
    );
  },

  /**
   * Hint appended when a step failed because the provider kept rate-limiting
   * the request even after the automatic retries. Points at the throttle
   * setting so the user can stay under their quota. Travels to the UI as the
   * protocol error's `hint`.
   */
  rateLimitHint: (label: string) =>
    `\`${label}\` was rate limited by its provider and the automatic retries ` +
    `were exhausted. Lower the request rate with the ` +
    `"myDevTeam.provider.requestsPerMinute" setting, or upgrade your provider ` +
    `plan, then try again.\n\n`,

  /**
   * Copy for model selection: the "which model ran" line in the reply, and the
   * `/model` picker. This is the one place the UI names a concrete model - the
   * user chose it (or asked what Auto picked), so the identity is deliberately
   * surfaced here rather than hidden like the rest of the engine internals.
   */
  model: {
    /** The "Auto" choice shown first in the picker. */
    autoLabel: 'Auto',
    autoDescription: 'Let My Dev Team pick the best available model for each step.',
    /** A "best model within this provider" choice in the picker. */
    providerLabel: (provider: string) => `${provider} (best available)`,
    providerDescription: (provider: string) =>
      `Use ${provider} models; the best one is picked per task.`,
    /** Suffix marking the model that is currently selected, in the picker. */
    currentSuffix: ' (current)',
    /** Detail shown on a picker entry whose model cannot run yet. */
    unavailableDetail: 'Not available - set its API key or pull the model first.',
    /**
     * Detail shown on a picker entry switched off by config (the build's floor
     * or your `myDevTeam.disabled*` settings); it never runs even if pinned.
     */
    disabledDetail: 'Disabled by configuration - it will not run.',
    /** Placeholder in the `/model` quick pick. */
    pickerPlaceholder: 'Choose the model for @devteam (Auto routes by capability)',
    /** The whole reply to a `/model` turn that set the choice. */
    confirmation: (label: string) =>
      `Model set to **${label}**. It applies to your next @devteam request.`,
    /** The reply when `/model <name>` named something not in the catalogue. */
    unknown: (name: string) =>
      `No model "${name}". Run /model with no argument to pick from the list.`,
    /**
     * The "which model ran" line under the triage block. In pinned mode it
     * names the chosen model; in Auto mode it lists the work agents' models so
     * the user sees what Auto picked (triage is always a fast local model and
     * is omitted to keep the line short).
     */
    block: (selection: ModelSelection): string => {
      const roleNames: Record<string, string> = {
        plan: 'Planner',
        execute: 'Executor',
        answer: 'Answerer',
        triage: 'Triage',
      };
      const work = selection.models.filter((m) => m.step !== 'triage');
      if (selection.mode === 'pinned') {
        const label = (work[0] ?? selection.models[0])?.label ?? '';
        return `**Model:** ${label} _(pinned)_\n\n`;
      }
      const parts = work.map((m) => `${roleNames[m.step] ?? m.step}: ${m.label}`);
      if (selection.mode === 'provider') {
        return `**Model:** ${selection.provider ?? 'Provider'} - ${parts.join(', ')} _(provider)_\n\n`;
      }
      return `**Model:** Auto - ${parts.join(', ')}\n\n`;
    },
    /** Prompt for the Set API Key command's provider pick. */
    setKeyProviderPlaceholder: 'Which provider is the API key for?',
    /** Prompt for the Set API Key command's key input. */
    setKeyInputPrompt: (provider: string) =>
      `Paste your ${provider} API key (stored securely; used by the local engine; leave empty to clear)`,
    /** Confirmation toast after a key is stored or cleared. */
    keyStored: (provider: string) => `My Dev Team: ${provider} API key stored.`,
    keyCleared: (provider: string) => `My Dev Team: ${provider} API key cleared.`,
  },

  /**
   * Token-usage copy: the per-reply line, the status-bar session counter, and
   * the "Show Token Usage" report. The counts are already formatted compactly
   * by usageStats.formatTokenCount before they reach these templates - this is
   * only the framing. The `~` prefix marks a figure that includes a
   * length-based estimate (a model call the provider gave no counts for).
   */
  changes: {
    /**
     * The `**Changes:**` line appended under a reply that wrote files (gated by
     * the setting; omitted when nothing changed), e.g.
     * "1 file changed, +12 -0" or "4 files changed, +120 -30".
     */
    summary: (files: number, added: number, removed: number) =>
      `\n\n**Changes:** ${files} ${files === 1 ? 'file' : 'files'} changed, ` +
      `+${added} -${removed}`,
  },

  usage: {
    /** The `**Tokens:**` line appended under a reply (gated by the setting). */
    chatLine: (input: string, output: string, estimated: boolean) =>
      `\n\n**Tokens:** ${estimated ? '~' : ''}${input} in / ${output} out`,
    /** The whole "Show Token Usage" report when no runs have been recorded. */
    empty:
      '# My Dev Team - token usage\n\n' +
      'No runs have been recorded yet. Turn on **myDevTeam.telemetry.evalLog** ' +
      'to collect per-run token statistics (route, per-step model, and token ' +
      'counts) for analysis here. Nothing leaves your machine.\n',
    /** Header of the usage report; `runs` is how many runs it summarizes. */
    reportHeader: (runs: number) =>
      `# My Dev Team - token usage\n\n_${runs} run${runs === 1 ? '' : 's'} recorded._\n`,
  },

  /**
   * Copy for the single "My Dev Team" status-bar button: its text, the rich
   * hover (a trusted MarkdownString with command links, like Copilot's), and
   * the quick-pick menu a click opens. The one item replaces the former
   * separate model and token-counter items: the bar is just the brand, and the
   * live model label and running session token total ride in the hover and the
   * two menu rows.
   */
  status: {
    /** The status-bar button text - the brand, no live figures. */
    statusBar: '$(rocket) My Dev Team',
    /**
     * The rich hover shown over the button: the live model and session token
     * total, then clickable command links. The caller passes the command ids
     * so the copy stays free of UI wiring; each link is a `command:` URI the
     * trusted MarkdownString is allowed to invoke. Markdown, with `$(icon)`
     * codicons (the hover sets `supportThemeIcons`).
     */
    tooltip: (opts: {
      model: string;
      tokens: string;
      estimated: boolean;
      selectModelCommand: string;
      usageCommand: string;
      setKeyCommand: string;
    }): string =>
      `**My Dev Team**\n\n` +
      `---\n\n` +
      `Model: **${opts.model}**  \n` +
      `Tokens this session: **${opts.estimated ? '~' : ''}${opts.tokens}**\n\n` +
      `---\n\n` +
      `[$(sparkle) Select model](command:${opts.selectModelCommand} "Choose the model for @devteam")\n\n` +
      `[$(symbol-number) Token usage report](command:${opts.usageCommand} "Open the token usage report")\n\n` +
      `[$(key) Set API key](command:${opts.setKeyCommand} "Store a cloud provider API key (local engine)")`,
    /** Placeholder atop the quick-pick menu the button opens. */
    menuPlaceholder: 'My Dev Team',
    /** The "change model" row, showing the currently-active model. */
    menuModel: (label: string) => `$(sparkle) Select model  -  current: ${label}`,
    /** The "open usage report" row, showing this session's running token total. */
    menuUsage: (total: string, estimated: boolean) =>
      `$(symbol-number) Token usage  -  ${estimated ? '~' : ''}${total} this session`,
  },

  /**
   * Copy for the tool approval gates. `run` is always gated; `write` and `edit`
   * are gated only when the user turns on `myDevTeam.approval.fileChanges` (off
   * by default, since the workspace is git-backed - see docs/DESIGN.md).
   */
  approval: {
    runCommandTitle: 'Run command',
    /** Title of the write approval prompt (gated by myDevTeam.approval.fileChanges). */
    writeFileTitle: 'Write file',
    /** Title of the edit approval prompt (gated by myDevTeam.approval.fileChanges). */
    editFileTitle: 'Edit file',
    /** The preview shown for a write/edit approval: the target file path. */
    fileChangeDetail: (path: string) => path,
    /**
     * The preview shown for a run approval: the command, prefixed with a
     * shell-comment naming its cwd folder in a multi-root workspace (where the
     * command runs in the first folder). A single-folder workspace omits the
     * line, so the preview is just the command as before.
     */
    runCommandDetail: (command: string, cwdFolder?: string) =>
      cwdFolder ? `# cwd: ${cwdFolder}\n$ ${command}` : `$ ${command}`,
    /** Title of an MCP tool-call approval prompt (every MCP call is gated). */
    mcpToolTitle: 'Call MCP tool',
    /**
     * The preview shown for an MCP tool-call approval: the namespaced tool name
     * (which carries the server name) and a compact preview of its arguments.
     */
    mcpToolDetail: (tool: string, argsPreview: string) => `${tool}\n${argsPreview}`,
    /** The in-chat approval question: the action title plus its preview. */
    block: (title: string, detail: string) =>
      `\n\n**${title}?**\n\n${fence(detail, 3)}\n`,
    /** Labels of the approval choices (the modal fallback still uses Approve). */
    approve: 'Approve',
    decline: 'Decline',
    /**
     * The Approve/Decline choices rendered as inline trusted-markdown command
     * links, so they appear on one line instead of as VS Code's stacked
     * buttons. `command` is the approval command id and `id` identifies the
     * pending approval; both links invoke the same command with the approval id
     * and the chosen boolean. Command-link arguments must be URI-encoded JSON.
     */
    links: (command: string, id: string) => {
      const arg = (approved: boolean) =>
        encodeURIComponent(JSON.stringify([id, approved]));
      return (
        `[**${messages.approval.approve}**](command:${command}?${arg(true)}) | ` +
        `[**${messages.approval.decline}**](command:${command}?${arg(false)})\n`
      );
    },
  },

  /** Returned to the model when the user declines a gated tool. */
  notApproved: {
    run: 'Command was not approved by the user.',
    write: 'Write was not approved by the user.',
    edit: 'Edit was not approved by the user.',
    mcp: 'MCP tool call was not approved by the user.',
  },

  /**
   * Returned to the model when a side-effecting tool is disabled by the
   * workspace mode rather than declined. An untrusted folder (VS Code
   * Restricted Mode) disables run/write/edit; a virtual workspace (no local
   * filesystem) disables run. Read and search stay available in both. The
   * model relays the reason instead of reporting an opaque failure, and no
   * approval prompt is shown for an action that cannot run.
   */
  restricted: {
    run:
      'This workspace is not trusted, so the run tool is disabled. Trust the ' +
      'workspace (Restricted Mode banner, or the "Workspaces: Manage Workspace ' +
      'Trust" command) and try again.',
    write:
      'This workspace is not trusted, so the write tool is disabled. Trust the ' +
      'workspace (Restricted Mode banner, or the "Workspaces: Manage Workspace ' +
      'Trust" command) and try again.',
    edit:
      'This workspace is not trusted, so the edit tool is disabled. Trust the ' +
      'workspace (Restricted Mode banner, or the "Workspaces: Manage Workspace ' +
      'Trust" command) and try again.',
  },

  /**
   * Returned to the model when `write`/`edit` refuse a path that, although
   * inside the workspace, falls in a protected location (`.git/`, `.vscode/`,
   * ...). These can run code on their own (git hooks, VS Code tasks) without
   * passing the run tool's approval gate, so the agent must not change them; the
   * model relays the reason and leaves the change to the user.
   */
  protected: {
    write: (path: string) =>
      `Refusing to write ${path}: it is in a protected location (it can run ` +
      'code automatically, e.g. git hooks or VS Code tasks). If this change is ' +
      'really needed, tell the user to make it themselves.',
    edit: (path: string) =>
      `Refusing to edit ${path}: it is in a protected location (it can run ` +
      'code automatically, e.g. git hooks or VS Code tasks). If this change is ' +
      'really needed, tell the user to make it themselves.',
  },

  /** Returned to the model when a tool cannot run in a virtual workspace. */
  virtual: {
    run:
      'This is a virtual workspace with no local filesystem, so the run tool ' +
      '(which starts a shell process) is not available here. Reading, ' +
      'searching, writing, and editing files still work.',
  },

  /**
   * Returned to the model when the request was cancelled before a tool
   * applied, so it can note the skip in its report. `run` is the only gated
   * tool, but `write`/`edit` are still cancellable mid-run by the stop button.
   */
  cancelled: {
    run: 'Command was cancelled before running.',
    write: 'Write was cancelled; the file was not changed.',
    edit: 'Edit was cancelled; the file was not changed.',
  },

  /**
   * Header prepended to a read result that does not cover the whole file: the
   * range shown, the file's total line count, and (when the file goes on)
   * where the next call should continue.
   */
  read: {
    range: (start: number, end: number, total: number) =>
      `(lines ${start}-${end} of ${total}` +
      (end < total ? `; continue with startLine ${end + 1})` : ')'),
  },

  /**
   * Returned to the model when a read range cannot be satisfied. Each message
   * says how to recover, so the executor's loop self-corrects instead of
   * retrying the same failing call.
   */
  readFailed: {
    pastEnd: (path: string, start: number, total: number) =>
      `${path} has only ${total} lines; startLine ${start} is past the end ` +
      'of the file.',
    emptyRange: (start: number, end: number) =>
      `endLine ${end} is before startLine ${start}; nothing was read. ` +
      'Use an endLine at or after startLine.',
    tooLarge: (path: string, bytes: number, cap: number) =>
      `${path} is ${bytes} bytes, over the ${cap}-byte read limit; reading it ` +
      'whole would risk the editor\'s memory. Use the search tool to find the ' +
      'lines you need in it.',
  },

  /**
   * Returned to the model when an edit cannot be applied. Each message says
   * how to recover, so the executor's loop self-corrects instead of retrying
   * the same failing call.
   */
  editFailed: {
    missingFile: (path: string) =>
      `File does not exist: ${path}. Use the write tool to create a new file.`,
    notFound: (path: string) =>
      `oldText was not found in ${path}. Read the file and copy the text to ` +
      'replace exactly, including whitespace and indentation.',
    multipleMatches: (count: number, path: string) =>
      `oldText matches ${count} places in ${path}. Include more surrounding ` +
      'lines so it matches exactly one place.',
    identical: 'oldText and newText are identical; nothing to change.',
  },

  /** Copy for the terminal mirroring the run tool's commands (ui/runTerminal.ts). */
  terminal: {
    /** Tab name of the mirror terminal in the terminal panel. */
    name: 'Dev Team',
    /** Header line echoed before each command's output. */
    prompt: (command: string) => `$ ${command}`,
    /** Outcome note written after a command that finished cleanly. */
    completed: '(command completed)',
  },

  /** Copy for the `search` tool. */
  search: {
    /**
     * Appended to a content search that stopped at the files-examined budget
     * with candidate files still unscanned, so the model knows a short or empty
     * result on a large repo is not authoritative and can narrow its query.
     */
    contentTruncated: (scanned: number) =>
      `(search stopped after scanning ${scanned} files; more files were not ` +
      'searched - narrow the query or use a glob search to look in fewer files)',
  },

  /** Copy for the chat handler's attachment resolution. */
  attachments: {
    /** Stands in for an attached file too large to inline (or even read). */
    tooLarge: (bytes: number) =>
      `(attachment skipped: the file is ${bytes} bytes, too large to inline; ` +
      'attach a selection from it instead)',
  },

  /** Copy for the inline prompt references the client resolves (client/references.ts). */
  references: {
    /** Stands in for an attached reference of a kind we cannot inline. */
    unsupported: '(a reference of an unsupported type was attached and skipped)',
    /** Label of the `#codebase` attachment, naming the search terms used. */
    codebaseLabel: (terms: string) => `Codebase search: ${terms}`,
    /** Heading above the list of files a `#codebase` search matched. */
    codebaseHeader: (terms: string) => `Files matching ${terms}:\n`,
    /** Body when no distinctive search terms could be derived from the prompt. */
    codebaseNoTerms:
      '(no distinctive search terms could be derived from your message; ' +
      'mention a name, symbol, or keyword to search for)',
    /** Body when the search terms matched no files in the workspace. */
    codebaseNoMatches: (terms: string) =>
      `(no files in the workspace matched: ${terms})`,
    /** Label of the `#changes` attachment. */
    changesLabel: 'Uncommitted git changes',
    /** Body when there are no uncommitted changes (or git is unavailable). */
    changesEmpty: '(no uncommitted git changes, or git is not available here)',
  },

  /**
   * Copy for the editor entry points (ui/editorEntryPoints.ts): the quick fix
   * on a diagnostic, the "explain selection" context-menu action, and the
   * test-file CodeLens. Each is a thin shim that opens the chat with a pinned
   * slash command, so the strings here are the chat prompt the shim submits
   * (framed for the downstream agents) and the action/lens titles - the slash
   * command itself is prepended by the shim, not spelled out here.
   */
  editor: {
    /** Title of the "Fix with Dev Team" quick fix offered on a diagnostic. */
    fixActionTitle: 'Fix with Dev Team',
    /** One problem line for fixPrompt: where the diagnostic is and what it says. */
    fixProblem: (line: number, message: string) => `line ${line}: ${message}`,
    /**
     * The chat prompt the fix action submits (behind `/fix`): names the file and
     * each reported problem, and pulls in the uncommitted diff with `#changes`
     * so the agent diagnoses against what actually changed.
     */
    fixPrompt: (relPath: string, problems: readonly string[]) =>
      `#changes Fix the following problem${problems.length === 1 ? '' : 's'} ` +
      `reported in ${relPath}:\n` +
      problems.map((p) => `- ${p}`).join('\n'),
    /** Title of the "Explain with Dev Team" editor context-menu action. */
    explainActionTitle: 'Explain with Dev Team',
    /** Shown when explain is invoked with nothing selected in the editor. */
    explainNoSelection: 'My Dev Team: select some code first, then run Explain with Dev Team.',
    /**
     * The chat prompt the explain action submits (behind `/explain`), carrying
     * the selected code inline so the answerer sees exactly what to explain.
     */
    explainPrompt: (relPath: string, startLine: number, endLine: number, code: string) => {
      const where =
        endLine > startLine
          ? `${relPath} (lines ${startLine}-${endLine})`
          : `${relPath} (line ${startLine})`;
      return `Explain this code from ${where}:\n\n${fence(code, 3)}`;
    },
    /** Title of the test CodeLens when the file has no current failures. */
    testLensWrite: '$(beaker) Write/update tests with Dev Team',
    /** Title of the test CodeLens when the file has failing diagnostics. */
    testLensRepair: '$(beaker) Repair tests with Dev Team',
    /**
     * The chat prompt the test CodeLens submits (behind `/test`): repair when
     * the file currently has error diagnostics, otherwise write or update.
     */
    testPrompt: (relPath: string, failing: boolean) =>
      failing
        ? `Some tests in ${relPath} are failing. Diagnose why each fails and ` +
          `repair them, then run them to confirm.`
        : `Write or update the tests in ${relPath}, then run them.`,
  },

  /** Copy for the client-side /clear command (it never starts a run). */
  clear: {
    /** The whole reply to a /clear turn. */
    confirmation:
      'Context cleared - the conversation so far will not accompany future requests.',
    /** Appended when the /clear turn also carried a message. */
    ignoredPrompt:
      ' Your message was not processed; send it again as the next request.',
  },

  triage: {
    // Complexity is no longer shown here: the planner's (post-exploration)
    // judgement is the one surfaced, and it rides in the plan block (see
    // `plan.complexity`) so the value never changes after it is first rendered -
    // the append-only chat stream needs every render to extend the last.
    block: (intent: string, reason: string) =>
      `**Detected intent:** \`${intent}\`\n\n` + `**Reason:** ${reason}\n\n`,
    error: (detail: string) => `**Triage error:** ${detail}\n\n`,
  },

  answer: {
    error: (detail: string) => `**Answerer error:** ${detail}\n\n`,
    // A prefix rather than a template: the renderer streams the answer text
    // in behind it while the model is still writing it.
    header: '**Answer:**\n\n',
  },

  plan: {
    error: (detail: string) => `**Planner error:** ${detail}\n\n`,
    // A prefix rather than a template: the renderer streams the summary in
    // behind it while the planner is still writing it.
    header: '**Plan:** ',
    /**
     * The planner's complexity judgement, rendered as a line after the plan's
     * steps (an append-only position, so a value that streams in late never
     * breaks the prefix-extension the chat stream relies on). This is the one
     * complexity shown - the planner's, not triage's.
     */
    complexity: (complexity: string) => `\n\n**Complexity:** \`${complexity}\``,
    /**
     * Appended to a finished reply that drafted a plan but never executed it
     * (the /plan command, or a plan cancelled at the approval gate), so the
     * user knows nothing has happened yet and how to proceed.
     */
    notExecuted:
      '\n\n_Plan only - nothing was executed. Say "go ahead" to carry it out._',
  },

  /**
   * Copy for the plan-approval gate (`myDevTeam.planApproval`): the question
   * shown after a plan that needs approving, its inline Approve/Cancel/Revise
   * command links, and the input box the Revise choice opens. Mirrors the
   * `approval` copy used for the run tool.
   */
  planApproval: {
    /** The gate question, naming the planner's complexity judgement. */
    block: (complexity: string) =>
      `\n\n**Approve this plan before it runs?** (complexity: \`${complexity}\`)\n`,
    approve: 'Approve',
    cancel: 'Cancel',
    revise: 'Revise',
    /**
     * The three choices as inline trusted-markdown command links (one line, like
     * the run approval). `command` is the plan-review command id and `id`
     * identifies the pending review; each link invokes the command with the id
     * and the chosen action. Command-link arguments must be URI-encoded JSON.
     */
    links: (command: string, id: string) => {
      const arg = (choice: 'approve' | 'cancel' | 'revise') =>
        encodeURIComponent(JSON.stringify([id, choice]));
      return (
        `[${messages.planApproval.approve}](command:${command}?${arg('approve')}) | ` +
        `[${messages.planApproval.cancel}](command:${command}?${arg('cancel')}) | ` +
        `[${messages.planApproval.revise}](command:${command}?${arg('revise')})\n`
      );
    },
    /** Title/placeholder of the input box the Revise choice opens. */
    revisePrompt: 'How should the plan change?',
    revisePlaceholder: 'Describe what to do differently; the plan is redrafted and shown again.',
  },

  execution: {
    error: (detail: string) => `**Executor error:** ${detail}\n\n`,
    // A prefix rather than a template: the transcript streams in behind it
    // while the executor is still working.
    header: '**Execution:**',
    /**
     * One transcript line per tool call (no bullet, the bolded display name
     * leads the line); the result is appended when it lands.
     */
    call: (tool: string, input: string) => `\n\n**${tool}** \`${input}\``,
    result: (preview: string, failed: boolean) =>
      failed ? ` → **failed** \`${preview}\`` : ` → \`${preview}\``,
    /**
     * Fenced snippet of a call's content argument (e.g. the first lines of a
     * written file), shown under the call line. The fence is at least four
     * backticks, grown longer when the snippet itself contains a run that long,
     * so snippet lines containing ``` (or more) cannot break out of it.
     */
    snippet: (snippet: string) => '\n\n' + fence(snippet, 4),
    /** Shown in a result slot when the tool produced no output at all. */
    emptyResult: '(no output)',
    /**
     * A self-reported progress snapshot the executor prints from time to time:
     * a markdown checklist of plan steps with their status. The caller resolves
     * each reported step number to its plan title before calling this; a "done"
     * step is checked, an "in_progress" step is noted, a "pending" step is bare.
     */
    progress: (items: readonly { title: string; status: ProgressStatus }[]) =>
      '\n\n**Progress:**\n' +
      items
        .map((item) => {
          const box = item.status === 'done' ? '[x]' : '[ ]';
          const note = item.status === 'in_progress' ? ' _(in progress)_' : '';
          return `- ${box} ${item.title}${note}`;
        })
        .join('\n'),
  },

  summary: {
    // Prefixes rather than templates: each section streams in behind its
    // header while the summarizer is still writing it, so successive renders
    // stay prefix-extensions of one another (the append-only streamer's
    // requirement). All start with a blank line so the section sits apart from
    // the execution transcript above and the previous section.
    header: '\n\n**Summary:**',
    whatShips: '\n\n**What ships:** ',
    howItsBuilt: "\n\n**How it's built:** ",
    testsAndDocs: '\n\n**Tests and docs:** ',
  },

  run: {
    /** Shown when a run fails without a step the protocol could attribute it to. */
    error: (detail: string) => `**The run failed:** ${detail}\n\n`,
  },

  thinking: {
    /**
     * A condensed line of the model's reasoning, shown as transient chat
     * progress (a spinner line) while it works - not appended to the reply, so
     * it leaves no trace once real output streams in. The "Thinking:" lead
     * tells the user the dimmed line is the model's reasoning, not its answer.
     */
    line: (text: string) => `Thinking: ${text}`,
  },

  /** Copy for the engine switch (client/engineFactory.ts). */
  engine: {
    remoteUnavailable:
      'My Dev Team: the remote engine is not available yet; using the local engine. ' +
      'Set "myDevTeam.engine" back to "local" to hide this warning.',
  },

  /** Warnings the engines' startup probes may surface (ui/startupCheck.ts). */
  startup: {
    unreachable: (endpoint: string) =>
      `My Dev Team: cannot reach Ollama at ${endpoint}. ` +
      'Start it with "ollama serve", or point the "myDevTeam.ollama.endpoint" setting at your server.',
    missingModels: (models: readonly string[]) =>
      `My Dev Team: Ollama is missing the model(s) the router selected: ${models.join(', ')}. ` +
      'Pull them with "ollama pull <model>".',
  },
} as const;
