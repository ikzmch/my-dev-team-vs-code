/**
 * Runtime environment facts for the model-facing text. The models only know
 * what the prompts tell them: without this, a model defaults to Linux habits
 * and the `run` tool gets `ls`/`grep` on a Windows machine. One module owns
 * the facts so the prompt text and the shell the `run` tool actually spawns
 * (tools/workspaceTools.ts) can never disagree.
 *
 * Consumed in two places: `config/tools.ts` substitutes `{{os}}`/`{{shell}}`
 * placeholders in the tool descriptions, and `config/agents.ts` substitutes
 * an `{{environment}}` placeholder in the agent prompts with
 * `renderEnvironmentSection`.
 */

export interface EnvironmentInfo {
  /** Human-readable operating system name (e.g. "Windows"). */
  os: string;
  /** Shell name the model should write commands for (e.g. "PowerShell"). */
  shell: string;
  /**
   * Shell executable the `run` tool passes to child_process exec, or
   * undefined to use the platform default (/bin/sh). On Windows the default
   * would be cmd.exe; PowerShell is used instead because models write it far
   * more reliably and its Unix-style aliases (ls, cat, rm, ...) absorb
   * residual Linux habits.
   */
  execShell: string | undefined;
}

/** Map a Node platform identifier to the environment facts for it. */
export function describeEnvironment(platform: NodeJS.Platform): EnvironmentInfo {
  if (platform === 'win32') {
    return { os: 'Windows', shell: 'PowerShell', execShell: 'powershell.exe' };
  }
  if (platform === 'darwin') {
    return { os: 'macOS', shell: 'POSIX sh', execShell: undefined };
  }
  return { os: 'Linux', shell: 'POSIX sh', execShell: undefined };
}

/** The environment this extension host is actually running on. */
export const environment = describeEnvironment(process.platform);

/**
 * Render the environment section of an agent's system prompt (the
 * `{{environment}}` placeholder in config/agents/*.md).
 */
export function renderEnvironmentSection(env: EnvironmentInfo = environment): string {
  return (
    `Environment: the workspace runs on ${env.os} and shell commands ` +
    `execute in ${env.shell}. Always use ${env.shell} syntax for commands, ` +
    `never commands for another operating system.`
  );
}
