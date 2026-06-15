/**
 * Discovers the skills available to a run. Like the standing instruction file
 * (instructions.ts), this is client work by design: the engine is stateless and
 * has no filesystem access, so the client finds the SKILL.md files, reads them,
 * and ships the raw text on the request - the engine parses them and merges them
 * with its built-in skills. Reading fresh every request means an edit to a skill
 * takes effect on the very next message.
 *
 * A skill lives at `<dir>/<name>/SKILL.md`, where `<dir>` is one of the
 * configured skills directories (`myDevTeam.skills.directories`, e.g.
 * `.devteam/skills` or `.claude/skills`). Those directories are looked for in
 * two places: every workspace root (a skill committed to the project) and the
 * user's home directory (a personal skill shared across projects). Workspace
 * skills take precedence over home skills of the same name, so they are
 * collected first and the engine keeps the first occurrence of each name.
 */
import * as os from 'os';
import * as vscode from 'vscode';
import { WorkspaceSkill } from '../protocol/types';
import { settings } from '../config/settings';
import { truncateForDisplay } from '../config/messages';

const SKILL_FILE = 'SKILL.md';

/** The user's home directory, or undefined when it cannot be determined. */
function homeDirectory(): string | undefined {
  try {
    const dir = os.homedir();
    return dir && dir.trim() ? dir : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A readable source label for a discovered skill file: workspace-relative for a
 * skill in the workspace, `~/...` for one under the home directory.
 */
function sourceLabel(file: vscode.Uri, home: string | undefined): string {
  if (home) {
    const homePath = vscode.Uri.file(home).path;
    if (file.path === homePath || file.path.startsWith(homePath + '/')) {
      return '~' + file.path.slice(homePath.length);
    }
  }
  return vscode.workspace.asRelativePath(file);
}

/**
 * Find the skills available to this run: for each base location (workspace roots
 * first, then the home directory) and each configured directory, the SKILL.md
 * files one level below it, read and capped to `settings.skills.maxChars`, up to
 * `settings.skills.maxSkills` in total. Returns each file's raw text plus a
 * readable source label, **highest precedence first** (workspace before home),
 * so the engine resolves a name clash in the project's favour. Never throws and
 * returns an empty array when there is nowhere to look or the feature is
 * disabled (an empty directory list): a missing skill must never fail or delay
 * the turn.
 */
export async function collectSkills(): Promise<WorkspaceSkill[]> {
  const dirs = settings.skills.directories;
  if (dirs.length === 0) {
    return [];
  }

  // Base locations, highest precedence first: each workspace root, then the
  // user's home directory. The configured directories are tried under each, in
  // their listed order.
  const home = homeDirectory();
  const bases: vscode.Uri[] = [
    ...(vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri),
  ];
  if (home) {
    bases.push(vscode.Uri.file(home));
  }
  if (bases.length === 0) {
    return [];
  }

  const max = settings.skills.maxChars;
  const skills: WorkspaceSkill[] = [];
  // A workspace root could coincide with (or nest under) the home directory;
  // de-duplicate by the SKILL.md path so the same file is never shipped twice.
  const seen = new Set<string>();

  for (const base of bases) {
    for (const dir of dirs) {
      if (skills.length >= settings.skills.maxSkills) {
        return skills;
      }
      const root = vscode.Uri.joinPath(base, ...dir.split('/'));
      let entries: [string, vscode.FileType][];
      try {
        entries = await vscode.workspace.fs.readDirectory(root);
      } catch {
        continue; // The directory does not exist here: nothing to read.
      }
      for (const [name, type] of entries) {
        if (skills.length >= settings.skills.maxSkills) {
          return skills;
        }
        // Skills live in `<dir>/<name>/SKILL.md`; ignore stray files.
        if ((type & vscode.FileType.Directory) === 0) {
          continue;
        }
        const file = vscode.Uri.joinPath(root, name, SKILL_FILE);
        if (seen.has(file.path)) {
          continue;
        }
        let text: string;
        try {
          const bytes = await vscode.workspace.fs.readFile(file);
          text = Buffer.from(bytes).toString('utf8');
        } catch {
          continue; // No SKILL.md in this folder.
        }
        if (!text.trim()) {
          continue;
        }
        seen.add(file.path);
        skills.push({ source: sourceLabel(file, home), text: truncateForDisplay(text, max) });
      }
    }
  }
  return skills;
}
