/**
 * Editor entry points: meet the user in the editor, not only the chat panel.
 *
 * Every interaction otherwise starts by typing `@devteam` in the chat. These
 * three shims surface the same agents from where the user is already working,
 * and each is deliberately thin: it opens the chat with a pinned slash command
 * and a framed prompt (the relevant context attached inline), so all the real
 * work - routing, references, approvals - flows through the existing pipeline
 * unchanged. Opening the chat with a query string is identical to the user
 * typing it, so `@devteam /fix ...` pins the route exactly as a typed command
 * would.
 *
 * - **"Fix with Dev Team"** - a quick fix (`vscode.CodeActionProvider`) offered
 *   on a diagnostic, opening `/fix` with `#changes` and the problem described.
 * - **"Explain with Dev Team"** - an editor context-menu action on a selection,
 *   opening `/explain` with the selected code inline.
 * - **"Write/repair tests"** - a CodeLens on a test file, opening `/test`
 *   (repair when the file currently has error diagnostics, else write/update).
 */
import * as vscode from 'vscode';
import { messages } from '../config/messages';
import { settings } from '../config/settings';

/** The chat participant mention that targets @devteam in a chat query. */
const PARTICIPANT_MENTION = '@devteam';

/** VS Code's built-in command that opens the chat view with a prefilled query. */
const CHAT_OPEN_COMMAND = 'workbench.action.chat.open';

/** Command ids the shims register; the code action and lens invoke them. */
export const FIX_DIAGNOSTIC_COMMAND_ID = 'myDevTeam.fixDiagnostic';
export const EXPLAIN_SELECTION_COMMAND_ID = 'myDevTeam.explainSelection';
export const WRITE_OR_REPAIR_TESTS_COMMAND_ID = 'myDevTeam.writeOrRepairTests';

/**
 * Build the chat input a shim submits: the participant mention, the pinned
 * slash command, then the framed prompt. This string is exactly what the user
 * would type, so opening the chat with it reuses the command pinning and the
 * inline-reference (`#changes`) resolution with no special-casing. Exported for
 * tests.
 */
export function buildChatQuery(command: string, prompt: string): string {
  return `${PARTICIPANT_MENTION} /${command} ${prompt}`;
}

/** Open the chat panel with a pinned command and prompt (the shim's whole job). */
async function openChat(command: string, prompt: string): Promise<void> {
  await vscode.commands.executeCommand(CHAT_OPEN_COMMAND, {
    query: buildChatQuery(command, prompt),
  });
}

/**
 * Quick fix on a diagnostic: "Fix with Dev Team". Offered only when the
 * cursor/selection actually sits on one or more diagnostics (VS Code passes
 * those in the context), so the action never appears on clean code. The action
 * carries a command that opens `/fix` with the problems described.
 */
export class FixCodeActionProvider implements vscode.CodeActionProvider {
  static readonly providedKinds = [vscode.CodeActionKind.QuickFix];

  provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext
  ): vscode.CodeAction[] {
    const diagnostics = context.diagnostics;
    if (diagnostics.length === 0) {
      return [];
    }
    const problems = diagnostics.map((d) =>
      messages.editor.fixProblem(d.range.start.line + 1, d.message)
    );
    const action = new vscode.CodeAction(
      messages.editor.fixActionTitle,
      vscode.CodeActionKind.QuickFix
    );
    action.diagnostics = [...diagnostics];
    action.command = {
      command: FIX_DIAGNOSTIC_COMMAND_ID,
      title: messages.editor.fixActionTitle,
      arguments: [document.uri, problems],
    };
    return [action];
  }
}

/** Handle the fix command: open `/fix` framed against the diagnostic(s). */
async function fixDiagnostic(uri: vscode.Uri, problems: readonly string[]): Promise<void> {
  const relPath = vscode.workspace.asRelativePath(uri);
  await openChat('fix', messages.editor.fixPrompt(relPath, problems));
}

/**
 * Context-menu action: explain the current editor selection. Reads the active
 * editor's selection and opens `/explain` with the code inlined (capped so a
 * huge selection cannot blow up the prompt). The menu item is gated on a
 * non-empty selection; the guard here keeps a palette invocation honest.
 */
async function explainSelection(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) {
    void vscode.window.showInformationMessage(messages.editor.explainNoSelection);
    return;
  }
  const selection = editor.selection;
  const code = editor.document.getText(selection);
  const capped =
    code.length > settings.maxAttachmentChars
      ? code.slice(0, settings.maxAttachmentChars) + '\n. . . (truncated)'
      : code;
  const relPath = vscode.workspace.asRelativePath(editor.document.uri);
  await openChat(
    'explain',
    messages.editor.explainPrompt(
      relPath,
      selection.start.line + 1,
      selection.end.line + 1,
      capped
    )
  );
}

/** A path in a test directory, or a file named like a test/spec across languages. */
function isTestFile(relPath: string): boolean {
  const p = relPath.toLowerCase().replace(/\\/g, '/');
  if (/(^|\/)(tests?|__tests__)\//.test(p)) {
    return true;
  }
  const base = p.split('/').pop() ?? '';
  // foo.test.ts / foo.spec.js / foo_test.go / test_foo.py
  return /\.(test|spec)\./.test(base) || /_(test|spec)\./.test(base) || /^test_/.test(base);
}

/** True when the file currently carries at least one error-severity diagnostic. */
function hasFailingDiagnostics(uri: vscode.Uri): boolean {
  return vscode.languages
    .getDiagnostics(uri)
    .some((d) => d.severity === vscode.DiagnosticSeverity.Error);
}

/**
 * CodeLens on a test file: one lens at the top offering to write/update its
 * tests, or - when the file currently has error diagnostics (a failing test or
 * a compile error) - to repair them. A CodeLens cannot read another test
 * runner's pass/fail results, so error diagnostics are the available "failing"
 * signal; the lens still helps write or update tests when there are none.
 */
export class TestCodeLensProvider implements vscode.CodeLensProvider {
  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const relPath = vscode.workspace.asRelativePath(document.uri);
    if (!isTestFile(relPath)) {
      return [];
    }
    const failing = hasFailingDiagnostics(document.uri);
    const lens = new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
      command: WRITE_OR_REPAIR_TESTS_COMMAND_ID,
      title: failing ? messages.editor.testLensRepair : messages.editor.testLensWrite,
      arguments: [document.uri, failing],
    });
    return [lens];
  }
}

/** Handle the test lens command: open `/test` to write/update or repair. */
async function writeOrRepairTests(uri: vscode.Uri, failing: boolean): Promise<void> {
  const relPath = vscode.workspace.asRelativePath(uri);
  await openChat('test', messages.editor.testPrompt(relPath, failing));
}

/**
 * Register the editor entry points: the three shim commands plus the code
 * action and CodeLens providers that surface them. Called once on activation.
 */
export function registerEditorEntryPoints(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(FIX_DIAGNOSTIC_COMMAND_ID, (uri, problems) =>
      fixDiagnostic(uri as vscode.Uri, problems as string[])
    ),
    vscode.commands.registerCommand(EXPLAIN_SELECTION_COMMAND_ID, () => explainSelection()),
    vscode.commands.registerCommand(WRITE_OR_REPAIR_TESTS_COMMAND_ID, (uri, failing) =>
      writeOrRepairTests(uri as vscode.Uri, failing as boolean)
    ),
    vscode.languages.registerCodeActionsProvider(
      { scheme: 'file' },
      new FixCodeActionProvider(),
      { providedCodeActionKinds: FixCodeActionProvider.providedKinds }
    ),
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, new TestCodeLensProvider())
  );
}
