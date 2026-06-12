import * as vscode from 'vscode';
import * as path from 'path';
import { exec, ChildProcess } from 'child_process';
import { promisify } from 'util';
import { Approver, RunMirror } from '../core/types';
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
 */
function resolveWorkspaceUri(relPath: string): vscode.Uri {
  const root = workspaceRoot();
  const rootPath = path.resolve(root.fsPath);
  const target = path.resolve(rootPath, relPath);
  const rel = path.relative(rootPath, target);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path is outside the workspace: ${relPath}`);
  }
  return vscode.Uri.joinPath(root, ...rel.split(/[\\/]/));
}

/** Read a file's text contents. Read-only: no approval needed. */
export async function readFile(relPath: string): Promise<string> {
  const uri = resolveWorkspaceUri(relPath);
  const bytes = await vscode.workspace.fs.readFile(uri);
  const text = Buffer.from(bytes).toString('utf8');
  return text.length > settings.readMaxChars
    ? text.slice(0, settings.readMaxChars) + '\n…(truncated)'
    : text;
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
      const bytes = await vscode.workspace.fs.readFile(uri);
      // Skip oversized files and binaries (a NUL byte marks binary content;
      // decoding never throws, so this cannot be left to the catch below).
      if (bytes.byteLength > settings.search.maxFileSizeBytes || bytes.includes(0)) {
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
  mirror?: RunMirror
): Promise<string> {
  const cwd = workspaceRoot().fsPath;
  const ok = await approver.confirm(messages.approval.runCommandTitle, '$ ' + command);
  if (!ok) {
    // Declined commands never ran, so they never reach the mirror either.
    return messages.notApproved.run;
  }

  let timedOut = false;
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

  try {
    const { stdout, stderr } = await pending;
    mirror?.end(messages.terminal.completed);
    return combineOutput(String(stdout), String(stderr));
  } catch (err: any) {
    // A failed command's output is what the caller needs to diagnose it, so
    // include the stdout/stderr exec attaches to the error.
    const reason = timedOut
      ? `Command timed out after ${settings.runCommandTimeoutMs} ms and was killed.`
      : `Command failed: ${err?.message ?? String(err)}`;
    mirror?.end(reason);
    const output = combineOutput(String(err?.stdout ?? ''), String(err?.stderr ?? ''));
    return output ? `${reason}\n${output}` : reason;
  } finally {
    clearTimeout(killTimer);
  }
}

function combineOutput(stdout: string, stderr: string): string {
  return (stdout || '') + (stderr ? `\n[stderr]\n${stderr}` : '');
}

/** Create or overwrite a file. Writes without asking for approval. */
export async function writeFile(relPath: string, contents: string): Promise<string> {
  const uri = resolveWorkspaceUri(relPath);
  await vscode.workspace.fs.writeFile(uri, Buffer.from(contents, 'utf8'));
  return `Wrote ${relPath} (${Buffer.byteLength(contents, 'utf8')} bytes).`;
}
