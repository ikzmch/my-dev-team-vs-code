import * as vscode from 'vscode';
import * as path from 'path';
import { exec, ChildProcess, ExecOptions } from 'child_process';
import { promisify } from 'util';
import { Approver, RunMirror } from './types';
import { settings } from '../config/settings';
import { messages } from '../config/messages';
import { environment } from '../config/environment';

const execAsync = promisify(exec);

/** Every open workspace folder, or throw when none is open. */
function workspaceFolders(): readonly vscode.WorkspaceFolder[] {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    throw new Error('No workspace folder is open.');
  }
  return folders;
}

/** The first workspace folder: the default root and the `run` tool's cwd. */
function workspaceRoot(): vscode.Uri {
  return workspaceFolders()[0].uri;
}

/**
 * True when every open folder lives on a virtual (non-`file`) filesystem - a
 * GitHub repo opened in the browser, say. The `run` tool spawns a child
 * process against a real cwd and so cannot work there; the fs-based tools
 * (read/search/write/edit) still do.
 */
function isVirtualWorkspace(): boolean {
  const folders = vscode.workspace.workspaceFolders;
  return (
    !!folders && folders.length > 0 && folders.every((f) => f.uri.scheme !== 'file')
  );
}

/**
 * Split a tool-supplied path into the workspace folder it targets and the path
 * relative to that folder. In a multi-root workspace `asRelativePath` prefixes
 * every path it returns with the folder's name (e.g. `backend/src/app.ts`), so
 * a path whose first segment names an open folder is resolved against that
 * folder; a bare path - and every single-folder workspace - resolves against
 * the first folder, exactly as before. This keeps the tools consistent: a path
 * the search tool lists (it scans all roots) is one read/write/edit can open.
 */
function resolveFolder(relPath: string): { root: vscode.Uri; rel: string } {
  const folders = workspaceFolders();
  if (folders.length > 1) {
    const slash = relPath.search(/[\\/]/);
    const head = slash === -1 ? relPath : relPath.slice(0, slash);
    const match = folders.find((f) => f.name === head);
    if (match) {
      return { root: match.uri, rel: slash === -1 ? '' : relPath.slice(slash + 1) };
    }
  }
  return { root: folders[0].uri, rel: relPath };
}

/**
 * Resolve a workspace-relative path to a Uri, rejecting anything that points
 * outside the workspace (absolute paths, `..` traversal). Tool inputs come
 * from a model and the tools are callable by any chat model in the editor,
 * so the path is untrusted. The path is first mapped to its workspace folder
 * (see `resolveFolder`), then checked against that folder's root.
 *
 * The lexical check alone is not enough: a symlink that lives inside the
 * workspace can still point outside it, so every component of the resolved
 * path - ancestors included, since a symlinked *directory* escapes just as a
 * symlinked file does - is stat'ed and rejected when it is a symbolic link.
 * Otherwise `read` could follow a link to exfiltrate a file and `write` could
 * clobber one through it. A component that does not exist yet (a new `write`
 * target) has nothing to follow, so a stat that fails is not an error here.
 */
