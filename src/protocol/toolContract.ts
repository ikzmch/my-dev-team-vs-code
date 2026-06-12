/**
 * The tool half of the protocol: the names, input schemas, and client-facing
 * identity of the workspace tools the client offers an engine.
 *
 * The split mirrors the trust boundary. The client owns the implementations
 * (src/tools/) plus everything user-facing about a tool - its editor-wide
 * Language Model Tools id and the display name transcripts render. The engine
 * owns everything model-facing - the descriptions its prompts carry and the
 * preview/snippet rendering hints (src/engine/config/tools/*.md). This module
 * is what both sides must agree on for a call to cross the boundary: which
 * tools exist and what arguments they take.
 *
 * The input schemas deliberately match the package.json
 * `contributes.languageModelTools` declarations; their describe() strings are
 * the argument documentation both surfaces show a model.
 */
import { z } from 'zod';

export const clientTools = {
  read: {
    lmToolId: 'devteam__read',
    displayName: 'Read File',
    inputSchema: z.object({
      path: z.string().describe('Workspace-relative path of the file to read.'),
    }),
  },
  search: {
    lmToolId: 'devteam__search',
    displayName: 'Search Files',
    inputSchema: z.object({
      query: z
        .string()
        .describe('Glob pattern (e.g. **/*.ts) or text to search for.'),
      mode: z
        .enum(['glob', 'content'])
        .describe(
          'Whether to match file names by glob or search file contents for text.'
        ),
    }),
  },
  run: {
    lmToolId: 'devteam__run',
    displayName: 'Run Command',
    inputSchema: z.object({
      command: z.string().describe('The shell command to execute.'),
    }),
  },
  write: {
    lmToolId: 'devteam__write',
    displayName: 'Write File',
    inputSchema: z.object({
      path: z
        .string()
        .describe('Workspace-relative path of the file to create or update.'),
      contents: z.string().describe('The full new contents of the file.'),
    }),
  },
} as const;

export type ClientToolName = keyof typeof clientTools;

/** The tool names a client can offer, in a stable order. */
export const clientToolNames = Object.keys(clientTools) as ClientToolName[];

/**
 * The client-side tool executor. The implementation lives in the extension
 * (it touches the user's files, shell, and approval UI) and is handed to the
 * engine with each run: the LocalEngine calls it directly, a remote engine
 * reaches it through tool-call events answered with `ToolResultMessage`s.
 * Approval is internal to the host - an engine only ever sees the returned
 * text (a declined command returns its "not approved" message, not an error).
 */
export interface ToolHost {
  /** Names of the tools this host implements (the run's `offeredTools`). */
  readonly tools: readonly string[];
  /**
   * Execute one tool. `args` is validated against the tool's input schema
   * before anything runs; an unknown tool or invalid arguments throw. The
   * returned string is exactly what the model sees as the tool result.
   */
  execute(tool: string, args: unknown, signal?: AbortSignal): Promise<string>;
}

/**
 * The client's answer to a `tool-call` event (the client-to-engine half of
 * the tool round trip). Unused by the LocalEngine, which calls the ToolHost
 * in-process; defined now so the wire contract is complete.
 */
export interface ToolResultMessage {
  callId: string;
  /** The tool's returned text; absent when the call threw. */
  result?: string;
  /** The thrown error's message; absent when the call returned. */
  error?: string;
}
