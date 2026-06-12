import { describe, it, expect, beforeEach } from 'vitest';
import { collectInstructions } from '../src/client/instructions';
import { settings } from '../src/config/settings';
import { __reset, __setConfig, __setFile, __state } from './mocks/vscode';

beforeEach(() => {
  __reset();
});

describe('collectInstructions', () => {
  it('returns undefined when no instruction file exists', async () => {
    expect(await collectInstructions()).toBeUndefined();
  });

  it('reads AGENTS.md from the workspace root', async () => {
    __setFile('AGENTS.md', 'Always run the tests.');
    expect(await collectInstructions()).toEqual({
      source: 'AGENTS.md',
      text: 'Always run the tests.',
    });
  });

  it('falls back to CLAUDE.md when AGENTS.md is missing', async () => {
    __setFile('CLAUDE.md', 'Use tabs.');
    expect(await collectInstructions()).toEqual({
      source: 'CLAUDE.md',
      text: 'Use tabs.',
    });
  });

  it('prefers AGENTS.md when both files exist', async () => {
    __setFile('AGENTS.md', 'agents rules');
    __setFile('CLAUDE.md', 'claude rules');
    expect((await collectInstructions())?.source).toBe('AGENTS.md');
  });

  it('skips a blank file and falls through to the next candidate', async () => {
    __setFile('AGENTS.md', '   \n\t\n');
    __setFile('CLAUDE.md', 'real rules');
    expect(await collectInstructions()).toEqual({
      source: 'CLAUDE.md',
      text: 'real rules',
    });
  });

  it('truncates an oversized file to the configured cap', async () => {
    __setFile('AGENTS.md', 'x'.repeat(settings.instructions.maxChars + 100));
    const result = await collectInstructions();
    expect(result?.text.length).toBeLessThanOrEqual(
      settings.instructions.maxChars + '\n…(truncated)'.length
    );
    expect(result?.text.endsWith('…(truncated)')).toBe(true);
  });

  it('is disabled by an empty configured file list', async () => {
    __setFile('AGENTS.md', 'rules');
    __setConfig('myDevTeam.instructions.files', []);
    expect(await collectInstructions()).toBeUndefined();
  });

  it('respects a configured candidate order', async () => {
    __setFile('AGENTS.md', 'agents rules');
    __setFile('TEAM.md', 'team rules');
    __setConfig('myDevTeam.instructions.files', ['TEAM.md', 'AGENTS.md']);
    expect((await collectInstructions())?.source).toBe('TEAM.md');
  });

  it('returns undefined when there is no workspace folder', async () => {
    __setFile('AGENTS.md', 'rules');
    __state.workspaceFolders = undefined;
    expect(await collectInstructions()).toBeUndefined();
  });
});

describe('settings.instructions.files', () => {
  it('defaults to AGENTS.md then CLAUDE.md', () => {
    expect(settings.instructions.files).toEqual(['AGENTS.md', 'CLAUDE.md']);
  });

  it('accepts a valid custom list and trims the names', () => {
    __setConfig('myDevTeam.instructions.files', [' TEAM.md ', 'AGENTS.md']);
    expect(settings.instructions.files).toEqual(['TEAM.md', 'AGENTS.md']);
  });

  it('accepts an empty list (the off switch)', () => {
    __setConfig('myDevTeam.instructions.files', []);
    expect(settings.instructions.files).toEqual([]);
  });

  it('falls back on a non-array value', () => {
    __setConfig('myDevTeam.instructions.files', 'AGENTS.md');
    expect(settings.instructions.files).toEqual(['AGENTS.md', 'CLAUDE.md']);
  });

  it('falls back when an entry could escape the workspace root', () => {
    for (const bad of [
      ['../secrets.md'],
      ['docs/AGENTS.md'],
      ['docs\\AGENTS.md'],
      ['AGENTS.md', ''],
      ['AGENTS.md', 42],
    ]) {
      __setConfig('myDevTeam.instructions.files', bad);
      expect(settings.instructions.files).toEqual(['AGENTS.md', 'CLAUDE.md']);
    }
  });
});
