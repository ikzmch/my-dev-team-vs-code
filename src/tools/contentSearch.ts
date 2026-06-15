/**
 * Content search: find the workspace lines that contain a query string.
 *
 * Two engines sit behind one entry point (`searchContent`):
 *
 * - **ripgrep** (the fast path): VS Code ships the `rg` binary, so when it can
 *   be located the search scans the whole workspace natively - bounded by match
 *   count, which is what the caller wants, with no per-file read into the
 *   extension host. This is the primary path.
 * - **the JavaScript scan** (the fallback): when the binary cannot be found (a
 *   stripped build, a virtual workspace, a spawn failure) the search falls back
 *   to reading each candidate file through `vscode.workspace.fs` and
 *   substring-scanning it on the extension host - slower, but it works anywhere
 *   the fs API does, including virtual filesystems.
 *
 * Both engines return the same `{ path, line, preview }` shape so callers (the
 * `search` tool's content mode and the client's `#codebase` resolver) never
 * learn which one ran.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { settings } from '../config/settings';

/** One content-search hit: a 1-based line number and a trimmed preview of that line. */
export interface ContentMatch {
  path: string;
  line: number;
  preview: string;
}

/**
 * The result of a content search: the matches found, and whether the search
 * stopped short with candidate files still unexamined (only the JavaScript scan
 * sets this - ripgrep scans the whole workspace). `truncated` lets a caller
 * tell the model the result may be incomplete instead of presenting a partial
 * scan as authoritative.
 */
export interface ContentSearchResult {
  matches: ContentMatch[];
  truncated: boolean;
}

/**
 * Trim a matched line for the preview and cap its length, so one very long
 * line (a minified bundle, a data blob) cannot flood the result. The trailing
 * CR of a CRLF line is stripped first, since the line may be split on `\n`.
 */
export function previewLine(line: string): string {
  const trimmed = line.replace(/\r$/, '').trim();
  const max = settings.search.contentPreviewMaxChars;
  return trimmed.length > max ? trimmed.slice(0, max) + '…' : trimmed;
}

// --- ripgrep engine ---------------------------------------------------------

/** The bundled ripgrep binary's name, platform-specific. */
const RG_EXE = process.platform === 'win32' ? 'rg.exe' : 'rg';

/** Memoised binary lookup: `undefined` = not yet checked, `null` = not found. */
let cachedRgPath: string | null | undefined;

/**
 * Locate the `rg` binary VS Code bundles, checking the known paths under the
 * application root (asar-packed and unpacked, both the current `@vscode/ripgrep`
 * and the legacy `vscode-ripgrep` layout). Returns the first that exists, or
 * `undefined` when none does - which is the signal to fall back to the scan.
 * The result is memoised, since the binary does not move within a session.
 */
export function locateRipgrep(): string | undefined {
  if (cachedRgPath !== undefined) {
    return cachedRgPath ?? undefined;
  }
  cachedRgPath = findRipgrepBinary() ?? null;
  return cachedRgPath ?? undefined;
}

function findRipgrepBinary(): string | undefined {
  let appRoot: string | undefined;
  try {
    appRoot = vscode.env?.appRoot;
  } catch {
    appRoot = undefined;
  }
  if (!appRoot) {
    return undefined;
  }
  const current = ['@vscode', 'ripgrep', 'bin', RG_EXE];
  const legacy = ['vscode-ripgrep', 'bin', RG_EXE];
  const candidates = [
    path.join(appRoot, 'node_modules.asar.unpacked', ...current),
    path.join(appRoot, 'node_modules', ...current),
    path.join(appRoot, 'node_modules.asar.unpacked', ...legacy),
    path.join(appRoot, 'node_modules', ...legacy),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // An unreadable candidate path is simply not the binary; try the next.
    }
  }
  return undefined;
}

/** Soft cap on a single ripgrep invocation's buffered stdout, in bytes. */
const RG_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

/**
 * Turn the `search.excludeGlob` brace expression into ripgrep `--glob=!<g>`
 * exclude arguments, so ripgrep skips the same noise folders the scan does (on
 * top of ripgrep's own `.gitignore` handling).
 */
function ripgrepExcludeGlobs(): string[] {
  return settings.search.excludeGlob
    .replace(/^\{|\}$/g, '')
    .split(',')
    .map((glob) => glob.trim())
    .filter((glob) => glob.length > 0)
    .map((glob) => `--glob=!${glob}`);
}

