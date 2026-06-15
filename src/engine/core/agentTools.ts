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
import { convertJsonSchemaToZod } from 'zod-from-json-schema';
import { toolConfigs } from '../config/tools';
import { DynamicToolDef, ProgressStatusSchema } from '../../protocol/types';
import { clientTools, ClientToolName, ToolHost } from '../../protocol/toolContract';

/** Name of the engine-only progress tool (see ../config/tools/progress.md). */
export const PROGRESS_TOOL = 'progress';

/** Name of the engine-only skill tool (see ../config/tools/skill.md). */
export const SKILL_TOOL = 'skill';

/**
 * Input the executor's `skill` tool takes: the name of the skill to load. Like
 * `progress` this never reaches the client - the executor resolves the body
 * from the per-run skill set the engine assembled (built-in + workspace skills,
 * see ../config/skills.ts), so the schema lives here rather than in the
 * protocol's client tool contract.
 */
export const SkillInputSchema = z.object({
  name: z.string().describe('The name of the skill to load, as listed in "Available skills".'),
});

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
/**
 * Convert an MCP tool's published JSON Schema to a zod schema for Mastra, so
 * the model is told the tool's argument shape. Best effort: a schema that fails
 * to convert (or is not object-shaped) falls back to a permissive object, since
 * the client's MCP server is what actually validates the call's arguments - the
 * engine-side schema is only there to brief the model.
 */
function dynamicInputSchema(jsonSchema: unknown): z.ZodTypeAny {
  try {
    const schema = convertJsonSchemaToZod(jsonSchema as Record<string, unknown>);
    return schema as z.ZodTypeAny;
  } catch {
    return z.object({}).passthrough();
  }
}

export function buildAgentTools(
  host: ToolHost,
  getSignal?: () => AbortSignal | undefined,
  // The per-run skill bodies the `skill` tool returns by name (built-in +
  // workspace skills, resolved by the workflow). Absent or empty means no
  // skills are available, and the tool says so when called.
  skillBodies?: ReadonlyMap<string, string>,
  // The run's discovered MCP tools (client/mcp.ts), each surfaced as a proxy
  // that delegates to the host like the built-in tools. Absent or empty means
  // no MCP tools this run.
  dynamicTools?: readonly DynamicToolDef[]
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

  // The skill tool is engine-only like progress: no client implementation and
  // no approval gate. Its execute returns the loaded skill's body, which Mastra
  // feeds back to the model as the tool result (progressive disclosure - the
  // body enters the model's context only when a skill is actually loaded). An
  // unknown name returns a short notice rather than throwing, so the run keeps
  // going.
  const skillConfig = toolConfigs[SKILL_TOOL];
  if (!skillConfig) {
    throw new Error(`Tool "${SKILL_TOOL}" has no engine-side config in config/tools.`);
  }
  const skill = createTool({
    id: skillConfig.name,
    description: skillConfig.description,
    inputSchema: SkillInputSchema,
    execute: async ({ name }) => {
      const body = skillBodies?.get(name);
      if (body !== undefined) {
        return body;
      }
      const available = skillBodies && skillBodies.size > 0
        ? `Available skills: ${[...skillBodies.keys()].join(', ')}.`
        : 'No skills are available.';
      return `No skill named "${name}". ${available}`;
    },
  });

  // MCP tools have no engine-side `.md` config; their name, description, and
  // input schema all come from the run request (the server published them).
  // Each is a plain proxy onto the host - the host gates the call through the
  // Approver, exactly like a side-effecting built-in tool.
  const dynamic: Record<string, ReturnType<typeof createTool>> = {};
  for (const def of dynamicTools ?? []) {
    dynamic[def.name] = createTool({
      id: def.name,
      description: def.description,
      inputSchema: dynamicInputSchema(def.inputSchema),
      execute: async (args) => host.execute(def.name, args, getSignal?.()),
    });
  }

  return {
    read: proxy('read'),
    search: proxy('search'),
    run: proxy('run'),
    write: proxy('write'),
    edit: proxy('edit'),
    progress,
    skill,
    ...dynamic,
  };
}

export type AgentTools = ReturnType<typeof buildAgentTools>;

/**
 * Render the executor prompt's "Additional tools" section from the run's MCP
 * tools: one line per tool naming it and what it does, flagged as requiring
 * approval (every MCP call is gated). Empty string when there are none, so the
 * section is omitted entirely. Mirrors `renderSkillsSection`.
 */
export function renderDynamicToolsSection(defs: readonly DynamicToolDef[]): string {
  if (defs.length === 0) {
    return '';
  }
  const lines = defs.map(
    (def) => `- "${def.name}": ${def.description} Requires user approval.`
  );
  return (
    '--- Additional tools (from connected MCP servers) ---\n' +
    lines.join('\n') +
    '\n--- End of additional tools ---'
  );
}
