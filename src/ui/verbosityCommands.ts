/**
 * Output-verbosity UI: the `/verbose` chat command, the command-palette picker,
 * and the status-bar menu row. All of it is client UI - verbosity is purely a
 * rendering choice (how much of each agent's block the chat shows; see
 * config/settings.ts `Verbosity`), so the engine never learns the mode and the
 * full reply data crosses the protocol either way.
 *
 * The chosen mode is stored in the `myDevTeam.verbosity` setting and read live
 * by the renderer (`renderReply`), so flipping it takes effect on the next
 * reply with no run in flight.
 */
import * as vscode from 'vscode';
import { settings, Verbosity } from '../config/settings';
import { messages } from '../config/messages';

const CONFIG_SECTION = 'myDevTeam';
const VERBOSITY_KEY = 'verbosity';

/** The two modes, in the order the picker lists them. */
const MODES: readonly Verbosity[] = ['verbose', 'default'];

/** Command id the status-bar menu and palette use to open the verbosity picker. */
export const SELECT_VERBOSITY_COMMAND_ID = 'myDevTeam.selectVerbosity';

/** Persist the chosen mode to the user (global) settings. */
export async function setVerbosityChoice(mode: Verbosity): Promise<void> {
  await vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .update(VERBOSITY_KEY, mode, vscode.ConfigurationTarget.Global);
}

/** The human label for the currently-selected mode (for the status-bar menu). */
export function currentVerbosityLabel(): string {
  return messages.verbosity.label(settings.verbosity);
}

/** Resolve a `/verbose <arg>` value to a mode, by id or label (case-insensitive). */
export function resolveVerbosityArg(arg: string): Verbosity | undefined {
  const needle = arg.trim().toLowerCase();
  return MODES.find(
    (mode) => mode === needle || messages.verbosity.label(mode).toLowerCase() === needle
  );
}

interface VerbosityQuickPickItem extends vscode.QuickPickItem {
  mode: Verbosity;
}

/**
 * Open the verbosity quick pick and apply the choice. Returns the applied mode's
 * label, or undefined when dismissed.
 */
export async function pickVerbosity(): Promise<string | undefined> {
  const current = settings.verbosity;
  const items: VerbosityQuickPickItem[] = MODES.map((mode) => ({
    label: messages.verbosity.label(mode) + (mode === current ? messages.verbosity.currentSuffix : ''),
    detail: messages.verbosity.detail(mode),
    mode,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: messages.verbosity.pickerPlaceholder,
  });
  if (!picked) {
    return undefined;
  }
  await setVerbosityChoice(picked.mode);
  return messages.verbosity.label(picked.mode);
}

/**
 * Answer the `/verbose` chat command. With an argument it sets the mode directly
 * (by id or label); with none it opens the picker. Either way it writes a short
 * confirmation to the chat stream and starts no run.
 */
export async function handleVerbosityChatCommand(
  arg: string,
  stream: vscode.ChatResponseStream
): Promise<void> {
  const trimmed = arg.trim();
  if (!trimmed) {
    const label = await pickVerbosity();
    if (label) {
      stream.markdown(messages.verbosity.confirmation(label));
    }
    return;
  }
  const mode = resolveVerbosityArg(trimmed);
  if (!mode) {
    stream.markdown(messages.verbosity.unknown(trimmed));
    return;
  }
  await setVerbosityChoice(mode);
  stream.markdown(messages.verbosity.confirmation(messages.verbosity.label(mode)));
}
