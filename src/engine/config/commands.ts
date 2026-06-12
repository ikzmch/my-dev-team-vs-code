/**
 * Slash command configuration registry. Each command the chat participant
 * offers is described by a `.md` file in ./commands, discovered by the glob
 * import at build time: frontmatter carries the structured fields (name,
 * description, the pinned intent, whether a drafted plan is executed) and the
 * markdown body is a preamble rendered ahead of the user's prompt for the
 * downstream agents.
 *
 * A command does exactly two things:
 *
 * - **Pins the route.** The workflow's triage step returns the command's
 *   `intent` without calling the triage model - the user typing /fix already
 *   *is* the routing decision, so the model call would only add latency and
 *   a chance to misroute. `execute: false` (the /plan command) additionally
 *   stops a planning run after the plan is drafted.
 * - **Frames the request.** The preamble (the file's body) is prepended to
 *   the prompt the planner, answerer, and executor see, so e.g. /fix briefs
 *   the agents to diagnose before editing.
 *
 * The command names and descriptions must also be declared statically in
 * package.json (`contributes.chatParticipants[].commands`) for VS Code's
 * autocomplete; a unit test asserts the two lists match, so drift fails CI.
 */
import { z } from 'zod';
import { parseFrontmatter } from './frontmatter';
import { IntentSchema } from '../../protocol/types';
import commandFiles from 'glob:./commands/*.md';

const CommandFrontmatterSchema = z.object({
  /** Command name as the user types it, without the slash. */
  name: z.string(),
  /** One-line summary, shown in the chat's command autocomplete. */
  description: z.string(),
  /** The route the command pins; the triage model is not called. */
  intent: IntentSchema,
  /**
   * Whether a drafted plan is executed. Only meaningful for "planning"
   * commands: /plan sets it false so the run stops after the plan.
   */
  execute: z.boolean().default(true),
});

export interface CommandConfig extends z.infer<typeof CommandFrontmatterSchema> {
  /** Preamble rendered ahead of the user's prompt (the markdown body). */
  preamble: string;
}

function loadCommand(raw: string): CommandConfig {
  const { data, body } = parseFrontmatter(raw);
  return { ...CommandFrontmatterSchema.parse(data), preamble: body.trim() };
}

/**
 * Parse a set of command config files, rejecting duplicate names:
 * `commandConfigs` is keyed by name, so a duplicate would silently overwrite
 * its predecessor.
 */
export function loadCommands(files: readonly string[]): CommandConfig[] {
  const commands = files.map(loadCommand);
  const seen = new Set<string>();
  for (const command of commands) {
    if (seen.has(command.name)) {
      throw new Error(`Duplicate command name "${command.name}" in config/commands.`);
    }
    seen.add(command.name);
  }
  return commands;
}

const all = loadCommands(commandFiles);

export const commandConfigs: Record<string, CommandConfig> = Object.fromEntries(
  all.map((command) => [command.name, command])
);

/** Command names in config-filename order. */
export const commandNames = all.map((command) => command.name);

/**
 * The reason rendered into the triage decision when a command pins the
 * route - the user-visible counterpart of the skipped triage model call.
 */
export function pinnedReason(name: string): string {
  return `Requested via /${name}.`;
}
