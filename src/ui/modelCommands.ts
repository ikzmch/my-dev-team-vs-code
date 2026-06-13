/**
 * Model-selection UI: the `/model` chat command, the command-palette picker,
 * the status-bar item, and the "Set API Key" command. All of it is client UI -
 * the engine only supplies the catalogue (`Engine.listModels`) and is told the
 * chosen id on each run request via the `myDevTeam.model` setting.
 *
 * The client never hardcodes model knowledge: labels, descriptions, and
 * availability all come from the engine catalogue, so the picker stays correct
 * when models are added or a remote engine offers a different set.
 */
import * as vscode from 'vscode';
import { Engine } from '../protocol/engine';
import { ModelChoice } from '../protocol/types';
import { settings } from '../config/settings';
import { messages } from '../config/messages';
import { CloudProvider, setApiKey } from '../config/credentials';

const CONFIG_SECTION = 'myDevTeam';
const MODEL_KEY = 'model';

/** Command id the status-bar item and palette use to open the model picker. */
export const SELECT_MODEL_COMMAND_ID = 'myDevTeam.selectModel';
/** Command id for storing a cloud-provider API key in SecretStorage. */
export const SET_API_KEY_COMMAND_ID = 'myDevTeam.setApiKey';

/** Persist the chosen model id to the user (global) settings. */
export async function setModelChoice(id: string): Promise<void> {
  await vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .update(MODEL_KEY, id, vscode.ConfigurationTarget.Global);
}

/**
 * Resolve a `/model <arg>` value to a catalogue entry, by id or label
 * (case-insensitive). A bare provider name (e.g. "anthropic") also matches its
 * "provider:anthropic" choice, so `/model anthropic` selects that provider.
 */
export function resolveModelArg(
  choices: readonly ModelChoice[],
  arg: string
): ModelChoice | undefined {
  const needle = arg.trim().toLowerCase();
  return choices.find(
    (c) =>
      c.id.toLowerCase() === needle ||
      c.label.toLowerCase() === needle ||
      c.id.toLowerCase() === `provider:${needle}`
  );
}

/** The label for the currently-selected id, found in the catalogue (fallback: the id). */
export function currentModelLabel(choices: readonly ModelChoice[]): string {
  const id = settings.model;
  return choices.find((c) => c.id === id)?.label ?? id;
}

interface ModelQuickPickItem extends vscode.QuickPickItem {
  choice: ModelChoice;
}

/** Open the model quick pick built from the engine catalogue; returns the pick. */
export async function pickModel(engine: Engine): Promise<ModelChoice | undefined> {
  let choices: ModelChoice[];
  try {
    choices = await engine.listModels();
  } catch {
    return undefined;
  }
  const current = settings.model;
  const items: ModelQuickPickItem[] = choices.map((c) => ({
    label: c.label + (c.id === current ? messages.model.currentSuffix : ''),
    description: c.id,
    detail: c.available ? c.description : messages.model.unavailableDetail,
    choice: c,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: messages.model.pickerPlaceholder,
    matchOnDescription: true,
  });
  if (picked) {
    await setModelChoice(picked.choice.id);
  }
  return picked?.choice;
}

/**
 * Answer the `/model` chat command. With an argument it sets the model
 * directly (by id or label); with none it opens the picker. Either way it
 * writes a short confirmation to the chat stream and starts no run.
 */
export async function handleModelChatCommand(
  engine: Engine,
  arg: string,
  stream: vscode.ChatResponseStream
): Promise<void> {
  const trimmed = arg.trim();
  if (!trimmed) {
    const picked = await pickModel(engine);
    if (picked) {
      stream.markdown(messages.model.confirmation(picked.label));
    }
    return;
  }
  let choices: ModelChoice[];
  try {
    choices = await engine.listModels();
  } catch {
    return;
  }
  const match = resolveModelArg(choices, trimmed);
  if (!match) {
    stream.markdown(messages.model.unknown(trimmed));
    return;
  }
  await setModelChoice(match.id);
  stream.markdown(messages.model.confirmation(match.label));
}

/** Provider labels shown in the Set API Key provider pick. */
const PROVIDER_LABELS: Record<CloudProvider, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
};

/**
 * The "Set API Key" command: pick a cloud provider, enter (or clear) its key,
 * and store it in SecretStorage (refreshing the in-memory cache so the next
 * run sees it). Keys never touch settings.json.
 */
export async function runSetApiKeyCommand(secrets: vscode.SecretStorage): Promise<void> {
  const providerItems = (Object.keys(PROVIDER_LABELS) as CloudProvider[]).map(
    (provider) => ({ label: PROVIDER_LABELS[provider], provider })
  );
  const pickedProvider = await vscode.window.showQuickPick(providerItems, {
    placeHolder: messages.model.setKeyProviderPlaceholder,
  });
  if (!pickedProvider) {
    return;
  }
  const key = await vscode.window.showInputBox({
    prompt: messages.model.setKeyInputPrompt(pickedProvider.label),
    password: true,
    ignoreFocusOut: true,
  });
  if (key === undefined) {
    return;
  }
  await setApiKey(secrets, pickedProvider.provider, key);
  void vscode.window.showInformationMessage(
    key.trim()
      ? messages.model.keyStored(pickedProvider.label)
      : messages.model.keyCleared(pickedProvider.label)
  );
}

/**
 * A status-bar item showing the active model; clicking it runs the picker
 * command. `refresh` re-reads the engine catalogue to show the current label;
 * call it on activation and after the setting changes.
 */
export class ModelStatusBar {
  private readonly item: vscode.StatusBarItem;

  constructor(private readonly engine: Engine, pickCommandId: string) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = pickCommandId;
    this.item.tooltip = messages.model.statusBarTooltip;
    this.render(settings.model);
    this.item.show();
  }

  private render(label: string): void {
    this.item.text = messages.model.statusBar(label);
  }

  /** Re-read the catalogue and show the current model's label. */
  async refresh(): Promise<void> {
    try {
      this.render(currentModelLabel(await this.engine.listModels()));
    } catch {
      this.render(settings.model);
    }
  }

  dispose(): void {
    this.item.dispose();
  }
}
