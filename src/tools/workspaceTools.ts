import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import { Approver } from '../core/types';

const execAsync = promisify(exec);

function workspaceRoot(): vscode.Uri {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    throw new Error('No workspace folder is open.');
  }
  return folder.uri;
}

/** Read a file's text contents. Read-only: no approval needed. */
export async function readFile(relPath: string): Promise<string> {
  const uri = vscode.Uri.joinPath(workspaceRoot(), relPath);
  const bytes = await vscode.workspace.fs.readFile(uri);
  return Buffer.from(bytes).toString('utf8');
}

/** Search by glob (file names) or by content. Read-only: no approval needed. */
export async function searchFiles(
  query: string,
  mode: 'glob' | 'content'
): Promise<string[]> {
  if (mode === 'glob') {
    const uris = await vscode.workspace.findFiles(query, '**/node_modules/**', 200);
    return uris.map((u) => vscode.workspace.asRelativePath(u));
  }

  // Content search: scan candidate files for the query string.
  const uris = await vscode.workspace.findFiles('**/*', '**/node_modules/**', 500);
  const matches: string[] = [];
  for (const uri of uris) {
    try {
      const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
      if (text.includes(query)) {
        matches.push(vscode.workspace.asRelativePath(uri));
      }
    } catch {
      // Skip unreadable/binary files.
    }
    if (matches.length >= 50) break;
  }
  return matches;
}

/** Run a shell command. SIDE-EFFECTING: gated by the Approver. */
export async function runCommand(
  command: string,
  approver: Approver
): Promise<string> {
  const ok = await approver.confirm('Run command', '$ ' + command);
  if (!ok) {
    return 'Command was not approved by the user.';
  }
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: workspaceRoot().fsPath,
      timeout: 60_000,
    });
    return (stdout || '') + (stderr ? `\n[stderr]\n${stderr}` : '');
  } catch (err: any) {
    return `Command failed: ${err?.message ?? String(err)}`;
  }
}

/** Create or overwrite a file. SIDE-EFFECTING: gated by the Approver. */
export async function writeFile(
  relPath: string,
  contents: string,
  approver: Approver
): Promise<string> {
  const uri = vscode.Uri.joinPath(workspaceRoot(), relPath);

  // Build a simple before/after preview for the approval prompt.
  let existing = '';
  try {
    existing = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
  } catch {
    existing = '(new file)';
  }
  const preview =
    `File: ${relPath}\n\n--- current ---\n${truncate(existing)}\n\n` +
    `--- proposed ---\n${truncate(contents)}`;

  const ok = await approver.confirm('Write file', preview);
  if (!ok) {
    return 'Write was not approved by the user.';
  }

  await vscode.workspace.fs.writeFile(uri, Buffer.from(contents, 'utf8'));
  return `Wrote ${relPath} (${contents.length} bytes).`;
}

function truncate(s: string, max = 800): string {
  return s.length > max ? s.slice(0, max) + '\n…(truncated)' : s;
}
