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
import { toolConfigs } from '../config/tools';
import { clientTools, ClientToolName, ToolHost } from '../../protocol/toolContract';

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

  return {
    read: proxy('read'),
    search: proxy('search'),
    run: proxy('run'),
    write: proxy('write'),
    edit: proxy('edit'),
  };
}

export type AgentTools = ReturnType<typeof buildAgentTools>;
