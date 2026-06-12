/**
 * Mastra-facing adapter over the workspace tools, mirroring registerTools.ts:
 * that file exposes the four implementations to the editor via the Language
 * Model Tools API, this one exposes the same implementations to the executor
 * agent's tool-calling loop via Mastra's `createTool`. Names and descriptions
 * come from the tool configs (config/tools/*.md) - the same registry the
 * planner's tool enum and the agents' prompt sections are rendered from - and
 * the zod input schemas mirror the package.json contribution. Side-effecting
 * tools receive the shared Approver, exactly as in registerTools.ts.
 */
import { z } from 'zod';
import { createTool } from '@mastra/core/tools';
import { Approver, RunMirror } from '../core/types';
import { toolConfigs } from '../config/tools';
import { readFile, searchFiles, runCommand, writeFile } from './workspaceTools';

/**
 * The side-effecting tools observe the current run's AbortSignal so a
 * cancelled chat request stops them mid-flight (a running command is killed, a
 * pending write is dropped). The signal is per-run while the toolset is built
 * once per Executor, so it is read through a getter the Executor updates each
 * run rather than captured here.
 */
export function buildAgentTools(
  approver: Approver,
  mirror?: RunMirror,
  getSignal?: () => AbortSignal | undefined
) {
  return {
    read: createTool({
      id: toolConfigs.read.name,
      description: toolConfigs.read.description,
      inputSchema: z.object({
        path: z.string().describe('Workspace-relative path of the file to read.'),
      }),
      execute: async ({ path }) => readFile(path),
    }),

    search: createTool({
      id: toolConfigs.search.name,
      description: toolConfigs.search.description,
      inputSchema: z.object({
        query: z
          .string()
          .describe('Glob pattern (e.g. **/*.ts) or text to search for.'),
        mode: z
          .enum(['glob', 'content'])
          .describe('Whether to match file names by glob or search file contents for text.'),
      }),
      execute: async ({ query, mode }) => {
        const results = await searchFiles(query, mode);
        return results.length ? results.join('\n') : '(no matches)';
      },
    }),

    run: createTool({
      id: toolConfigs.run.name,
      description: toolConfigs.run.description,
      inputSchema: z.object({
        command: z.string().describe('The shell command to execute.'),
      }),
      execute: async ({ command }) =>
        runCommand(command, approver, mirror, getSignal?.()),
    }),

    write: createTool({
      id: toolConfigs.write.name,
      description: toolConfigs.write.description,
      inputSchema: z.object({
        path: z
          .string()
          .describe('Workspace-relative path of the file to create or update.'),
        contents: z.string().describe('The full new contents of the file.'),
      }),
      execute: async ({ path, contents }) =>
        writeFile(path, contents, getSignal?.()),
    }),
  };
}

export type AgentTools = ReturnType<typeof buildAgentTools>;