/**
 * The ripgrep arguments for a content search: NDJSON output (robust to paths
 * containing colons), a fixed-string (not regex) case-sensitive match to mirror
 * the scan's `includes`, the per-file and file-size caps, and the exclude
 * globs. The query is placed after `--` so a query starting with `-` is not
 * read as a flag; `.` searches the working directory.
 */
export function buildRipgrepArgs(query: string): string[] {
  return [
    '--json',
    '--fixed-strings',
    '--no-messages',
    `--max-count=${settings.search.contentMaxMatchesPerFile}`,
    `--max-filesize=${settings.search.maxFileSizeBytes}`,
    ...ripgrepExcludeGlobs(),
    '--',
    query,
    '.',
  ];
}

/** Run the rg binary in `cwd` and resolve its NDJSON stdout. Injectable for tests. */
export type RunRipgrep = (rgPath: string, args: string[], cwd: string) => Promise<string>;

function runRipgrep(rgPath: string, args: string[], cwd: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(rgPath, args, { cwd, windowsHide: true });
    let stdout = '';
    let killed = false;
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
      // Guard against pathological output: the per-file and result caps keep
      // the useful set small, but a degenerate query could still stream a lot.
      if (stdout.length > RG_MAX_BUFFER_BYTES && !killed) {
        killed = true;
        child.kill();
      }
    });
    child.on('error', reject);
    child.on('close', (code) => {
      // ripgrep exits 0 with matches, 1 with none, 2 on error. A buffer-cap
      // kill leaves whatever we collected, which is enough (it is already over
      // the result cap).
      if (killed || code === 0 || code === 1) {
        resolve(stdout);
      } else {
        reject(new Error(`ripgrep exited with code ${code}`));
      }
    });
  });
}

/**
 * Parse ripgrep's `--json` stdout into content matches, mapping each reported
 * (cwd-relative) path through `toRelPath` and stopping at `limit` matches.
 * Non-match events (begin/end/summary), malformed lines, and matches whose
 * path/line/text are missing (e.g. a non-UTF-8 path reported as bytes) are
 * skipped rather than failing the search.
 */
export function parseRipgrepMatches(
  stdout: string,
  toRelPath: (rgRelPath: string) => string,
  limit: number
): ContentMatch[] {
  const matches: ContentMatch[] = [];
  for (const raw of stdout.split('\n')) {
    if (matches.length >= limit) {
      break;
    }
    const line = raw.trim();
    if (!line) {
      continue;
    }
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.type !== 'match') {
      continue;
    }
    const rgPath = event.data?.path?.text;
    const lineText = event.data?.lines?.text;
    const lineNumber = event.data?.line_number;
    if (
      typeof rgPath !== 'string' ||
      typeof lineText !== 'string' ||
      typeof lineNumber !== 'number'
    ) {
      continue;
    }
    matches.push({ path: toRelPath(rgPath), line: lineNumber, preview: previewLine(lineText) });
  }
  return matches;
}

/**
 * Search file contents with the bundled ripgrep binary, scanning every
 * workspace folder. Returns `undefined` - the signal to fall back to the
 * JavaScript scan - when the binary is unavailable, when there is no workspace,
 * when a folder lives on a virtual filesystem ripgrep cannot reach, or when a
 * spawn fails. The `deps` are injectable so tests can drive the path without a
 * real binary.
 */
export async function searchContentRipgrep(
  query: string,
  deps: { locate?: () => string | undefined; run?: RunRipgrep } = {}
): Promise<ContentSearchResult | undefined> {
  const locate = deps.locate ?? locateRipgrep;
  const run = deps.run ?? runRipgrep;
  const rgPath = locate();
  if (!rgPath) {
    return undefined;
  }
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return undefined;
  }
  // ripgrep needs real paths; a virtual (non-`file`) folder must use the scan,
  // which goes through vscode.workspace.fs.
  if (folders.some((folder) => folder.uri.scheme !== 'file')) {
    return undefined;
  }

  const args = buildRipgrepArgs(query);
  const total = settings.search.contentMaxMatches;
  const matches: ContentMatch[] = [];
  for (const folder of folders) {
    if (matches.length >= total) {
      break;
    }
    let stdout: string;
    try {
      stdout = await run(rgPath, args, folder.uri.fsPath);
    } catch {
      // A spawn or process failure abandons the fast path entirely; the scan
      // then produces a complete result rather than a partial one.
      return undefined;
    }
    // Map each cwd-relative path ripgrep reports to the same workspace-relative
    // label the read tool resolves, so a path the search lists is one read can
    // open (the multi-root folder prefix included).
    const toRelPath = (rgRel: string): string =>
      vscode.workspace.asRelativePath(
        vscode.Uri.joinPath(folder.uri, ...rgRel.split(/[\\/]/).filter(Boolean))
      );
    matches.push(...parseRipgrepMatches(stdout, toRelPath, total - matches.length));
  }
  return { matches, truncated: false };
}

