/**
 * Engine selection: the switch between the in-process LocalEngine and the
 * future RemoteEngine. The `myDevTeam.engine` setting is read live on every
 * request, so flipping it takes effect on the next chat turn without a
 * reload - the same pattern the Ollama endpoint setting follows.
 *
 * Phase A ships only the local engine: selecting "remote" warns (once per
 * switch, not per request) and falls back to local, so the knob and its
 * fallback behavior are built and tested before a remote engine exists.
 * Phase B replaces the fallback branch with a RemoteEngine constructed from
 * `myDevTeam.remote.*` settings and an AuthProvider (see ./auth.ts).
 */
import * as vscode from 'vscode';
import { Engine } from '../protocol/engine';
import { LocalEngine } from '../engine/localEngine';
import { settings } from '../config/settings';
import { messages } from '../config/messages';

/**
 * Returns a provider the UI calls per request. The LocalEngine is built
 * lazily once and reused: its agents are stateless between runs, and the
 * provider wiring underneath already reacts to endpoint changes by itself.
 */
export function createEngineProvider(): () => Engine {
  let local: LocalEngine | undefined;
  let lastChoice: string | undefined;
  return () => {
    const choice = settings.engine;
    if (choice === 'remote' && lastChoice !== 'remote') {
      void vscode.window.showWarningMessage(messages.engine.remoteUnavailable);
    }
    lastChoice = choice;
    return (local ??= new LocalEngine());
  };
}
