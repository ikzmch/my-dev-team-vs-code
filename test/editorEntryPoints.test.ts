import { describe, it, expect, beforeEach } from 'vitest';
import {
  __reset,
  __setActiveEditor,
  __setDiagnostics,
  CodeActionKind,
  commands,
  DiagnosticSeverity,
  Position,
  Range,
  Uri,
} from './mocks/vscode';
import {
  buildChatQuery,
  EXPLAIN_SELECTION_COMMAND_ID,
  FIX_DIAGNOSTIC_COMMAND_ID,
  FixCodeActionProvider,
  registerEditorEntryPoints,
  TestCodeLensProvider,
  WRITE_OR_REPAIR_TESTS_COMMAND_ID,
} from '../src/ui/editorEntryPoints';

const CHAT_OPEN = 'workbench.action.chat.open';

beforeEach(() => {
  __reset();
});

/** Capture every query passed to the built-in chat-open command. */
function stubChatOpen(): { query: string }[] {
  const calls: { query: string }[] = [];
  commands.registerCommand(CHAT_OPEN, (opts: unknown) => {
    calls.push(opts as { query: string });
  });
  return calls;
}

function fakeContext() {
  return { subscriptions: [] as unknown[] };
}

const anyRange = new Range(new Position(0, 0), new Position(0, 0));

describe('buildChatQuery', () => {
  it('mentions the participant and pins the slash command', () => {
    expect(buildChatQuery('fix', 'do the thing')).toBe('@devteam /fix do the thing');
    expect(buildChatQuery('explain', 'this')).toBe('@devteam /explain this');
  });
});

describe('FixCodeActionProvider', () => {
  const provider = new FixCodeActionProvider();
  const doc = { uri: Uri.file('/ws/src/a.ts') } as any;

  it('offers nothing when the position is not on a diagnostic', () => {
    expect(provider.provideCodeActions(doc, anyRange, { diagnostics: [] } as any)).toEqual([]);
  });

  it('offers a "Fix with Dev Team" quick fix carrying the problems', () => {
    const diagnostic = {
      message: 'x is not defined',
      range: new Range(new Position(4, 2), new Position(4, 12)),
      severity: DiagnosticSeverity.Error,
    };
    const actions = provider.provideCodeActions(doc, anyRange, {
      diagnostics: [diagnostic],
    } as any);

    expect(actions).toHaveLength(1);
    expect(actions[0].title).toBe('Fix with Dev Team');
    expect(actions[0].kind).toBe(CodeActionKind.QuickFix);
    expect(actions[0].diagnostics).toEqual([diagnostic]);
    expect(actions[0].command?.command).toBe(FIX_DIAGNOSTIC_COMMAND_ID);
    // The line is 1-based in the problem text (range.start.line is 0-based 4).
    expect(actions[0].command?.arguments).toEqual([
      doc.uri,
      ['line 5: x is not defined'],
    ]);
  });
});

describe('fix command', () => {
  it('opens /fix with #changes and the problems described', async () => {
    registerEditorEntryPoints(fakeContext() as any);
    const calls = stubChatOpen();

    await commands.executeCommand(FIX_DIAGNOSTIC_COMMAND_ID, Uri.file('/ws/src/a.ts'), [
      'line 5: x is not defined',
    ]);

    expect(calls).toHaveLength(1);
    expect(calls[0].query).toContain('@devteam /fix');
    expect(calls[0].query).toContain('#changes');
    expect(calls[0].query).toContain('src/a.ts');
    expect(calls[0].query).toContain('line 5: x is not defined');
  });
});