// --- JavaScript scan (fallback) --------------------------------------------

/**
 * Scan candidate files for `query` on the extension host and return one match
 * per line that contains it, plus whether the scan was truncated. The fallback
 * for when ripgrep is unavailable. Keeps the size and binary guards: an
 * oversized file is rejected by its stat size and never read into memory, and a
 * NUL byte marks binary content that is skipped. A per-file match cap
 * (`contentMaxMatchesPerFile`) stops one busy file (a log) from eating the
 * whole budget, and the overall `contentMaxMatches` cap stops the scan early.
 *
 * The candidate set is bounded only by a generous `scanCandidateLimit` ceiling,
 * not by the (small) files-examined budget: capping at the budget would drop an
 * arbitrary subset of files before they were ever looked at, so matches in the
 * dropped files would vanish silently. The ceiling exists purely so the Uri
 * array `findFiles` materialises cannot grow without bound on a very large repo
 * (one Uri per workspace file); it sits far above the budget so it never drops a
 * file the budget would have reached. The actual work is bounded by the match
 * cap and the files-examined budget (`contentScanLimit`); when either that
 * budget or the candidate ceiling is hit with files still unexamined, the result
 * is flagged `truncated` so the caller can say so rather than present a partial
 * scan as complete.
 */
export async function searchContentScan(query: string): Promise<ContentSearchResult> {
  const candidateLimit = settings.search.scanCandidateLimit;
  const uris = await vscode.workspace.findFiles(
    '**/*',
    settings.search.excludeGlob,
    candidateLimit
  );
  const matches: ContentMatch[] = [];
  let scanned = 0;
  // The candidate list itself was capped, so files beyond the ceiling were never
  // even listed: the result is necessarily partial.
  let truncated = uris.length >= candidateLimit;
  for (const uri of uris) {
    if (matches.length >= settings.search.contentMaxMatches) {
      break;
    }
    if (scanned >= settings.search.contentScanLimit) {
      // The files-examined budget is spent and candidate files remain, so the
      // result may be incomplete - report it instead of silently dropping them.
      truncated = true;
      break;
    }
    // Count every file we examine (stat included), so the budget bounds the
    // work whether or not a file turns out to be oversized or binary.
    scanned++;
    try {
      // Check the size via stat before reading, so an oversized file is never
      // pulled into memory just to be discarded - the cap bounds memory, not
      // only the result set.
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > settings.search.maxFileSizeBytes) {
        continue;
      }
      const bytes = await vscode.workspace.fs.readFile(uri);
      // Skip binaries (a NUL byte marks binary content; decoding never throws,
      // so this cannot be left to the catch below).
      if (bytes.includes(0)) {
        continue;
      }
      const text = Buffer.from(bytes).toString('utf8');
      // A cheap whole-file reject before the per-line scan.
      if (!text.includes(query)) {
        continue;
      }
      const relPath = vscode.workspace.asRelativePath(uri);
      const lines = text.split('\n');
      let perFile = 0;
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].includes(query)) {
          continue;
        }
        matches.push({ path: relPath, line: i + 1, preview: previewLine(lines[i]) });
        perFile++;
        if (perFile >= settings.search.contentMaxMatchesPerFile) {
          break;
        }
        if (matches.length >= settings.search.contentMaxMatches) {
          break;
        }
      }
    } catch {
      // Skip unreadable files.
    }
  }
  return { matches, truncated };
}

/**
 * Search file contents: ripgrep when its binary is available (the fast path),
 * the JavaScript scan otherwise. Used by the `search` tool's content mode and
 * the client's `#codebase` resolver.
 */
export async function searchContent(query: string): Promise<ContentSearchResult> {
  const viaRipgrep = await searchContentRipgrep(query);
  return viaRipgrep ?? searchContentScan(query);
}