async function resolveWorkspaceUri(relPath: string): Promise<vscode.Uri> {
  const { root, rel: relativeToRoot } = resolveFolder(relPath);
  const rootPath = path.resolve(root.fsPath);
  const target = path.resolve(rootPath, relativeToRoot);
  const rel = path.relative(rootPath, target);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path is outside the workspace: ${relPath}`);
  }
  const segments = rel.split(/[\\/]/);
  let prefix = root;
  for (const segment of segments) {
    prefix = vscode.Uri.joinPath(prefix, segment);
    let stat: vscode.FileStat | undefined;
    try {
      stat = await vscode.workspace.fs.stat(prefix);
    } catch {
      continue;
    }
    if ((stat.type & vscode.FileType.SymbolicLink) !== 0) {
      throw new Error(`Path is a symbolic link, which is not allowed: ${relPath}`);
    }
  }
  return vscode.Uri.joinPath(root, ...segments);
}

/** Backstop on the read tool's output, so a few enormous lines cannot flood the context. */
function capReadChars(text: string): string {
  return text.length > settings.read.maxChars
    ? text.slice(0, settings.read.maxChars) + '\n…(truncated)'
    : text;
}

/**
 * Read a file's text contents, whole or a 1-based inclusive line range.
 * Read-only: no approval needed.
 *
 * Every call returns at most `settings.read.maxLines` lines, so one read of a
 * large file cannot flood a small model's context window. A result that does
 * not cover the whole file is prefixed with the range shown and the file's
 * total line count, so the model knows where to continue; an impossible range
 * returns a recovery instruction instead of throwing.
 */
export async function readFile(
  relPath: string,
  startLine?: number,
  endLine?: number
): Promise<string> {
  const uri = await resolveWorkspaceUri(relPath);
  const bytes = await vscode.workspace.fs.readFile(uri);
  const text = Buffer.from(bytes).toString('utf8');

  const start = startLine ?? 1;
  if (endLine !== undefined && endLine < start) {
    return messages.readFailed.emptyRange(start, endLine);
  }
  // Count lines like `wc -l` does: a trailing newline ends the last line, it
  // does not start another - so the count matches what a line-count command
  // run by the model reports.
  const lines = text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  const total = lines.length;
  if (start > total) {
    return messages.readFailed.pastEnd(relPath, start, total);
  }
  const end = Math.min(endLine ?? Infinity, start + settings.read.maxLines - 1, total);
  if (start === 1 && end === total) {
    // The whole file fits in one call: return it verbatim (trailing newline
    // included), with no range header to strip.
    return capReadChars(text);
  }
  return (
    messages.read.range(start, end, total) +
    '\n' +
    capReadChars(lines.slice(start - 1, end).join('\n'))
  );
}

/** One content-search hit: a 1-based line number and a trimmed preview of that line. */
export interface ContentMatch {
  path: string;
  line: number;
  preview: string;
}

/**
 * Trim a matched line for the preview and cap its length, so one very long
 * line (a minified bundle, a data blob) cannot flood the result. The trailing
 * CR of a CRLF line is stripped first, since the file is split on `\n`.
 */
function previewLine(line: string): string {
  const trimmed = line.replace(/\r$/, '').trim();
  const max = settings.search.contentPreviewMaxChars;
  return trimmed.length > max ? trimmed.slice(0, max) + '…' : trimmed;
}

/**
 * Scan candidate files for `query` and return one match per line that contains
 * it (1-based line number + a trimmed line preview). Keeps the same scan,
 * size, and binary guards as before: an oversized file is rejected by its stat
 * size and never read into memory, and a NUL byte marks binary content that is
 * skipped. A per-file match cap (`contentMaxMatchesPerFile`) stops one busy
 * file (a log) from eating the whole budget, and the overall
 * `contentMaxMatches` cap stops the scan early. Used both by the `search` tool
 * (content mode) and by the client's `#codebase` resolver.
 */
export async function searchContent(query: string): Promise<ContentMatch[]> {
  const uris = await vscode.workspace.findFiles(
    '**/*',
    settings.search.excludeGlob,
    settings.search.contentScanLimit
  );
  const matches: ContentMatch[] = [];
  for (const uri of uris) {
    if (matches.length >= settings.search.contentMaxMatches) {
      break;
    }
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
  return matches;
}

/**
 * Search by glob (file names) or by content. Read-only: no approval needed.
 * Glob mode returns workspace-relative paths; content mode returns one
 * `path:line: <trimmed preview>` line per match, so the model learns where a
 * file matches and can follow up with a ranged `read` around that line instead
 * of reading the file from the start.
 */
export async function searchFiles(
  query: string,
  mode: 'glob' | 'content'
): Promise<string[]> {
  if (mode === 'glob') {
    const uris = await vscode.workspace.findFiles(
      query,
      settings.search.excludeGlob,
      settings.search.globMaxResults
    );
    return uris.map((u) => vscode.workspace.asRelativePath(u));
  }

  const matches = await searchContent(query);
  return matches.map((m) => `${m.path}:${m.line}: ${m.preview}`);
}

/**
 * Kill a spawned command and everything it started. exec's own `timeout`
 * only signals the shell, leaving grandchild processes running, so the tree
 * is taken down explicitly: `taskkill /t` on Windows, and elsewhere a signal
 * to the negative pid - the whole process group, which the child leads
 * because `runCommand` spawns it `detached` off Windows. Signalling only the
 * child (the shell) would orphan whatever it started.
 */
function killProcessTree(child: ChildProcess | undefined): void {
  if (!child || child.pid === undefined) {
    return;
  }
  if (process.platform === 'win32') {
    exec(`taskkill /pid ${child.pid} /t /f`);
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // The group is already gone (or the child never detached under a test
      // fake); fall back to signalling the child itself.
      child.kill('SIGKILL');
    }
  }
}

/**
 * Backstop on the run tool's model-facing result. The exec buffer
 * (settings.runCommandMaxBufferBytes) bounds what is captured; this bounds
 * what is handed back to the model, so one chatty command cannot flood a
 * small model's context window. Head and tail are both kept - build and test
 * failures usually print the interesting part last.
 */
function capRunOutput(text: string): string {
  const max = settings.runResultMaxChars;
  if (text.length <= max) {
    return text;
  }
  const half = Math.floor(max / 2);
  return (
    text.slice(0, half) + '\n…(output truncated)…\n' + text.slice(text.length - half)
  );
}

/**
 * Run a shell command. SIDE-EFFECTING: gated by the Approver. The optional
 * mirror receives the command's lifecycle and live output (Phase 1 shows it
 * in a "Dev Team" terminal); the buffered result returned to the model is
 * unaffected by it.
 */
export async function runCommand(
  command: string,
  approver: Approver,
  mirror?: RunMirror,
  signal?: AbortSignal
): Promise<string> {
  // An untrusted folder (Restricted Mode) or a virtual workspace cannot run a
  // shell command; refuse before the approval prompt so the user is never
  // asked to confirm an action that cannot happen, and the model gets a reason
  // it can relay.
  if (!vscode.workspace.isTrusted) {
    return messages.restricted.run;
  }
  if (isVirtualWorkspace()) {
    return messages.virtual.run;
  }
  const folders = vscode.workspace.workspaceFolders;
  const cwd = workspaceRoot().fsPath;
  // A request cancelled before (or during) the approval prompt must not start
  // a process.
  if (signal?.aborted) {
    return messages.cancelled.run;
  }
  // In a multi-root workspace the command runs in the first folder; name it in
  // the prompt so the user knows which directory the command lands in.
  const cwdFolder = folders && folders.length > 1 ? folders[0].name : undefined;
  const ok = await approver.confirm(
    messages.approval.runCommandTitle,
    messages.approval.runCommandDetail(command, cwdFolder)
  );
  if (!ok) {
    // Declined commands never ran, so they never reach the mirror either.
    return messages.notApproved.run;
  }
  if (signal?.aborted) {
    return messages.cancelled.run;
  }

  let timedOut = false;
  let aborted = false;
  // The shell must match what the prompts announce (config/environment.ts):
  // PowerShell on Windows, the platform default (/bin/sh) elsewhere.
  // Off Windows the child leads its own process group, so killProcessTree can
  // take the whole group down (taskkill /t covers this on Windows). exec
  // forwards its options to spawn, which honours `detached` - the ExecOptions
  // type just does not declare it, hence the cast.
  const pending = execAsync(command, {
    cwd,
    shell: environment.execShell,
    maxBuffer: settings.runCommandMaxBufferBytes,
    windowsHide: true,
    detached: process.platform !== 'win32',
  } as ExecOptions & { detached: boolean });
  if (mirror) {
    mirror.begin(command);
    // Tap the child's streams for the live view; exec keeps buffering the
    // same data for the returned result, so this observes without changing
    // anything. (The promisified child is absent only under test fakes.)
    pending.child?.stdout?.on('data', (chunk) => mirror.output(String(chunk)));
    pending.child?.stderr?.on('data', (chunk) => mirror.output(String(chunk)));
  }
  const killTimer = setTimeout(() => {
    timedOut = true;
    killProcessTree(pending.child);
  }, settings.runCommandTimeoutMs);
  // Cancelling the chat request kills the in-flight process tree instead of
  // letting it run to its timeout in the background.
  const onAbort = () => {
    aborted = true;
    killProcessTree(pending.child);
  };
  signal?.addEventListener('abort', onAbort);

  try {
    const { stdout, stderr } = await pending;
    mirror?.end(messages.terminal.completed);
    return capRunOutput(combineOutput(String(stdout), String(stderr)));
  } catch (err: any) {
    // A failed command's output is what the caller needs to diagnose it, so
    // include the stdout/stderr exec attaches to the error.
    const reason = aborted
      ? 'Command was cancelled and the process was killed.'
      : timedOut
      ? `Command timed out after ${settings.runCommandTimeoutMs} ms and was killed.`
      : `Command failed: ${err?.message ?? String(err)}`;
    mirror?.end(reason);
    const output = capRunOutput(
      combineOutput(String(err?.stdout ?? ''), String(err?.stderr ?? ''))
    );
    return output ? `${reason}\n${output}` : reason;
  } finally {
    clearTimeout(killTimer);
    signal?.removeEventListener('abort', onAbort);
  }
}

function combineOutput(stdout: string, stderr: string): string {
  return (stdout || '') + (stderr ? `\n[stderr]\n${stderr}` : '');
}

/**
 * Create or overwrite a file. Not gated by the Approver: the workspace is
 * git-backed, so a clobbered file is recoverable, and writing is the
 * executor's core job - prompting on every file would make a routine
 * multi-file change unusable. The safety that matters here is still enforced:
 * path traversal and symlink targets are rejected outright, and a cancelled
 * request never lands a file. See the "Approvals" section in DESIGN.md for why
 * write/edit are intentionally ungated while `run` still asks.
 */
export async function writeFile(
  relPath: string,
  contents: string,
  signal?: AbortSignal
): Promise<string> {
  // An untrusted folder (Restricted Mode) disables writing; refuse with a
  // reason the model can relay rather than touching disk.
  if (!vscode.workspace.isTrusted) {
    return messages.restricted.write;
  }
  // Resolve (and so validate) the path first: a traversal or symlink target
  // is rejected outright before anything touches disk.
  const uri = await resolveWorkspaceUri(relPath);
  // A cancelled request (the chat stop button) must not land a file on disk.
  if (signal?.aborted) {
    return messages.cancelled.write;
  }
  await vscode.workspace.fs.writeFile(uri, Buffer.from(contents, 'utf8'));
  return `Wrote ${relPath} (${Buffer.byteLength(contents, 'utf8')} bytes).`;
}

/**
 * Adapt a model-emitted snippet's line endings to the file's. Models usually
 * emit LF while files on Windows are often CRLF, so an exact match that fails
 * only on line endings would be a spurious "not found"; the snippet is
 * converted instead of the file, so an edit never rewrites the file's own
 * line endings as a side effect.
 */
function matchLineEndings(fileText: string, snippet: string): string {
  const lf = snippet.replaceAll('\r\n', '\n');
  return fileText.includes('\r\n') ? lf.replaceAll('\n', '\r\n') : lf;
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/**
 * Locate the snippet to replace in the file text: an exact match first; on a
 * miss, a retry with the snippets' line endings adapted to the file's (the
 * replacement must be adapted alongside, or an LF snippet pasted into a CRLF
 * file would mix endings). Returns the adapted needle/replacement pair on a
 * unique match, or the recovery message the model should see.
 */
function locateEdit(
  text: string,
  relPath: string,
  oldText: string,
  newText: string
): { needle: string; replacement: string } | { failure: string } {
  let needle = oldText;
  let replacement = newText;
  if (!text.includes(needle)) {
    needle = matchLineEndings(text, oldText);
    replacement = matchLineEndings(text, newText);
  }
  const count = countOccurrences(text, needle);
  if (count === 0) {
    return { failure: messages.editFailed.notFound(relPath) };
  }
  if (count > 1) {
    return { failure: messages.editFailed.multipleMatches(count, relPath) };
  }
  return { needle, replacement };
}

/**
 * Replace text in an existing file. Not gated by the Approver (see
 * `writeFile`): the workspace is git-backed, so the change is recoverable. The
 * replaced text must match exactly one place in the file - zero or multiple
 * matches return a recovery instruction to the model instead of touching the
 * file, so a misremembered snippet can never corrupt it. Creating files stays
 * the write tool's job: a missing target is an error here, not an empty file
 * to fill. The replacement is read, located, and written back-to-back with no
 * pause in between, so no re-verification step is needed.
 */
export async function editFile(
  relPath: string,
  oldText: string,
  newText: string,
  signal?: AbortSignal
): Promise<string> {
  // An untrusted folder (Restricted Mode) disables editing; refuse with a
  // reason the model can relay rather than touching disk.
  if (!vscode.workspace.isTrusted) {
    return messages.restricted.edit;
  }
  // Resolve (and so validate) the path first: a traversal or symlink target
  // is rejected outright before anything touches disk.
  const uri = await resolveWorkspaceUri(relPath);
  if (oldText === newText) {
    return messages.editFailed.identical;
  }
  // A cancelled request (the chat stop button) must not land an edit on disk.
  if (signal?.aborted) {
    return messages.cancelled.edit;
  }
  let bytes: Uint8Array;
  try {
    bytes = await vscode.workspace.fs.readFile(uri);
  } catch {
    return messages.editFailed.missingFile(relPath);
  }
  const text = Buffer.from(bytes).toString('utf8');
  const located = locateEdit(text, relPath, oldText, newText);
  if ('failure' in located) {
    return located.failure;
  }
  // The replacement goes through a function so replace() cannot interpret
  // `$&`-style patterns inside model-written code as substitutions.
  const updated = text.replace(located.needle, () => located.replacement);
  await vscode.workspace.fs.writeFile(uri, Buffer.from(updated, 'utf8'));
  return `Edited ${relPath} (1 replacement).`;
}
