/**
 * Agent configuration registry. Each agent is described by a `.md` file in
 * ./agents: frontmatter carries the structured fields (id, name, description,
 * model role, tool list) and the markdown body is the system prompt. esbuild's
 * text loader inlines each file as a string at build time (see package.json
 * `package` script and config/markdown.d.ts), so this is all resolved on
 * import with no runtime file I/O.
 *
 * The body never hardcodes tool descriptions: a `{{tools}}` placeholder (or,
 * absent one, the end of the prompt) is filled with a section rendered from
 * the frontmatter `tools` list and the configs in ./tools. Agent classes in
 * src/core import from here, never from the `.md` files directly.
 */
import { z } from 'zod';
import { parseFrontmatter } from './frontmatter';
import { modelConfig, ModelRole } from './modelConfig';
import { toolNames, renderToolsSection } from './tools';
import intentClassifier from './agents/intentClassifier.md';
import planner from './agents/planner.md';

const TOOLS_PLACEHOLDER = '{{tools}}';

const AgentFrontmatterSchema = z.object({
  /** Stable agent id, used as the Mastra Agent id. */
  id: z.string(),
  /** Human-readable agent name. */
  name: z.string(),
  /** One-line summary of what the agent does. */
  description: z.string(),
  /** Which semantic model role drives this agent (see modelConfig). */
  model: z.enum(Object.keys(modelConfig) as [ModelRole, ...ModelRole[]]),
  /** Names of the tools (see ./tools) this agent may plan with. */
  tools: z.array(z.enum(toolNames as [string, ...string[]])).default([]),
});

export interface AgentConfig extends z.infer<typeof AgentFrontmatterSchema> {
  /** Full system prompt: the markdown body with the tools section rendered in. */
  instructions: string;
}

function buildInstructions(body: string, tools: readonly string[]): string {
  const section = tools.length > 0 ? renderToolsSection(tools) : '';
  return body.includes(TOOLS_PLACEHOLDER)
    ? body.replace(TOOLS_PLACEHOLDER, section)
    : [body, section].filter(Boolean).join('\n\n');
}

function loadAgent(raw: string): AgentConfig {
  const { data, body } = parseFrontmatter(raw);
  const meta = AgentFrontmatterSchema.parse(data);
  return { ...meta, instructions: buildInstructions(body.trim(), meta.tools) };
}

export const agents = {
  intentClassifier: loadAgent(intentClassifier),
  planner: loadAgent(planner),
} as const;

export type AgentName = keyof typeof agents;
