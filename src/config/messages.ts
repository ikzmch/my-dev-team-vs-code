/**
 * User-facing copy for the chat UI: error text and the markdown templates
 * the reply renderer uses. Kept out of the logic so the wording can be tuned
 * without editing control flow. Functions take only the dynamic bits; static
 * prose lives here.
 *
 * Deliberately knows nothing about agents or models: the error templates
 * render a detail the protocol delivered, and the Ollama troubleshooting
 * hint is a template the LocalEngine fills in - which model is routed where
 * is engine knowledge the client no longer has.
 */

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

  /** Copy for the side-effecting tools' approval gate. */
  approval: {
    runCommandTitle: 'Run command',
    writeFileTitle: 'Write file',
    editFileTitle: 'Edit file',
    /**
     * Preview of a pending write shown in the approval question: the target
     * path above the leading new contents (already capped by the caller, see
     * settings.writeApprovalPreviewMaxChars).
     */
    writeFileDetail: (path: string, preview: string) => `${path}\n\n${preview}`,
    /**
     * Preview of a pending edit shown in the approval question: the target
     * path above a diff-style old/new pair, each side's lines prefixed so the
     * user sees exactly what is removed and what replaces it (both sides
     * already capped by the caller).
     */
    editFileDetail: (path: string, oldText: string, newText: string) => {
      const prefix = (mark: string, text: string) =>
        text.split('\n').map((line) => `${mark} ${line}`).join('\n');
      return `${path}\n\n${prefix('-', oldText)}\n${prefix('+', newText)}`;
    },
    /** The in-chat approval question: the action title plus its preview. */
    block: (title: string, detail: string) =>
      `\n\n**${title}?**\n\n${fence(detail, 3)}\n`,
    /** Labels of the in-chat approval buttons. */
    approve: 'Approve',
    decline: 'Decline',
  },

  /** Returned to the model when the user declines a side-effecting tool. */
  notApproved: {
    run: 'Command was not approved by the user.',
    write: 'Write was not approved by the user; the file was not changed.',
    edit: 'Edit was not approved by the user; the file was not changed.',
  },

  /**
   * Returned to the model when the request was cancelled before a
   * side-effecting tool applied, so it can note the skip in its report.
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
