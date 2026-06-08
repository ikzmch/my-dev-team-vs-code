import * as vscode from 'vscode';
import { Approver } from '../core/types';
import { readFile, searchFiles, runCommand, writeFile } from './workspaceTools';

/**
 * Registers the four tools so the model can invoke them via the Language Model
 * Tools API. Side-effecting tools receive the shared Approver.
 *
 * Returns disposables for cleanup on deactivate.
 */
export function registerTools(
  context: vscode.ExtensionContext,
  approver: Approver
): void {
  context.subscriptions.push(
    vscode.lm.registerTool('devteam_readFile', {
      async invoke(options) {
        const { path } = options.input as { path: string };
        const text = await readFile(path);
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(text),
        ]);
      },
    })
  );

  context.subscriptions.push(
    vscode.lm.registerTool('devteam_searchFiles', {
      async invoke(options) {
        const { query, mode } = options.input as {
          query: string;
          mode: 'glob' | 'content';
        };
        const results = await searchFiles(query, mode);
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(
            results.length ? results.join('\n') : '(no matches)'
          ),
        ]);
      },
    })
  );

  context.subscriptions.push(
    vscode.lm.registerTool('devteam_runCommand', {
      async invoke(options) {
        const { command } = options.input as { command: string };
        const output = await runCommand(command, approver);
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(output),
        ]);
      },
    })
  );

  context.subscriptions.push(
    vscode.lm.registerTool('devteam_writeFile', {
      async invoke(options) {
        const { path, contents } = options.input as {
          path: string;
          contents: string;
        };
        const result = await writeFile(path, contents, approver);
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(result),
        ]);
      },
    })
  );
}
