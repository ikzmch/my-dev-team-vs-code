/**
 * Activation-time Ollama health check. Pings the configured endpoint and
 * verifies the models the capability router actually selected are pulled,
 * surfacing a friendly warning instead of letting the first chat request be
 * the thing that fails. Lives in the UI layer because it talks to
 * vscode.window; the agent core stays UI-agnostic.
 */
import * as vscode from 'vscode';
import { agents } from '../config/agents';
import { selectModel } from '../config/models';
import { settings } from '../config/settings';
import { messages } from '../config/messages';

/** The models the router selects for the registered agents, deduplicated. */
export function routedModels(): string[] {
  const names = new Set<string>();
  for (const agent of Object.values(agents)) {
    names.add(selectModel(agent.capabilities).model);
  }
  return [...names];
}

/** Shape of the `GET /api/tags` response, as far as the check reads it. */
interface TagsResponse {
  models?: Array<{ name?: string; model?: string }>;
}

/**
 * Ping `<endpoint>/api/tags` and warn if the server is unreachable or any
 * router-selected model is not pulled. Never throws and is not awaited by
 * activation: a slow or absent Ollama must not delay the extension.
 */
export async function checkOllamaAtStartup(): Promise<void> {
  const endpoint = settings.ollamaEndpoint;

  let installed: Set<string>;
  try {
    const res = await fetch(`${endpoint}/api/tags`, {
      signal: AbortSignal.timeout(settings.startupProbeTimeoutMs),
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const tags = (await res.json()) as TagsResponse;
    installed = new Set(
      (tags.models ?? [])
        .flatMap((m) => [m.name, m.model])
        .filter((n): n is string => typeof n === 'string')
    );
  } catch {
    void vscode.window.showWarningMessage(messages.startup.unreachable(endpoint));
    return;
  }

  // Ollama reports untagged pulls as "<model>:latest", so accept that alias.
  const missing = routedModels().filter(
    (model) => !installed.has(model) && !installed.has(`${model}:latest`)
  );
  if (missing.length > 0) {
    void vscode.window.showWarningMessage(messages.startup.missingModels(missing));
  }
}
