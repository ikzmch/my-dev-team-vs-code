import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  buildRipgrepArgs,
  parseRipgrepMatches,
  searchContentRipgrep,
  searchContent,
  previewLine,
} from '../src/tools/contentSearch';
import { settings } from '../src/config/settings';
import {
  __reset,
  __state,
  __setFile,
  __setWorkspaceFolders,
} from './mocks/vscode';

beforeEach(() => {
  __reset();
});

/** Build a ripgrep `--json` "match" event line for a path/line/text. */
function matchEvent(path: string, lineNumber: number, text: string): string {
  return JSON.stringify({
    type: 'match',
    data: {
      path: { text: path },
      lines: { text },
      line_number: lineNumber,
      absolute_offset: 0,
      submatches: [],
    },
  });
}

describe('buildRipgrepArgs', () => {
  it('asks for json, fixed-strings, the per-file and size caps, and excludes', () => {
    const args = buildRipgrepArgs('needle');
    expect(args).toContain('--json');
    expect(args).toContain('--fixed-strings');
    expect(args).toContain(`--max-count=${settings.search.contentMaxMatchesPerFile}`);
    expect(args).toContain(`--max-filesize=${settings.search.maxFileSizeBytes}`);
    // The exclude globs are derived from the brace expression.
    expect(args).toContain('--glob=!**/node_modules/**');
    expect(args).toContain('--glob=!**/.git/**');
  });

  it('places the query after -- so a leading-dash query is not a flag', () => {
    const args = buildRipgrepArgs('-rf');
    const sep = args.indexOf('--');
    expect(sep).toBeGreaterThanOrEqual(0);
    expect(args[sep + 1]).toBe('-rf');
    expect(args[sep + 2]).toBe('.');
  });
});

describe('parseRipgrepMatches', () => {
  const id = (p: string) => p;

  it('parses match events into path/line/preview, skipping other events', () => {
    const stdout = [
      JSON.stringify({ type: 'begin', data: { path: { text: 'a.ts' } } }),
      matchEvent('a.ts', 2, 'const needle = 1;\n'),
      matchEvent('a.ts', 5, '  also needle here\n'),
      JSON.stringify({ type: 'end', data: {} }),
      JSON.stringify({ type: 'summary', data: {} }),
    ].join('\n');
    expect(parseRipgrepMatches(stdout, id, 50)).toEqual([
      { path: 'a.ts', line: 2, preview: 'const needle = 1;' },
      { path: 'a.ts', line: 5, preview: 'also needle here' },
    ]);
  });

  it('stops at the limit', () => {
    const stdout = [
      matchEvent('a.ts', 1, 'needle\n'),
      matchEvent('a.ts', 2, 'needle\n'),
      matchEvent('a.ts', 3, 'needle\n'),
    ].join('\n');
    expect(parseRipgrepMatches(stdout, id, 2)).toHaveLength(2);
  });

  it('maps the reported path through toRelPath', () => {
    const stdout = matchEvent('src/a.ts', 1, 'needle\n');
    const matches = parseRipgrepMatches(stdout, (p) => `pkg/${p}`, 50);
    expect(matches[0].path).toBe('pkg/src/a.ts');
  });

  it('trims a long preview and strips a trailing CR', () => {
    const max = settings.search.contentPreviewMaxChars;
    const long = 'needle' + 'x'.repeat(max + 50);
    const stdout = [
      matchEvent('a.ts', 1, '  needle here  \r\n'),
      matchEvent('b.ts', 1, long + '\n'),
    ].join('\n');
    const matches = parseRipgrepMatches(stdout, id, 50);
    expect(matches[0].preview).toBe('needle here');
    expect(matches[1].preview.endsWith('…')).toBe(true);
    expect(matches[1].preview.length).toBe(max + 1);
  });

  it('skips malformed lines and matches missing fields', () => {
    const stdout = [
      'not json at all',
      JSON.stringify({ type: 'match', data: { path: { bytes: 'AAAA' }, line_number: 1 } }),
      matchEvent('a.ts', 3, 'good needle\n'),
    ].join('\n');
    expect(parseRipgrepMatches(stdout, id, 50)).toEqual([
      { path: 'a.ts', line: 3, preview: 'good needle' },
    ]);
  });
});

