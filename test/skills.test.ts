import { describe, it, expect } from 'vitest';

import {
  builtinSkills,
  loadSkills,
  resolveSkills,
  renderSkillsSection,
} from '../src/engine/config/skills';

const SKILL = (name: string, description: string, body: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;

describe('built-in skills', () => {
  it('loads every built-in skill with a name, description, and body', () => {
    expect(builtinSkills.length).toBeGreaterThan(0);
    for (const skill of builtinSkills) {
      expect(skill.name).toBeTruthy();
      expect(skill.description).toBeTruthy();
      expect(skill.body).toBeTruthy();
    }
  });

  it('rejects duplicate skill names', () => {
    expect(() =>
      loadSkills([SKILL('dup', 'one', 'a'), SKILL('dup', 'two', 'b')])
    ).toThrow(/Duplicate skill name "dup"/);
  });
});

describe('resolveSkills', () => {
  it('merges built-in skills into the catalogue and bodies', () => {
    const { catalogue, bodies } = resolveSkills();
    for (const skill of builtinSkills) {
      expect(catalogue.some((c) => c.name === skill.name)).toBe(true);
      expect(bodies.get(skill.name)).toBe(skill.body);
    }
  });

  it('adds a workspace skill and lets it override a built-in of the same name', () => {
    const existing = builtinSkills[0].name;
    const { catalogue, bodies } = resolveSkills([
      { source: 'a/SKILL.md', text: SKILL('brand-new', 'a fresh skill', 'fresh body') },
      { source: 'b/SKILL.md', text: SKILL(existing, 'overridden', 'overridden body') },
    ]);
    // The new skill appears.
    expect(catalogue.find((c) => c.name === 'brand-new')?.description).toBe('a fresh skill');
    expect(bodies.get('brand-new')).toBe('fresh body');
    // The workspace skill overrides the built-in body and description, without
    // duplicating the entry.
    expect(catalogue.filter((c) => c.name === existing)).toHaveLength(1);
    expect(bodies.get(existing)).toBe('overridden body');
    expect(catalogue.find((c) => c.name === existing)?.description).toBe('overridden');
  });

  it('keeps the first discovered skill when a name appears more than once', () => {
    // The client ships skills highest precedence first (workspace before home),
    // so the first occurrence of a name must win - and both still override a
    // built-in of that name.
    const { catalogue, bodies } = resolveSkills([
      { source: '.devteam/skills/demo/SKILL.md', text: SKILL('demo', 'from workspace', 'workspace body') },
      { source: '~/.devteam/skills/demo/SKILL.md', text: SKILL('demo', 'from home', 'home body') },
    ]);
    expect(catalogue.filter((c) => c.name === 'demo')).toHaveLength(1);
    expect(catalogue.find((c) => c.name === 'demo')?.description).toBe('from workspace');
    expect(bodies.get('demo')).toBe('workspace body');
  });

  it('drops a malformed workspace skill instead of throwing', () => {
    const before = resolveSkills().catalogue.length;
    const { catalogue } = resolveSkills([
      { source: 'bad/SKILL.md', text: '---\nname: missing-description\n---\n\nbody' },
      { source: 'ok/SKILL.md', text: SKILL('ok', 'fine', 'body') },
    ]);
    expect(catalogue.find((c) => c.name === 'ok')).toBeDefined();
    expect(catalogue.find((c) => c.name === 'missing-description')).toBeUndefined();
    expect(catalogue.length).toBe(before + 1);
  });

  it('caps an over-long skill body', () => {
    const huge = 'x'.repeat(20_000);
    const { bodies } = resolveSkills([
      { source: 'big/SKILL.md', text: SKILL('big', 'big', huge) },
    ]);
    const body = bodies.get('big')!;
    expect(body.length).toBeLessThan(huge.length);
    expect(body.endsWith('. . . (truncated)')).toBe(true);
  });
});

describe('renderSkillsSection', () => {
  it('renders one line per skill', () => {
    const section = renderSkillsSection([
      { name: 'one', description: 'first' },
      { name: 'two', description: 'second' },
    ]);
    expect(section).toContain('--- Available skills ---');
    expect(section).toContain('- "one": first');
    expect(section).toContain('- "two": second');
  });

  it('is empty when there are no skills', () => {
    expect(renderSkillsSection([])).toBe('');
  });
});
