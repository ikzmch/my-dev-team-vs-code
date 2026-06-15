import { describe, it, expect, beforeEach, vi } from 'vitest';

// Control the home directory the client scans for personal skills, without
// touching the real one. The rest of `os` is left intact.
const { homedirMock } = vi.hoisted(() => ({ homedirMock: vi.fn<[], string>(() => '/home/test') }));
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: homedirMock }, homedir: homedirMock };
});

import { collectSkills } from '../src/client/skills';
import { settings } from '../src/config/settings';
import { __reset, __setConfig, __setFile, __setFileAbs, __state } from './mocks/vscode';

const SKILL = (name: string, body: string) =>
  `---\nname: ${name}\ndescription: a skill\n---\n\n${body}\n`;

beforeEach(() => {
  __reset();
  homedirMock.mockReturnValue('/home/test');
});

describe('collectSkills', () => {
  it('returns an empty array when no skill file exists', async () => {
    expect(await collectSkills()).toEqual([]);
  });

  it('reads a SKILL.md found under a workspace skills directory', async () => {
    __setFile('.devteam/skills/demo/SKILL.md', SKILL('demo', 'do the thing'));
    const skills = await collectSkills();
    expect(skills).toHaveLength(1);
    expect(skills[0].source).toBe('.devteam/skills/demo/SKILL.md');
    expect(skills[0].text).toContain('name: demo');
    expect(skills[0].text).toContain('do the thing');
  });

  it('reads a SKILL.md from the home directory, labelling its source with ~', async () => {
    __setFileAbs('/home/test/.claude/skills/personal/SKILL.md', SKILL('personal', 'home body'));
    const skills = await collectSkills();
    expect(skills).toHaveLength(1);
    expect(skills[0].source).toBe('~/.claude/skills/personal/SKILL.md');
    expect(skills[0].text).toContain('home body');
  });

  it('lists a workspace skill before a home skill of the same name (workspace wins)', async () => {
    __setFile('.devteam/skills/demo/SKILL.md', SKILL('demo', 'workspace body'));
    __setFileAbs('/home/test/.devteam/skills/demo/SKILL.md', SKILL('demo', 'home body'));
    const skills = await collectSkills();
    // Both are shipped (the engine de-dups by name); the workspace one comes
    // first so the engine keeps it.
    expect(skills.map((s) => s.source)).toEqual([
      '.devteam/skills/demo/SKILL.md',
      '~/.devteam/skills/demo/SKILL.md',
    ]);
    expect(skills[0].text).toContain('workspace body');
  });

  it('scans every configured directory, in order', async () => {
    __setFileAbs('/home/test/.claude/skills/a/SKILL.md', SKILL('a', 'a'));
    __setFile('.claude/skills/b/SKILL.md', SKILL('b', 'b'));
    __setFile('.devteam/skills/c/SKILL.md', SKILL('c', 'c'));
    const sources = (await collectSkills()).map((s) => s.source);
    // Workspace roots first (.devteam before .claude by the default list order),
    // then home.
    expect(sources).toEqual([
      '.devteam/skills/c/SKILL.md',
      '.claude/skills/b/SKILL.md',
      '~/.claude/skills/a/SKILL.md',
    ]);
  });

  it('ignores a stray file directly under a skills directory', async () => {
    // A loose file (not in a <name>/ subfolder) is not a skill.
    __setFile('.devteam/skills/README.md', 'not a skill');
    expect(await collectSkills()).toEqual([]);
  });

  it('skips a folder without a SKILL.md and a blank SKILL.md', async () => {
    __setFile('.devteam/skills/empty/other.md', 'no skill file here');
    __setFile('.devteam/skills/blank/SKILL.md', '   \n\t\n');
    expect(await collectSkills()).toEqual([]);
  });

  it('truncates an oversized skill file to the configured cap', async () => {
    __setFile('.devteam/skills/big/SKILL.md', 'x'.repeat(settings.skills.maxChars + 500));
    const skills = await collectSkills();
    expect(skills[0].text.endsWith('(truncated)')).toBe(true);
    expect(skills[0].text.length).toBeLessThanOrEqual(
      settings.skills.maxChars + '\n. . . (truncated)'.length
    );
  });

  it('stops at the configured maximum number of skills', async () => {
    for (let i = 0; i <= settings.skills.maxSkills; i++) {
      __setFile(`.devteam/skills/s${i}/SKILL.md`, SKILL(`s${i}`, 'body'));
    }
    expect(await collectSkills()).toHaveLength(settings.skills.maxSkills);
  });

  it('is disabled by an empty configured directory list', async () => {
    __setFile('.devteam/skills/demo/SKILL.md', SKILL('demo', 'body'));
    __setConfig('myDevTeam.skills.directories', []);
    expect(await collectSkills()).toEqual([]);
  });

  it('still reads home skills when there is no workspace folder', async () => {
    __setFileAbs('/home/test/.devteam/skills/personal/SKILL.md', SKILL('personal', 'body'));
    __state.workspaceFolders = undefined;
    const skills = await collectSkills();
    expect(skills.map((s) => s.source)).toEqual(['~/.devteam/skills/personal/SKILL.md']);
  });

  it('returns an empty array when the home directory cannot be determined', async () => {
    homedirMock.mockReturnValue('');
    __state.workspaceFolders = undefined;
    expect(await collectSkills()).toEqual([]);
  });
});

describe('settings.skills.directories', () => {
  it('defaults to .devteam/skills then .claude/skills', () => {
    expect(settings.skills.directories).toEqual(['.devteam/skills', '.claude/skills']);
  });

  it('accepts a custom list, trimming whitespace and trailing slashes', () => {
    __setConfig('myDevTeam.skills.directories', [' skills/ ', '.claude/skills']);
    expect(settings.skills.directories).toEqual(['skills', '.claude/skills']);
  });

  it('accepts an empty list (the off switch)', () => {
    __setConfig('myDevTeam.skills.directories', []);
    expect(settings.skills.directories).toEqual([]);
  });

  it('falls back when an entry is absolute or could escape the root', () => {
    for (const bad of [['../secrets'], ['/etc/skills'], ['C:\\skills'], ['skills', 42]]) {
      __setConfig('myDevTeam.skills.directories', bad);
      expect(settings.skills.directories).toEqual(['.devteam/skills', '.claude/skills']);
    }
  });
});
