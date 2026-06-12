import * as vscode from 'vscode';
import { clientTools, clientToolNames, ToolHost } from '../protocol/toolContract';

/**
 * Registers the workspace tools so any tool-calling chat model in the editor
 * can invoke them via the Language Model Tools API, under the ids the
 * protocol's tool contract declares (which must match the package.json
 * contribution). Each registration delegates to the shared ToolHost - the
 * same validation, approval gating, and implementations the engine's
 * executor loop uses - so the two surfaces can never behave differently.
 *
 * The registrations are pushed onto context.subscriptions for cleanup on
 * deactivate.
 */
export function registerTools(context: vscode.ExtensionContext, host: ToolHost): void {
  for (const name of clientToolNames) {
    context.subscriptions.push(
      vscode.lm.registerTool(clientTools[name].lmToolId, {
        async invoke(options, token) {
          // Bridge the editor's cancellation token onto the host's abort
          // signal, so an invocation cancelled by the calling chat model
          // stops an in-flight command or pending approval instead of
          // running to its timeout.
          const controller = new AbortController();
          if (token?.isCancellationRequested) {
            controller.abort();
          }
          const cancellation = token?.onCancellationRequested(() => controller.abort());
          try {
            const text = await host.execute(name, options.input, controller.signal);
            return new vscode.LanguageModelToolResult([
              new vscode.LanguageModelTextPart(text),
            ]);
          } finally {
            cancellation?.dispose();
          }
        },
      })
    );
  }
}
