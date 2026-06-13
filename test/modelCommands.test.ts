import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  handleModelChatCommand,
  pickModel,
  resolveModelArg,
  currentModelLabel,
  runSetApiKeyCommand,
} from '../src/ui/modelCommands';
import { Engine } from '../src/protocol/engine';
import { ModelChoice } from '../src/protocol/types';
import {
  __reset,
  __setConfig,
  __state,
  __setQuickPickResponse,
  __setInputBoxResponse,
  secrets,
  window,
} from './mocks/vscode';

beforeEach(() => {
  __reset();
});

const choices: ModelChoice[] = [
  { id: 'auto', label: 'Auto', description: 'router', available: true },
  { id: 'provider:anthropic', label: 'Anthropic (best available)', description: 'cloud', available: false },
  { id: 'qwen3-coder', label: 'Qwen3 Coder (Ollama)', description: 'code', available: true },
  { id: 'anthropic-opus', label: 'Claude Opus 4.8 (Anthropic)', description: 'best', available: false },
];

/** A stub engine that only answers listModels. */
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

function fakeStream() {
  return { markdown: vi.fn() };
}

function modelSetting(): unknown {
  return __state.configuration.get('myDevTeam.model');
}

describe('resolveModelArg', () => {
  it('matches by id or label, case-insensitively', () => {
    expect(resolveModelArg(choices, 'qwen3-coder')?.id).toBe('qwen3-coder');
    expect(resolveModelArg(choices, 'Claude Opus 4.8 (Anthropic)')?.id).toBe('anthropic-opus');
    expect(resolveModelArg(choices, 'AUTO')?.id).toBe('auto');
    expect(resolveModelArg(choices, 'nope')).toBeUndefined();
  });

  it('matches a bare provider name to its provider choice', () => {
    expect(resolveModelArg(choices, 'anthropic')?.id).toBe('provider:anthropic');
    expect(resolveModelArg(choices, 'ANTHROPIC')?.id).toBe('provider:anthropic');
  });
});

describe('currentModelLabel', () => {
  it('returns the label of the configured id, falling back to the id', () => {
    __setConfig('myDevTeam.model', 'qwen3-coder');
    expect(currentModelLabel(choices)).toBe('Qwen3 Coder (Ollama)');
    __setConfig('myDevTeam.model', 'unlisted');
    expect(currentModelLabel(choices)).toBe('unlisted');
  });
});

describe('handleModelChatCommand', () => {
  it('sets the model from an argument and confirms', async () => {
    const stream = fakeStream();
    await handleModelChatCommand(fakeEngine(), 'qwen3-coder', stream as any);
    expect(modelSetting()).toBe('qwen3-coder');
    expect(stream.markdown.mock.calls[0][0]).toContain('Qwen3 Coder (Ollama)');
  });

  it('sets a provider from a bare provider name', async () => {
    const stream = fakeStream();
    await handleModelChatCommand(fakeEngine(), 'anthropic', stream as any);
    expect(modelSetting()).toBe('provider:anthropic');
    expect(stream.markdown.mock.calls[0][0]).toContain('Anthropic (best available)');
  });

  it('reports an unknown argument without changing the setting', async () => {
    const stream = fakeStream();
    await handleModelChatCommand(fakeEngine(), 'gpt-9', stream as any);
    expect(modelSetting()).toBeUndefined();
    expect(stream.markdown.mock.calls[0][0]).toContain('No model "gpt-9"');
  });

  it('with no argument opens the picker and sets the chosen model', async () => {
    __setQuickPickResponse(2); // the qwen3-coder entry
    const stream = fakeStream();
    await handleModelChatCommand(fakeEngine(), '   ', stream as any);
    expect(modelSetting()).toBe('qwen3-coder');
    expect(stream.markdown.mock.calls[0][0]).toContain('Qwen3 Coder (Ollama)');
  });

  it('with no argument and a dismissed picker writes nothing', async () => {
    __setQuickPickResponse(undefined);
    const stream = fakeStream();
    await handleModelChatCommand(fakeEngine(), '', stream as any);
    expect(modelSetting()).toBeUndefined();
    expect(stream.markdown).not.toHaveBeenCalled();
  });
});

describe('pickModel', () => {
  it('writes the chosen id and returns it', async () => {
    __setQuickPickResponse(3); // anthropic-opus
    const picked = await pickModel(fakeEngine());
    expect(picked?.id).toBe('anthropic-opus');
    expect(modelSetting()).toBe('anthropic-opus');
  });
});

describe('runSetApiKeyCommand', () => {
  it('stores the entered key for the chosen provider', async () => {
    __setQuickPickResponse(0); // OpenAI
    __setInputBoxResponse('sk-test');
    await runSetApiKeyCommand(secrets);
    expect(__state.secrets.get('myDevTeam.openai.apiKey')).toBe('sk-test');
    expect(window.showInformationMessage).toHaveBeenCalled();
  });

  it('does nothing when the provider pick is dismissed', async () => {
    __setQuickPickResponse(undefined);
    await runSetApiKeyCommand(secrets);
    expect(__state.secrets.size).toBe(0);
  });

  it('does nothing when the key input is dismissed', async () => {
    __setQuickPickResponse(0);
    __setInputBoxResponse(undefined);
    await runSetApiKeyCommand(secrets);
    expect(__state.secrets.size).toBe(0);
  });
});
