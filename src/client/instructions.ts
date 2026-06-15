/**
 * Reads the workspace's standing instruction file (AGENTS.md/CLAUDE.md) for a
 * run request. This is client work by design: the engine is stateless and has
 * no workspace access (tools are inverted), so the client resolves the file
 * per request - like it resolves attachments - and ships the text on the
 * RunRequest. Reading fresh every request means an edit to the file takes
 * effect on the very next message, matching the live-settings philosophy.
 */
import * as vscode from 'vscode';
import { ProjectInstructions } from '../protocol/types';
import { settings } from '../config/settings';

/**
 * Resolve the workspace's project instructions: probe the configured file
 * names (`myDevTeam.instructions.files`) in the workspace root in order and
 * return the first that exists with non-blank content, truncated to
 * `settings.instructions.maxChars`. Returns undefined - never throws - when
 * there is no workspace, no candidate file exists, the file is empty, or the
 * feature is disabled (an empty file list): a missing instruction file must
 * never fail or delay the turn.
 */
export async function collectInstructions(): Promise<ProjectInstructions | undefined> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) {
    return undefined;
  }
  for (const name of settings.instructions.files) {
    let text: string;
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, name));
      text = Buffer.from(bytes).toString('utf8');
    } catch {
      continue; // Not present (or unreadable): try the next candidate.
    }
    if (!text.trim()) {
      continue;
    }
    const max = settings.instructions.maxChars;
    if (text.length > max) {
      text = text.slice(0, max) + '\n. . . (truncated)';
    }
    return { source: name, text };
  }
  return undefined;
}
