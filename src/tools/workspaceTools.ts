import * as vscode from 'vscode';
import * as path from 'path';
import { exec, ChildProcess } from 'child_process';
import { promisify } from 'util';
import { Approver, RunMirror } from './types';
import { settings } from '../config/settings';
import { messages } from '../config/messages';
import { environment } from '../config/environment';

const execAsync = promisify(exec);

function workspaceRoot(): vscode.Uri {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    throw new Error('No workspace folder is open.');
  }
  return folder.uri;
}

/**
 * Resolve a workspace-relative path to a Uri, rejecting anything that points
 * outside the workspace (absolute paths, `..` traversal). Tool inputs come
 * from a model and the tools are callable by any chat model in the editor,
 * so the path is untrusted.
 *
 * The lexical check alone is not enough: a symlink that lives inside the
 * workspace can still point outside it, so a resolved path that exists and is
 * a symbolic link is rejected too - otherwise `read` could follow it to
 * exfiltrate a file and `write` could clobber one through it. A path that does
 * not exist yet (a new `write` target) has nothing to follow, so a stat that
 * fails is not an error here.
 */
async function resolveWorkspaceUri(relPath: string): Promise<vscode.Uri> {
  const root = workspaceRoot();
  const rootPath = path.resolve(root.fsPath);
  const target = path.resolve(rootPath, relPath);
  const rel = path.relative(rootPath, target);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path is outside the workspace: ${relPath}`);
  }
  const uri = vscode.Uri.joinPath(root, ...rel.split(/[\\/]/));
  let stat: vscode.FileStat | undefined;
  try {
    stat = await vscode.workspace.fs.stat(uri);
  } catch {
    stat = undefined;
  }
  if (stat && (stat.type & vscode.FileType.SymbolicLink) !== 0) {
    throw new Error(`Path is a symbolic link, which is not allowed: ${relPath}`);
  }
  return uri;
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

/** Search by glob (file names) or by content. Read-only: no approval needed. */
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

  // Content search: scan candidate files for the query string.
  const uris = await vscode.workspace.findFiles(
    '**/*',
    settings.search.excludeGlob,
    settings.search.contentScanLimit
  );
  const matches: string[] = [];
  for (const uri of uris) {
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
      if (Buffer.from(bytes).toString('utf8').includes(query)) {
        matches.push(vscode.workspace.asRelativePath(uri));
      }
    } catch {
      // Skip unreadable files.
    }
    if (matches.length >= settings.search.contentMaxMatches) break;
  }
  return matches;
}

/**
 * Kill a spawned command and everything it started. exec's own `timeout`
 * only signals the shell, which on Windows leaves grandchild processes
 * running, so the tree is taken down explicitly.
 */
function killProcessTree(child: ChildProcess | undefined): void {
  if (!child || child.pid === undefined) {
    return;
  }
  if (process.platform === 'win32') {
    exec(`taskkill /pid ${child.pid} /t /f`);
  } else {
    child.kill('SIGKILL');
  }
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
  const cwd = workspaceRoot().fsPath;
  // A request cancelled before (or during) the approval prompt must not start
  // a process.
  if (signal?.aborted) {
    return messages.cancelled.run;
  }
  const ok = await approver.confirm(messages.approval.runCommandTitle, '$ ' + command);
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
  const pending = execAsync(command, {
    cwd,
    shell: environment.execShell,
    maxBuffer: settings.runCommandMaxBufferBytes,
    windowsHide: true,
  });
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
    return combineOutput(String(stdout), String(stderr));
  } catch (err: any) {
    // A failed command's output is what the caller needs to diagnose it, so
    // include the stdout/stderr exec attaches to the error.
    const reason = aborted
      ? 'Command was cancelled and the process was killed.'
      : timedOut
      ? `Command timed out after ${settings.runCommandTimeoutMs} ms and was killed.`
      : `Command failed: ${err?.message ?? String(err)}`;
    mirror?.end(reason);
    const output = combineOutput(String(err?.stdout ?? ''), String(err?.stderr ?? ''));
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
 * Create or overwrite a file. SIDE-EFFECTING: gated by the Approver. An
 * in-workspace overwrite is destructive (source, configs, dotfiles) and has
 * no undo, so the user approves the target path and a capped preview of the
 * new contents before anything lands on disk.
 */
export async function writeFile(
  relPath: string,
  contents: string,
  approver: Approver,
  signal?: AbortSignal
): Promise<string> {
  // Resolve (and so validate) the path first: a traversal or symlink target
  // is rejected outright and never reaches the approval prompt.
  const uri = await resolveWorkspaceUri(relPath);
  // A request cancelled before (or during) the approval prompt must not land
  // a file on disk.
  if (signal?.aborted) {
    return messages.cancelled.write;
  }
  const preview =
    contents.length > settings.writeApprovalPreviewMaxChars
      ? contents.slice(0, settings.writeApprovalPreviewMaxChars) + '\n…(truncated)'
      : contents;
  const ok = await approver.confirm(
    messages.approval.writeFileTitle,
    messages.approval.writeFileDetail(relPath, preview)
  );
  if (!ok) {
    return messages.notApproved.write;
  }
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

/** Cap one side of the edit approval preview. */
function editPreview(text: string): string {
  return text.length > settings.writeApprovalPreviewMaxChars
    ? text.slice(0, settings.writeApprovalPreviewMaxChars) + '\n…(truncated)'
    : text;
}

/**
 * Replace text in an existing file. SIDE-EFFECTING: gated by the Approver
 * with a diff-style old/new preview. The replaced text must match exactly one
 * place in the file - zero or multiple matches return a recovery instruction
 * to the model instead of touching the file, so a misremembered snippet can
 * never corrupt it. Creating files stays the write tool's job: a missing
 * target is an error here, not an empty file to fill.
 */
export async function editFile(
  relPath: string,
  oldText: string,
  newText: string,
  approver: Approver,
  signal?: AbortSignal
): Promise<string> {
  // Resolve (and so validate) the path first: a traversal or symlink target
  // is rejected outright and never reaches the approval prompt.
  const uri = await resolveWorkspaceUri(relPath);
  if (oldText === newText) {
    return messages.editFailed.identical;
  }
  let bytes: Uint8Array;
  try {
    bytes = await vscode.workspace.fs.readFile(uri);
  } catch {
    return messages.editFailed.missingFile(relPath);
  }
  const text = Buffer.from(bytes).toString('utf8');

  // Exact match first; on a miss, retry with the snippets' line endings
  // adapted to the file's (the replacement must be adapted alongside, or an
  // LF snippet pasted into a CRLF file would mix endings).
  let needle = oldText;
  let replacement = newText;
  if (!text.includes(needle)) {
    needle = matchLineEndings(text, oldText);
    replacement = matchLineEndings(text, newText);
  }
  const count = countOccurrences(text, needle);
  if (count === 0) {
    return messages.editFailed.notFound(relPath);
  }
  if (count > 1) {
    return messages.editFailed.multipleMatches(count, relPath);
  }

  // A request cancelled before (or during) the approval prompt must not land
  // an edit on disk.
  if (signal?.aborted) {
    return messages.cancelled.edit;
  }
  const ok = await approver.confirm(
    messages.approval.editFileTitle,
    messages.approval.editFileDetail(relPath, editPreview(needle), editPreview(replacement))
  );
  if (!ok) {
    return messages.notApproved.edit;
  }
  if (signal?.aborted) {
    return messages.cancelled.edit;
  }
  // The replacement goes through a function so replace() cannot interpret
  // `$&`-style patterns inside model-written code as substitutions.
  const updated = text.replace(needle, () => replacement);
  await vscode.workspace.fs.writeFile(uri, Buffer.from(updated, 'utf8'));
  return `Edited ${relPath} (1 replacement).`;
}
