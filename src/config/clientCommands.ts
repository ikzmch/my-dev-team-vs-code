/**
 * The client's slash command knowledge, kept apart from the engine's command
 * registry (engine/config/commands): these commands act on client-owned
 * state. The conversation history is collected client-side on every turn (the
 * engine is stateless and receives it in the run request), so resetting or
 * replacing it cannot be an engine behavior.
 *
 * Like the engine commands, the names and descriptions here must also be
 * declared in package.json (`contributes.chatParticipants[].commands`) for
 * VS Code's autocomplete; the commands unit test keeps the lists in sync.
 */

/**
 * Commands the chat handler answers itself - they never start an engine run.
 */
export const clientCommands = [
  {
    name: 'clear',
    description: 'Start fresh: drop the conversation so far from future requests.',
  },
] as const;

/** The /clear command: later turns drop all history before its marker. */
export const CLEAR_COMMAND = clientCommands[0].name;

/**
 * Name of the engine command whose successful reply (the summary) replaces
 * all earlier turns when later history is collected. The name is repeated
 * here deliberately rather than imported: the client may not reach into
 * engine internals, and the commands unit test asserts the engine registry
 * actually knows a command of this name.
 */
export const COMPACT_COMMAND = 'compact';
