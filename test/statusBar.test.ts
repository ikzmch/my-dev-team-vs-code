import { describe, it, expect, beforeEach } from 'vitest';
import { StatusBar, STATUS_MENU_COMMAND_ID } from '../src/ui/statusBar';
import { SELECT_MODEL_COMMAND_ID } from '../src/ui/modelCommands';
import { SHOW_USAGE_COMMAND_ID } from '../src/ui/usageView';
import { Engine } from '../src/protocol/engine';
import { ModelChoice } from '../src/protocol/types';
import {
  __reset,
  __setConfig,
  __state,
  __setQuickPickResponse,
  commands,
  window,
} from './mocks/vscode';

beforeEach(() => {
  __reset();
});

const choices: ModelChoice[] = [
  { id: 'auto', label: 'Auto', description: 'router', available: true },
  { id: 'qwen3-coder', label: 'Qwen3 Coder (Ollama)', description: 'code', available: true },
];

function fakeEngine(list: ModelChoice[] = choices): Engine {
  return {
    kind: 'local',
    startRun: () => {
      throw new Error('not used');
    },
    startupWarnings: async () => [],
    listModels: async () => list,
  };
}

/** The single status-bar item the constructor created. */
function theItem() {
  return __state.statusBarItems[0];
}

/** The labels of the menu items passed to the last showQuickPick call. */
function lastMenuLabels(): string[] {
  const items = window.showQuickPick.mock.calls.at(-1)![0] as Array<{ label: string }>;
  return items.map((i) => i.label);
}

describe('StatusBar', () => {
  it('creates one branded button bound to the menu command', () => {
    new StatusBar(fakeEngine(), STATUS_MENU_COMMAND_ID);
    expect(__state.statusBarItems).toHaveLength(1);
    expect(theItem().command).toBe(STATUS_MENU_COMMAND_ID);
    expect(theItem().text).toContain('My Dev Team');
  });

  it('shows the active model label in the menu and runs select-model when picked', async () => {
    __setConfig('myDevTeam.model', 'qwen3-coder');
    __state.registeredCommands.set(SELECT_MODEL_COMMAND_ID, () => {});
    const bar = new StatusBar(fakeEngine(), STATUS_MENU_COMMAND_ID);
    await bar.refresh();

    __setQuickPickResponse(0); // the "Select model" row
    await bar.openMenu();

    expect(lastMenuLabels()[0]).toContain('Qwen3 Coder (Ollama)');
    expect(commands.executeCommand).toHaveBeenCalledWith(SELECT_MODEL_COMMAND_ID);
  });

  it('accumulates run usage into the menu total and opens the report when picked', async () => {
    __state.registeredCommands.set(SHOW_USAGE_COMMAND_ID, () => {});
    const bar = new StatusBar(fakeEngine(), STATUS_MENU_COMMAND_ID);
    bar.add([{ step: 'execute', inputTokens: 200, outputTokens: 150 }]);

    __setQuickPickResponse(1); // the "Token usage" row
    await bar.openMenu();

    const usageLabel = lastMenuLabels()[1];
    expect(usageLabel).toContain('350'); // 200 in + 150 out, exact under 1,000
    expect(usageLabel).toContain('this session');
    expect(commands.executeCommand).toHaveBeenCalledWith(SHOW_USAGE_COMMAND_ID);
  });

  it('runs nothing when the menu is dismissed', async () => {
    const bar = new StatusBar(fakeEngine(), STATUS_MENU_COMMAND_ID);
    __setQuickPickResponse(undefined);
    await bar.openMenu();
    expect(commands.executeCommand).not.toHaveBeenCalled();
  });
});
