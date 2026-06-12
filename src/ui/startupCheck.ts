/**
 * Activation-time health check, surfaced per engine: whichever engine the
 * provider selects answers `startupWarnings()` (the LocalEngine pings the
 * configured Ollama endpoint and verifies the router-selected models are
 * pulled; a remote engine will probe its backend), and this module only
 * shows what comes back. Lives in the UI layer because it talks to
 * vscode.window; what is worth warning about is the engine's knowledge.
 */
import * as vscode from 'vscode';
import { Engine } from '../protocol/engine';

/**
 * Surface the selected engine's startup warnings. Never throws and is not
 * awaited by activation: a slow or absent backend must not delay the
 * extension.
 */
export async function checkEngineAtStartup(engine: Engine): Promise<void> {
  let warnings: string[];
  try {
    warnings = await engine.startupWarnings();
  } catch {
    // The probe itself is best-effort; the first real request will explain.
    return;
  }
  for (const warning of warnings) {
    void vscode.window.showWarningMessage(warning);
  }
}
