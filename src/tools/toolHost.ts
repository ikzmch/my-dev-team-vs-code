/**
 * The extension's ToolHost: the one place a tool call from an engine (or from
 * the editor's Language Model Tools surface, see registerTools.ts) is
 * validated and dispatched onto the workspace implementations. Whichever
 * engine is selected - in-process today, remote later - the hands stay here:
 * file access, the shell, the approval gate, and the run mirror all live on
 * the user's machine, so an engine can only ever *ask* for a side effect.
 */
import { Approver, RunMirror } from './types';
import { readFile, searchFiles, runCommand, writeFile } from './workspaceTools';
import { clientTools, clientToolNames, ToolHost } from '../protocol/toolContract';

export class WorkspaceToolHost implements ToolHost {
  readonly tools: readonly string[] = clientToolNames;

  constructor(
    private readonly approver: Approver,
    private readonly mirror?: RunMirror
  ) {}

  /**
   * Validate the arguments against the protocol's input schema for the tool,
   * then run the workspace implementation. Inputs are untrusted twice over -
   * they come from a model, possibly relayed by a remote engine - so an
   * unknown tool or malformed arguments throw before anything touches the
   * workspace; the path and approval checks inside the implementations then
   * still apply.
   */
  async execute(tool: string, args: unknown, signal?: AbortSignal): Promise<string> {
    switch (tool) {
      case 'read': {
        const { path } = clientTools.read.inputSchema.parse(args);
        return readFile(path);
      }
      case 'search': {
        const { query, mode } = clientTools.search.inputSchema.parse(args);
        const results = await searchFiles(query, mode);
        return results.length ? results.join('\n') : '(no matches)';
      }
      case 'run': {
        const { command } = clientTools.run.inputSchema.parse(args);
        return runCommand(command, this.approver, this.mirror, signal);
      }
      case 'write': {
        const { path, contents } = clientTools.write.inputSchema.parse(args);
        return writeFile(path, contents, this.approver, signal);
      }
      default:
        throw new Error(`Unknown tool "${tool}".`);
    }
  }
}