describe('searchContentRipgrep', () => {
  it('falls back (returns undefined) when the binary is not found', async () => {
    const result = await searchContentRipgrep('needle', {
      locate: () => undefined,
      run: async () => '',
    });
    expect(result).toBeUndefined();
  });

  it('runs ripgrep in the workspace folder and parses the matches', async () => {
    const run = vi.fn(async () => matchEvent('src/a.ts', 2, 'const needle = 1;\n'));
    const result = await searchContentRipgrep('needle', {
      locate: () => '/path/to/rg',
      run,
    });
    expect(result).toEqual({
      matches: [{ path: 'src/a.ts', line: 2, preview: 'const needle = 1;' }],
      truncated: false,
    });
    expect(run).toHaveBeenCalledWith('/path/to/rg', expect.any(Array), '/ws');
  });

  it('returns undefined when a spawn fails so the scan can take over', async () => {
    const result = await searchContentRipgrep('needle', {
      locate: () => '/path/to/rg',
      run: async () => {
        throw new Error('spawn ENOENT');
      },
    });
    expect(result).toBeUndefined();
  });

  it('falls back on a virtual workspace folder ripgrep cannot reach', async () => {
    __setWorkspaceFolders([{ name: 'remote', path: '/remote', scheme: 'vscode-vfs' }]);
    const run = vi.fn();
    const result = await searchContentRipgrep('needle', {
      locate: () => '/path/to/rg',
      run,
    });
    expect(result).toBeUndefined();
    expect(run).not.toHaveBeenCalled();
  });

  it('scans every folder and prefixes paths in a multi-root workspace', async () => {
    __setWorkspaceFolders([
      { name: 'frontend', path: '/fe' },
      { name: 'backend', path: '/be' },
    ]);
    const run = vi.fn(async (_rg, _args, cwd: string) =>
      cwd === '/fe'
        ? matchEvent('app.ts', 1, 'needle fe\n')
        : matchEvent('server.ts', 3, 'needle be\n')
    );
    const result = await searchContentRipgrep('needle', { locate: () => 'rg', run });
    expect(run).toHaveBeenCalledTimes(2);
    expect(result?.matches).toEqual([
      { path: 'frontend/app.ts', line: 1, preview: 'needle fe' },
      { path: 'backend/server.ts', line: 3, preview: 'needle be' },
    ]);
  });

  it('caps the total matches across folders', async () => {
    const body = Array.from({ length: settings.search.contentMaxMatches + 5 }, (_, i) =>
      matchEvent('a.ts', i + 1, 'needle\n')
    ).join('\n');
    const result = await searchContentRipgrep('needle', {
      locate: () => 'rg',
      run: async () => body,
    });
    expect(result?.matches).toHaveLength(settings.search.contentMaxMatches);
  });
});

describe('searchContent (engine selection)', () => {
  it('uses the JavaScript scan when ripgrep is unavailable in this environment', async () => {
    // env.appRoot is undefined in the mock, so locateRipgrep finds no binary and
    // searchContent falls back to scanning the seeded files.
    const a = __setFile('a.ts', 'first\nconst needle = 1;\nlast');
    __state.findFilesResult = [a];
    const result = await searchContent('needle');
    expect(result).toEqual({
      matches: [{ path: 'a.ts', line: 2, preview: 'const needle = 1;' }],
      truncated: false,
    });
  });
});

describe('previewLine', () => {
  it('trims, strips a trailing CR, and caps length', () => {
    expect(previewLine('  hello  ')).toBe('hello');
    expect(previewLine('hello\r')).toBe('hello');
    const max = settings.search.contentPreviewMaxChars;
    expect(previewLine('x'.repeat(max + 10))).toBe('x'.repeat(max) + '…');
  });
});
