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
      `\`${label}\` needs an API key. Run the "My Dev Team: Set API Key" command ` +
      `(or set the ${envVar} environment variable), then try again.\n\n`
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
    setKeyInputPrompt: (provider: string) => `Paste your ${provider} API key (stored securely; leave empty to clear)`,
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
   * Copy for the single "My Dev Team" status-bar button and the menu it opens.
   * The one item replaces the former separate model and token-counter items:
   * the bar is just the brand, and the live model label and running session
   * token total ride in the two menu rows.
   */
  status: {
    /** The status-bar button text - the brand, no live figures. */
    statusBar: '$(rocket) My Dev Team',
    statusBarTooltip: 'My Dev Team - click for model and token usage',
    /** Placeholder atop the quick-pick menu the button opens. */
    menuPlaceholder: 'My Dev Team',
    /** The "change model" row, showing the currently-active model. */
    menuModel: (label: string) => `$(sparkle) Select model  -  current: ${label}`,
    /** The "open usage report" row, showing this session's running token total. */
    menuUsage: (total: string, estimated: boolean) =>
      `$(symbol-number) Token usage  -  ${estimated ? '~' : ''}${total} this session`,
  },

  /**
   * Copy for the `run` tool's approval gate. Only `run` is gated; `write` and
   * `edit` are not (the workspace is git-backed, so their changes are
   * recoverable - see DESIGN.md).
   */
  approval: {
    runCommandTitle: 'Run command',
    /** The in-chat approval question: the action title plus its preview. */
    block: (title: string, detail: string) =>
      `\n\n**${title}?**\n\n${fence(detail, 3)}\n`,
    /** Labels of the in-chat approval buttons. */
    approve: 'Approve',
    decline: 'Decline',
  },

  /** Returned to the model when the user declines the (gated) run tool. */
  notApproved: {
    run: 'Command was not approved by the user.',
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
     * Appended to a finished reply that drafted a plan but never executed it
     * (the /plan command), so the user knows nothing has happened yet and how
     * to proceed.
     */
    notExecuted:
      '\n\n_Plan only - nothing was executed. Say "go ahead" to carry it out._',
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

  run: {
    /** Shown when a run fails without a step the protocol could attribute it to. */
    error: (detail: string) => `**The run failed:** ${detail}\n\n`,
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
