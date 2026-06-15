/**
 * Engine selection: the switch between the in-process `LocalEngine`, the
 * `sidecar` child process (same engine, separate process), and the future
 * `RemoteEngine`. The `myDevTeam.engine` setting is read live on every request,
 * so flipping it takes effect on the next chat turn without a reload.
 *
 * - `local` (default): the engine runs in the extension host.
 * - `sidecar`: the engine runs in a forked Node child (`dist/sidecar.js`) and
 *   talks over the sidecar protocol; the client keeps the tools, approval, and
 *   rendering. The child is spawned lazily on first use and reused, its config
 *   refreshed when the user changes a setting, and killed on deactivate.
 * - `remote`: not built yet; warns once and falls back to local.
 */
import * as vscode from 'vscode';
import { Engine } from '../protocol/engine';
import { LocalEngine } from '../engine/localEngine';
import { SidecarEngine, createForkedChannel } from './sidecarEngine';
import { providersWithStoredKeyButNoEnv } from './secrets';
import { providerDescriptor, providerLabels } from '../config/providers';
import { settings, runtimeConfigSnapshot } from '../config/settings';
import { messages } from '../config/messages';

/** What the extension uses to obtain the current engine and to tear it down. */
export interface EngineProvider {
  /** The engine for the live `myDevTeam.engine` setting (built lazily, reused). */
  getEngine(): Engine;
  /** Stop the config subscription and kill the sidecar child, if any. */
  dispose(): void;
}

/**
 * Build the engine provider. `sidecarScriptPath` is the absolute path to the
 * bundled child entry (`dist/sidecar.js`), used only when the user picks the
 * sidecar engine. The LocalEngine and the SidecarEngine are each built once and
 * reused: agents are stateless between runs, and the provider wiring underneath
 * reacts to config changes on its own (the sidecar by a pushed refresh).
 */
export function createEngineProvider(sidecarScriptPath: string): EngineProvider {
  let local: LocalEngine | undefined;
  let sidecar: SidecarEngine | undefined;
  let warnedRemote = false;
  let warnedSidecarSecrets = false;

  // The sidecar child reads cloud keys from the environment only, so a key the
  // user set via "Set API Key" (SecretStorage) silently stops working under it.
  // Warn once when sidecar is selected and that mismatch exists; re-armed when
  // the user switches away, the same way the remote warning is.
  const warnSidecarSecrets = (): void => {
    if (warnedSidecarSecrets) {
      return;
    }
    const affected = providersWithStoredKeyButNoEnv();
    if (affected.length === 0) {
      return;
    }
    warnedSidecarSecrets = true;
    const list = affected
      .map((id) => `${providerLabels[id]} (set ${providerDescriptor(id).envKey})`)
      .join(', ');
    void vscode.window.showWarningMessage(messages.engine.sidecarSecretKeysIgnored(list));
  };

  const getEngine = (): Engine => {
    const choice = settings.engine;
    if (choice !== 'sidecar') {
      warnedSidecarSecrets = false;
    }
    if (choice !== 'remote') {
      warnedRemote = false;
    }
    if (choice === 'sidecar') {
      warnSidecarSecrets();
      return (sidecar ??= new SidecarEngine(
        createForkedChannel(sidecarScriptPath),
        runtimeConfigSnapshot
      ));
    }
    if (choice === 'remote' && !warnedRemote) {
      void vscode.window.showWarningMessage(messages.engine.remoteUnavailable);
      warnedRemote = true;
    }
    return (local ??= new LocalEngine());
  };

  // Keep the sidecar's injected config live: re-send the snapshot whenever a
  // `myDevTeam.*` setting changes (the local engine reads `settings` directly).
  const configSub = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('myDevTeam')) {
      sidecar?.refreshConfig();
    }
  });

  return {
    getEngine,
    dispose: () => {
      configSub.dispose();
      sidecar?.dispose();
    },
  };
}