describe('explain command', () => {
  it('opens /explain with the selected code and its line range inline', async () => {
    const uri = Uri.file('/ws/src/a.ts');
    __setActiveEditor({
      selection: { isEmpty: false, start: { line: 2 }, end: { line: 4 } },
      document: { uri, getText: () => 'const x = 1;' },
    });
    registerEditorEntryPoints(fakeContext() as any);
    const calls = stubChatOpen();

    await commands.executeCommand(EXPLAIN_SELECTION_COMMAND_ID);

    expect(calls).toHaveLength(1);
    expect(calls[0].query).toContain('@devteam /explain');
    expect(calls[0].query).toContain('src/a.ts (lines 3-5)');
    expect(calls[0].query).toContain('const x = 1;');
  });

  it('does nothing (no chat) when there is no selection', async () => {
    __setActiveEditor({
      selection: { isEmpty: true },
      document: { uri: Uri.file('/ws/src/a.ts'), getText: () => '' },
    });
    registerEditorEntryPoints(fakeContext() as any);
    const calls = stubChatOpen();

    await commands.executeCommand(EXPLAIN_SELECTION_COMMAND_ID);

    expect(calls).toHaveLength(0);
  });

  it('does nothing when there is no active editor', async () => {
    __setActiveEditor(undefined);
    registerEditorEntryPoints(fakeContext() as any);
    const calls = stubChatOpen();

    await commands.executeCommand(EXPLAIN_SELECTION_COMMAND_ID);

    expect(calls).toHaveLength(0);
  });
});

describe('TestCodeLensProvider', () => {
  const provider = new TestCodeLensProvider();
  const lensFor = (path: string) => provider.provideCodeLenses({ uri: Uri.file(path) } as any);

  it('offers no lens on a non-test file', () => {
    expect(lensFor('/ws/src/a.ts')).toEqual([]);
  });

  it.each([
    '/ws/src/a.test.ts',
    '/ws/src/a.spec.js',
    '/ws/pkg/a_test.go',
    '/ws/app/test_a.py',
    '/ws/test/a.py',
    '/ws/__tests__/a.js',
  ])('recognises %s as a test file', (path) => {
    const lenses = lensFor(path);
    expect(lenses).toHaveLength(1);
  });

  it('offers a write/update lens when the file has no failing diagnostics', () => {
    const lenses = lensFor('/ws/src/a.test.ts');
    expect(lenses[0].command?.title).toContain('Write/update tests');
    expect(lenses[0].command?.command).toBe(WRITE_OR_REPAIR_TESTS_COMMAND_ID);
    expect((lenses[0].command?.arguments as unknown[])[1]).toBe(false);
  });

  it('offers a repair lens when the file has an error diagnostic', () => {
    const uri = Uri.file('/ws/src/a.test.ts');
    __setDiagnostics(uri, [{ severity: DiagnosticSeverity.Error }]);
    const lenses = provider.provideCodeLenses({ uri } as any);
    expect(lenses[0].command?.title).toContain('Repair tests');
    expect((lenses[0].command?.arguments as unknown[])[1]).toBe(true);
  });

  it('treats a warning-only file as write/update, not repair', () => {
    const uri = Uri.file('/ws/src/a.test.ts');
    __setDiagnostics(uri, [{ severity: DiagnosticSeverity.Warning }]);
    const lenses = provider.provideCodeLenses({ uri } as any);
    expect(lenses[0].command?.title).toContain('Write/update tests');
  });
});

describe('write/repair tests command', () => {
  it('opens /test framed for repair when failing', async () => {
    registerEditorEntryPoints(fakeContext() as any);
    const calls = stubChatOpen();

    await commands.executeCommand(
      WRITE_OR_REPAIR_TESTS_COMMAND_ID,
      Uri.file('/ws/src/a.test.ts'),
      true
    );

    expect(calls[0].query).toContain('@devteam /test');
    expect(calls[0].query).toContain('src/a.test.ts');
    expect(calls[0].query).toContain('failing');
  });

  it('opens /test framed to write/update when not failing', async () => {
    registerEditorEntryPoints(fakeContext() as any);
    const calls = stubChatOpen();

    await commands.executeCommand(
      WRITE_OR_REPAIR_TESTS_COMMAND_ID,
      Uri.file('/ws/src/a.test.ts'),
      false
    );

    expect(calls[0].query).toContain('@devteam /test');
    expect(calls[0].query).toContain('Write or update the tests');
  });
});
