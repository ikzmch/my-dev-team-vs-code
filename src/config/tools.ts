/**
 * Tool configuration registry. Each tool the agents can plan with is described
 * by a `.md` file in ./tools, discovered by the glob import at build time:
 * frontmatter carries the structured fields (name,
 * displayName, the Language Model Tools API id it registers as, whether it is
 * side-effecting), and the markdown body is the model-facing description.
 *
 * Agents list the tools they may use in their own frontmatter (see agents.ts);
 * `renderToolsSection` turns that list into the "available tools" prompt
 * section, so prompts never hardcode tool descriptions. The implementations
 * live in src/tools/workspaceTools.ts; the VS Code contribution (input
 * schemas) stays declarative in package.json as the API requires.
 */
import { z } from 'zod';
import { parseFrontmatter } from './frontmatter';
import toolFiles from 'glob:./tools/*.md';

const ToolFrontmatterSchema = z.object({
  /** Short name agents and plan steps refer to the tool by. */
  name: z.string(),
  /** Human-readable name, matching the package.json contribution. */
  displayName: z.string(),
  /** Id the tool registers under in the Language Model Tools API. */
  lmTool: z.string(),
  /** Side-effecting tools are gated by the Approver before they act. */
  sideEffecting: z.boolean(),
  /**
   * Input argument whose value summarises a call in the execution transcript
   * (e.g. "path" for write, so the user sees the file name rather than the
   * raw args JSON with the file contents). Optional: without it the
   * transcript falls back to a compact JSON preview of all arguments.
   */
  previewArg: z.string().optional(),
});

export interface ToolConfig extends z.infer<typeof ToolFrontmatterSchema> {
  /** Model-facing description (the markdown body of the config file). */
  description: string;
}

function loadTool(raw: string): ToolConfig {
  const { data, body } = parseFrontmatter(raw);
  return { ...ToolFrontmatterSchema.parse(data), description: body.trim() };
}

/**
 * Parse a set of tool config files, rejecting duplicate names: `toolConfigs`
 * is keyed by name, so a duplicate would silently overwrite its predecessor.
 */
export function loadTools(files: readonly string[]): ToolConfig[] {
  const tools = files.map(loadTool);
  const seen = new Set<string>();
  for (const tool of tools) {
    if (seen.has(tool.name)) {
      throw new Error(`Duplicate tool name "${tool.name}" in config/tools.`);
    }
    seen.add(tool.name);
  }
  return tools;
}

const all = loadTools(toolFiles);

export const toolConfigs: Record<string, ToolConfig> = Object.fromEntries(
  all.map((tool) => [tool.name, tool])
);

/** Tool names in config-filename order; the source of truth for tool enums. */
export const toolNames = all.map((tool) => tool.name);

/**
 * Render the "available tools" section of an agent's system prompt from the
 * agent's configured tool list.
 */
export function renderToolsSection(names: readonly string[]): string {
  const lines = names.map((name) => {
    const tool = toolConfigs[name];
    if (!tool) {
      throw new Error(`Unknown tool "${name}" in agent configuration.`);
    }
    const approval = tool.sideEffecting ? ' Requires user approval.' : '';
    return `- "${tool.name}": ${tool.description}${approval}`;
  });
  return `You have exactly ${names.length} tools available:\n${lines.join('\n')}`;
}
