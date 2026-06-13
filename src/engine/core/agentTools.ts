/**
 * The engine-side tool proxies for the executor's tool-calling loop. Each
 * Mastra tool here is a thin delegate onto the client's ToolHost - the tool
 * inversion at the heart of the engine/client split: the engine decides
 * *when* to call a tool, the client owns *how* it runs (implementation,
 * workspace access, approval). The LocalEngine hands the host straight in; a
 * remote engine will satisfy the same calls with tool-call events over the
 * wire, and the executor cannot tell the difference.
 *
 * Names and descriptions come from the engine's tool configs
 * (../config/tools/*.md) - the same registry the planner's tool enum and the
 * agents' prompt sections are rendered from. Input schemas come from the
 * protocol's tool contract, so what the model is asked to produce is exactly
 * what the host validates against.
 */
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { toolConfigs } from '../config/tools';
import { ProgressStatusSchema } from '../../protocol/types';
import { clientTools, ClientToolName, ToolHost } from '../../protocol/toolContract';

/** Name of the engine-only progress tool (see ../config/tools/progress.md). */
export const PROGRESS_TOOL = 'progress';

/**
 * Input the executor's `progress` tool takes: the plan steps to show and their
 * statuses. Unlike the workspace tools this never reaches the client - the
 * executor intercepts the call and turns it into a `progress` execution event
 * (see executor.ts), so the schema lives here, next to the tool, rather than
 * in the protocol's client tool contract.
 */
export const ProgressReportSchema = z.object({
  items: z
    .array(
      z.object({
        step: z
          .number()
          .int()
          .min(1)
          .describe('The 1-based number of the plan step, as drafted.'),
        status: ProgressStatusSchema.describe(
          'Where that step stands: "pending", "in_progress", or "done".'
        ),
      })
    )
    .describe('The plan steps to show, in the order to display them.'),
});

/**
 * The executor's tools observe the current run's AbortSignal so a cancelled
 * chat request stops them mid-flight (a running command is killed, a pending
 * write is dropped). The signal is per-run while the toolset is built once
 * per Executor, so it is read through a getter the Executor updates each run
 * rather than captured here.
 */
export function buildAgentTools(
  host: ToolHost,
  getSignal?: () => AbortSignal | undefined
) {
  const proxy = (name: ClientToolName) => {
    const config = toolConfigs[name];
    if (!config) {
      throw new Error(`Tool "${name}" has no engine-side config in config/tools.`);
    }
    return createTool({
      id: config.name,
      description: config.description,
      inputSchema: clientTools[name].inputSchema,
      execute: async (args) => host.execute(name, args, getSignal?.()),
    });
  };

  // The progress tool is engine-only: it has no client implementation and no
  // approval gate, so it is built here instead of through `proxy`. Its execute
  // just acknowledges - the executor reads the call's arguments off the stream
  // and renders them; nothing has to come back through the model.
  const progressConfig = toolConfigs[PROGRESS_TOOL];
  if (!progressConfig) {
    throw new Error(`Tool "${PROGRESS_TOOL}" has no engine-side config in config/tools.`);
  }
  const progress = createTool({
    id: progressConfig.name,
    description: progressConfig.description,
    inputSchema: ProgressReportSchema,
    execute: async () => 'Progress shown to the user.',
  });

  return {
    read: proxy('read'),
    search: proxy('search'),
    run: proxy('run'),
    write: proxy('write'),
    edit: proxy('edit'),
    progress,
  };
}

export type AgentTools = ReturnType<typeof buildAgentTools>;
