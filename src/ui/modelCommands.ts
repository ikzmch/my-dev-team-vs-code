/**
 * Model-selection UI: the `/model` chat command, the command-palette picker,
 * the status-bar item, and the "Set API Key" command. All of it is client UI -
 * the engine only supplies the catalogue (`Engine.listModels`) and is told the
 * chosen ids on each run request via the `myDevTeam.model` (work agents) and
 * `myDevTeam.triage.model` settings. The picker groups the catalogue so one
 * click can point the whole team (triage + work agents) at a provider, while an
 * advanced section still lets triage be set on its own.
 *
 * Cloud keys stored via "Set API Key" go to the editor's SecretStorage and are
 * used by the in-process local engine (the sidecar and a future remote backend
 * read keys only from environment variables - see config/credentials.ts and
 * client/secrets.ts).
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
import { CloudProvider } from '../config/credentials';
import { cloudProviderDescriptors } from '../config/providers';
import { setApiKey } from '../client/secrets';

const CONFIG_SECTION = 'myDevTeam';
const MODEL_KEY = 'model';
const TRIAGE_MODEL_KEY = 'triage.model';

/** The catalogue's "let the router pick" id. */
const AUTO_ID = 'auto';
/** Prefix of a catalogue id that pins a whole provider rather than one model. */
const PROVIDER_PREFIX = 'provider:';

/**
 * Which agents a picked choice applies to:
 * - `both`  - triage and the work agents (a provider/Auto choice points the
 *   whole team at one place, the simple common case);
 * - `work`  - the planner/answerer/executor only (pinning one specific model);
 * - `triage` - the quick triage classifier only (the advanced split).
 */
export type ModelScope = 'both' | 'work' | 'triage';

/**
 * The scope a non-triage choice carries: a provider pin or Auto routes the
 * whole team (`both`); a specific model id pins the work agents only (`work`).
 * Triage-only rows set their scope explicitly, so this is never asked of them.
 */
function scopeOf(id: string): ModelScope {
  return id === AUTO_ID || id.startsWith(PROVIDER_PREFIX) ? 'both' : 'work';
}

/** Command id the status-bar item and palette use to open the model picker. */
export const SELECT_MODEL_COMMAND_ID = 'myDevTeam.selectModel';
/** Command id for storing a cloud-provider API key in SecretStorage (local engine). */
export const SET_API_KEY_COMMAND_ID = 'myDevTeam.setApiKey';

/** Persist the chosen model id to the user (global) settings. */
export async function setModelChoice(id: string): Promise<void> {
  await vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .update(MODEL_KEY, id, vscode.ConfigurationTarget.Global);
}

/** Persist the chosen triage model id to the user (global) settings. */
export async function setTriageModelChoice(id: string): Promise<void> {
  await vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .update(TRIAGE_MODEL_KEY, id, vscode.ConfigurationTarget.Global);
}

/**
 * Apply a chosen id to the settings its scope covers: `both` writes the work
 * model and triage together, `work` only the work model, `triage` only triage.
 */
export async function applyModelChoice(id: string, scope: ModelScope): Promise<void> {
  if (scope === 'triage') {
    await setTriageModelChoice(id);
    return;
  }
  await setModelChoice(id);
  if (scope === 'both') {
    await setTriageModelChoice(id);
  }
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
  /** Absent on separator rows; present on real choices. */
  choice?: ModelChoice;
  /** The scope a pick applies (absent on separators). */
  scope?: ModelScope;
}

/** A separator header grouping the picker. */
function separator(label: string): ModelQuickPickItem {
  return { label, kind: vscode.QuickPickItemKind.Separator };
}

/** One selectable row for a catalogue choice, with its apply scope. */
function row(c: ModelChoice, scope: ModelScope, current: string): ModelQuickPickItem {
  const label = scope === 'triage' ? messages.model.triageLabel(c.label) : c.label;
  return {
    label: label + (c.id === current ? messages.model.currentSuffix : ''),
    description: c.id,
    detail: c.disabled
      ? messages.model.disabledDetail
      : c.available
      ? c.description
      : messages.model.unavailableDetail,
    choice: c,
    scope,
  };
}

/** What a finished pick applied, so the caller can confirm it. */
export interface PickedModel {
  label: string;
  scope: ModelScope;
}

/**
 * Open the model quick pick built from the engine catalogue, grouped so the
 * common case is one click: the top rows (Auto, then each provider) point the
 * whole team - triage and the work agents - at one place; a "specific model"
 * group pins a single model for the work agents; and a "Triage only" group
 * overrides triage alone for a split setup (e.g. cheap local triage, cloud
 * executor). Returns what was applied, or undefined when dismissed.
 */
export async function pickModel(engine: Engine): Promise<PickedModel | undefined> {
  let choices: ModelChoice[];
  try {
    choices = await engine.listModels();
  } catch {
    return undefined;
  }
  const work = settings.model;
  const triage = settings.triageModel;
  const auto = choices.find((c) => c.id === AUTO_ID);
  const providers = choices.filter((c) => c.id.startsWith(PROVIDER_PREFIX));
  const models = choices.filter((c) => c.id !== AUTO_ID && !c.id.startsWith(PROVIDER_PREFIX));

  const items: ModelQuickPickItem[] = [];
  items.push(separator(messages.model.everythingSeparator));
  if (auto) {
    items.push(row(auto, 'both', work));
  }
  for (const p of providers) {
    items.push(row(p, 'both', work));
  }
  if (models.length) {
    items.push(separator(messages.model.specificModelSeparator));
    for (const m of models) {
      items.push(row(m, 'work', work));
    }
  }
  items.push(separator(messages.model.triageSeparator));
  for (const c of [...(auto ? [auto] : []), ...providers, ...models]) {
    items.push(row(c, 'triage', triage));
  }

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: messages.model.pickerPlaceholder,
    matchOnDescription: true,
  });
  if (!picked?.choice || !picked.scope) {
    return undefined;
  }
  await applyModelChoice(picked.choice.id, picked.scope);
  return { label: picked.choice.label, scope: picked.scope };
}

/** The chat confirmation copy for an applied pick, by scope. */
function confirmationFor(label: string, scope: ModelScope): string {
  return scope === 'both'
    ? messages.model.confirmationBoth(label)
    : scope === 'triage'
    ? messages.model.confirmationTriage(label)
    : messages.model.confirmation(label);
}

/**
 * Answer the `/model` chat command. With an argument it sets the model
 * directly (by id or label) - a provider name or "auto" points the whole team,
 * a specific model pins the work agents - with none it opens the picker. Either
 * way it writes a short confirmation to the chat stream and starts no run.
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
      stream.markdown(confirmationFor(picked.label, picked.scope));
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
  const scope = scopeOf(match.id);
  await applyModelChoice(match.id, scope);
  stream.markdown(confirmationFor(match.label, scope));
}

/**
 * The "Set API Key" command: pick a cloud provider, enter (or clear) its key,
 * and store it in SecretStorage (refreshing the in-memory cache so the next run
 * sees it). Keys never touch settings.json. Stored keys are used by the
 * in-process local engine; the sidecar engine reads keys from environment
 * variables instead, so a key set here has no effect in sidecar mode. The
 * provider list and labels come from the single provider registry.
 */
export async function runSetApiKeyCommand(secrets: vscode.SecretStorage): Promise<void> {
  const providerItems = cloudProviderDescriptors.map((d) => ({
    label: d.label,
    provider: d.id as CloudProvider,
  }));
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
