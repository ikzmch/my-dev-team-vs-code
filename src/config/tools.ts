/**
 * Tool configuration registry. Each tool the agents can plan with is described
 * by a `.md` file in ./tools: frontmatter carries the structured fields (name,
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
import read from './tools/read.md';
import search from './tools/search.md';
import run from './tools/run.md';
import write from './tools/write.md';

const ToolFrontmatterSchema = z.object({
  /** Short name agents and plan steps refer to the tool by. */
  name: z.string(),
  /** Human-readable name, matching the package.json contribution. */
  displayName: z.string(),
  /** Id the tool registers under in the Language Model Tools API. */
  lmTool: z.string(),
  /** Side-effecting tools are gated by the Approver before they act. */
  sideEffecting: z.boolean(),
});

export interface ToolConfig extends z.infer<typeof ToolFrontmatterSchema> {
  /** Model-facing description (the markdown body of the config file). */
  description: string;
}

function loadTool(raw: string): ToolConfig {
  const { data, body } = parseFrontmatter(raw);
  return { ...ToolFrontmatterSchema.parse(data), description: body.trim() };
}

const all = [read, search, run, write].map(loadTool);

export const toolConfigs: Record<string, ToolConfig> = Object.fromEntries(
  all.map((tool) => [tool.name, tool])
);

/** Tool names in declaration order; the source of truth for tool enums. */
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
