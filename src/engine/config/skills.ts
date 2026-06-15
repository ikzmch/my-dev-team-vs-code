/**
 * Skill configuration registry. A skill is a named, described block of
 * instructions the executor loads on demand: when a task matches a skill's
 * description, the model calls its `skill` tool (see ../core/agentTools.ts) to
 * read the full body, then follows it (progressive disclosure - only the
 * name + description ride in the prompt until a skill is used).
 *
 * Skills come from two sources, merged per run by `resolveSkills`:
 *
 * - **Built-in** skills are `.md` files in ./skills, discovered by the glob
 *   import at build time like the commands and tools - dropping a file in
 *   registers it. Each has frontmatter (name, description) and a markdown body.
 * - **Workspace** skills are SKILL.md files the client read from the user's
 *   workspace (see src/client/skills.ts) and shipped as raw text on the run
 *   request. The engine parses them with the same frontmatter parser; a
 *   malformed one is dropped (best-effort, never fails the run), and a workspace
 *   skill overrides a built-in one of the same name (user customization wins).
 *
 * Only the executor consumes skills (it is the one agent with a runtime
 * tool-calling loop), and the parsed bodies never touch the wire: the client
 * ships raw text, the engine owns the single parser.
 */
import { z } from 'zod';
import { parseFrontmatter } from './frontmatter';
import { settings } from '../../config/settings';
import skillFiles from 'glob:./skills/*.md';

const SkillFrontmatterSchema = z.object({
  /** Short name the model loads the skill by (also the override key). */
  name: z.string(),
  /** One-line summary of when the skill applies, shown in the executor's catalogue. */
  description: z.string(),
});

export interface SkillConfig extends z.infer<typeof SkillFrontmatterSchema> {
  /** The skill's full instructions (the markdown body of the file). */
  body: string;
}

/** One skill as the executor's prompt lists it: name + description only. */
export interface SkillSummary {
  name: string;
  description: string;
}

/**
 * The per-run skill set the executor works with: the catalogue (name +
 * description) rendered into its prompt, and the bodies its `skill` tool returns
 * when the model loads one by name.
 */
export interface ResolvedSkills {
  catalogue: SkillSummary[];
  bodies: Map<string, string>;
}

function loadSkill(raw: string): SkillConfig {
  const { data, body } = parseFrontmatter(raw);
  return { ...SkillFrontmatterSchema.parse(data), body: body.trim() };
}

/**
 * Parse a set of built-in skill config files, rejecting duplicate names: a
 * duplicate would silently shadow its predecessor in the resolved map.
 */
export function loadSkills(files: readonly string[]): SkillConfig[] {
  const skills = files.map(loadSkill);
  const seen = new Set<string>();
  for (const skill of skills) {
    if (seen.has(skill.name)) {
      throw new Error(`Duplicate skill name "${skill.name}" in config/skills.`);
    }
    seen.add(skill.name);
  }
  return skills;
}

/** The built-in skills, in config-filename order. */
export const builtinSkills: SkillConfig[] = loadSkills(skillFiles);

/** A raw skill as the run request carries it (text + its path). */
export interface RawWorkspaceSkill {
  source: string;
  text: string;
}

/**
 * Merge the built-in skills with the run's discovered skills (the client ships
 * them as raw text) into the executor's catalogue and body map. Precedence,
 * highest first: a **discovered** skill overrides a built-in one of the same
 * name (a user's skill wins), and among the discovered skills the **first**
 * occurrence of a name wins - the client orders them highest precedence first
 * (workspace skills before home-directory skills), so a project's skill beats a
 * personal one of the same name. A malformed skill is dropped rather than
 * failing the run. Each body is capped to `settings.skills.maxChars` so a large
 * skill cannot blow the model's context.
 */
export function resolveSkills(discovered?: readonly RawWorkspaceSkill[]): ResolvedSkills {
  const byName = new Map<string, SkillConfig>();
  for (const skill of builtinSkills) {
    byName.set(skill.name, skill);
  }
  // Names already claimed by a discovered skill: a later (lower precedence)
  // discovered skill with the same name does not displace the first one, even
  // though both still override any built-in of that name.
  const claimed = new Set<string>();
  for (const raw of discovered ?? []) {
    let skill: SkillConfig;
    try {
      skill = loadSkill(raw.text);
    } catch {
      continue; // Malformed frontmatter: skip it, keep the run going.
    }
    if (claimed.has(skill.name)) {
      continue; // A higher-precedence discovered skill already won this name.
    }
    claimed.add(skill.name);
    byName.set(skill.name, skill);
  }
  const max = settings.skills.maxChars;
  const catalogue: SkillSummary[] = [];
  const bodies = new Map<string, string>();
  for (const skill of byName.values()) {
    catalogue.push({ name: skill.name, description: skill.description });
    bodies.set(
      skill.name,
      skill.body.length > max ? skill.body.slice(0, max) + '\n. . . (truncated)' : skill.body
    );
  }
  return { catalogue, bodies };
}

/**
 * Render the executor prompt's "Available skills" section from a catalogue: one
 * line per skill naming it and when it applies. Empty string when there are no
 * skills, so the section is omitted entirely.
 */
export function renderSkillsSection(catalogue: readonly SkillSummary[]): string {
  if (catalogue.length === 0) {
    return '';
  }
  const lines = catalogue.map((skill) => `- "${skill.name}": ${skill.description}`);
  return `--- Available skills ---\n${lines.join('\n')}\n--- End of available skills ---`;
}
