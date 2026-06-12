/**
 * Agent configuration registry. Each agent is described by a `.md` file in
 * ./agents: frontmatter carries the structured fields (id, name, description,
 * model role, tool list) and the markdown body is the system prompt. esbuild's
 * text loader inlines each file as a string at build time (see package.json
 * `package` script and config/markdown.d.ts), so this is all resolved on
 * import with no runtime file I/O.
 *
 * Agents do not name a concrete model. Their frontmatter declares weighted
 * capability requirements (see ./models), and the router picks the best
 * registered model for that profile at wiring time (core/models.ts).
 *
 * The body never hardcodes tool descriptions: a `{{tools}}` placeholder (or,
 * absent one, the end of the prompt) is filled with a section rendered from
 * the frontmatter `tools` list and the configs in ./tools. An optional
 * `{{environment}}` placeholder is filled with the runtime OS/shell facts
 * from ./environment, so prompts never hardcode a platform. Agent classes in
 * src/core import from here, never from the `.md` files directly.
 */
import { z } from 'zod';
import { parseFrontmatter } from './frontmatter';
import { CapabilityScoresSchema } from './models';
import { toolNames, renderToolsSection } from './tools';
import { renderEnvironmentSection } from './environment';
import triage from './agents/triage.md';
import planner from './agents/planner.md';
import answerer from './agents/answerer.md';
import executor from './agents/executor.md';

const TOOLS_PLACEHOLDER = '{{tools}}';
const ENVIRONMENT_PLACEHOLDER = '{{environment}}';

const AgentFrontmatterSchema = z.object({
  /** Stable agent id, used as the Mastra Agent id. */
  id: z.string(),
  /** Human-readable agent name. */
  name: z.string(),
  /** One-line summary of what the agent does. */
  description: z.string(),
  /**
   * How much each capability matters to this agent (0–1 weights). The router
   * matches these against the scores in the model registry (see models.ts)
   * and wires the best-fitting model — agents never name a concrete model.
   */
  capabilities: CapabilityScoresSchema,
  /** Names of the tools (see ./tools) this agent may plan with. */
  tools: z.array(z.enum(toolNames as [string, ...string[]])).default([]),
});

export interface AgentConfig extends z.infer<typeof AgentFrontmatterSchema> {
  /** Full system prompt: the markdown body with the tools section rendered in. */
  instructions: string;
}

function buildInstructions(body: string, tools: readonly string[]): string {
  const withEnvironment = body.replace(
    ENVIRONMENT_PLACEHOLDER,
    renderEnvironmentSection()
  );
  const section = tools.length > 0 ? renderToolsSection(tools) : '';
  return withEnvironment.includes(TOOLS_PLACEHOLDER)
    ? withEnvironment.replace(TOOLS_PLACEHOLDER, section)
    : [withEnvironment, section].filter(Boolean).join('\n\n');
}

function loadAgent(raw: string): AgentConfig {
  const { data, body } = parseFrontmatter(raw);
  const meta = AgentFrontmatterSchema.parse(data);
  return { ...meta, instructions: buildInstructions(body.trim(), meta.tools) };
}

export const agents = {
  triage: loadAgent(triage),
  planner: loadAgent(planner),
  answerer: loadAgent(answerer),
  executor: loadAgent(executor),
} as const;

export type AgentName = keyof typeof agents;
