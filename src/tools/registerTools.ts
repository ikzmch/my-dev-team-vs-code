import * as vscode from 'vscode';
import { Approver, RunMirror } from '../core/types';
import { toolConfigs } from '../config/tools';
import { readFile, searchFiles, runCommand, writeFile } from './workspaceTools';

/**
 * Registers the four tools so the model can invoke them via the Language Model
 * Tools API, under the ids the tool configs declare (config/tools/*.md, which
 * must match the package.json contribution). Side-effecting tools receive the
 * shared Approver, and `run` mirrors its commands to the shared RunMirror.
 *
 * The registrations are pushed onto context.subscriptions for cleanup on
 * deactivate.
 */
export function registerTools(
  context: vscode.ExtensionContext,
  approver: Approver,
  mirror?: RunMirror
): void {
  context.subscriptions.push(
    vscode.lm.registerTool(toolConfigs.read.lmTool, {
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
    vscode.lm.registerTool(toolConfigs.search.lmTool, {
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
    vscode.lm.registerTool(toolConfigs.run.lmTool, {
      async invoke(options) {
        const { command } = options.input as { command: string };
        const output = await runCommand(command, approver, mirror);
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(output),
        ]);
      },
    })
  );

  context.subscriptions.push(
    vscode.lm.registerTool(toolConfigs.write.lmTool, {
      async invoke(options) {
        const { path, contents } = options.input as {
          path: string;
          contents: string;
        };
        const result = await writeFile(path, contents);
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(result),
        ]);
      },
    })
  );
}
