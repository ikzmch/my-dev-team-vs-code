import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  handleVerbosityChatCommand,
  pickVerbosity,
  resolveVerbosityArg,
  currentVerbosityLabel,
} from '../src/ui/verbosityCommands';
import {
  __reset,
  __setConfig,
  __state,
  __setQuickPickResponse,
  window,
} from './mocks/vscode';

beforeEach(() => {
  __reset();
});

function fakeStream() {
  return { markdown: vi.fn() };
}

function verbositySetting(): unknown {
  return __state.configuration.get('myDevTeam.verbosity');
}

describe('resolveVerbosityArg', () => {
  it('matches by id or label, case-insensitively', () => {
    expect(resolveVerbosityArg('default')).toBe('default');
    expect(resolveVerbosityArg('verbose')).toBe('verbose');
    expect(resolveVerbosityArg('Verbose')).toBe('verbose');
    expect(resolveVerbosityArg('DEFAULT')).toBe('default');
    expect(resolveVerbosityArg('nope')).toBeUndefined();
  });
});

describe('currentVerbosityLabel', () => {
  it('defaults to Verbose and reflects the configured mode', () => {
    expect(currentVerbosityLabel()).toBe('Verbose'); // shipped default
    __setConfig('myDevTeam.verbosity', 'default');
    expect(currentVerbosityLabel()).toBe('Default');
  });
});

describe('handleVerbosityChatCommand', () => {
  it('sets the mode from an argument and confirms it', async () => {
    const stream = fakeStream();
    await handleVerbosityChatCommand('default', stream as any);
    expect(verbositySetting()).toBe('default');
    expect(stream.markdown.mock.calls[0][0]).toContain('Default');
  });

  it('reports an unknown argument without changing the setting', async () => {
    const stream = fakeStream();
    await handleVerbosityChatCommand('chatty', stream as any);
    expect(verbositySetting()).toBeUndefined();
    expect(stream.markdown.mock.calls[0][0]).toContain('No output mode "chatty"');
  });

  it('with no argument opens the picker and applies the chosen mode', async () => {
    __setQuickPickResponse(1); // the "Default" row (verbose is first)
    const stream = fakeStream();
    await handleVerbosityChatCommand('  ', stream as any);
    expect(verbositySetting()).toBe('default');
    expect(stream.markdown.mock.calls[0][0]).toContain('Default');
  });

  it('with no argument and a dismissed picker writes nothing', async () => {
    __setQuickPickResponse(undefined);
    const stream = fakeStream();
    await handleVerbosityChatCommand('', stream as any);
    expect(verbositySetting()).toBeUndefined();
    expect(stream.markdown).not.toHaveBeenCalled();
  });
});

describe('pickVerbosity', () => {
  it('lists verbose first then default, and applies the pick', async () => {
    __setQuickPickResponse(0); // "Verbose"
    const label = await pickVerbosity();
    expect(label).toBe('Verbose');
    expect(verbositySetting()).toBe('verbose');
    const items = window.showQuickPick.mock.calls[0][0] as Array<{ label: string }>;
    expect(items.map((i) => i.label.replace(' (current)', ''))).toEqual([
      'Verbose',
      'Default',
    ]);
  });

  it('returns undefined for a dismissed picker', async () => {
    __setQuickPickResponse(undefined);
    expect(await pickVerbosity()).toBeUndefined();
    expect(verbositySetting()).toBeUndefined();
  });
});
