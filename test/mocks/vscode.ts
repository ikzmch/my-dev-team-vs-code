/**
 * In-memory fake of the slice of the VS Code extension API that the source
 * touches. Vitest aliases the real `vscode` module to this file (see
 * vitest.config.ts) so the extension's logic can run in plain Node.
 *
 * State lives in `__state`; call `__reset()` in a beforeEach to get a clean
 * workspace between tests. The classes are real so the production code's
 * `instanceof` checks behave correctly.
 */
import { vi } from 'vitest';

// --- Value types (real classes so `instanceof` works in the source) ---

export class Uri {
  private constructor(
    public readonly fsPath: string,
    public readonly path: string
  ) {}

  static file(p: string): Uri {
    return new Uri(p, p);
  }

  static joinPath(base: Uri, ...segments: string[]): Uri {
    const joined = [base.path.replace(/\/+$/, ''), ...segments].join('/');
    return new Uri(joined, joined);
  }

  toString(): string {
    return this.path;
  }
}

export class Position {
  constructor(public readonly line: number, public readonly character: number) {}
}

export class Range {
  constructor(public readonly start: Position, public readonly end: Position) {}
}

export class Location {
  constructor(public readonly uri: Uri, public readonly range: Range) {}
}

export class LanguageModelTextPart {
  constructor(public readonly value: string) {}
}

export class LanguageModelToolResult {
  constructor(public readonly content: unknown[]) {}
}

export class ChatRequestTurn {
  constructor(public readonly prompt: string, public readonly command?: string) {}
}

export class ChatResponseMarkdownPart {
  // Mirrors the real shape: `.value` is a MarkdownString with its own `.value`.
  public readonly value: { value: string };
  constructor(text: string) {
    this.value = { value: text };
  }
}

export class ChatResponseTurn {
  constructor(public readonly response: unknown[]) {}
}

export enum ChatResultFeedbackKind {
  Unhelpful = 0,
  Helpful = 1,
}

// --- Mutable test state ---

interface MockState {
  files: Map<string, string>;
  workspaceFolders: Array<{ uri: Uri }> | undefined;
  findFilesResult: Uri[];
  warningResponse: string | undefined;
  registeredTools: Map<string, unknown>;
}

export const __state: MockState = {
  files: new Map(),
  workspaceFolders: [{ uri: Uri.file('/ws') }],
  findFilesResult: [],
  warningResponse: undefined,
  registeredTools: new Map(),
};

export function __reset(): void {
  __state.files = new Map();
  __state.workspaceFolders = [{ uri: Uri.file('/ws') }];
  __state.findFilesResult = [];
  __state.warningResponse = undefined;
  __state.registeredTools = new Map();
}

/** Seed a file into the fake fs under the workspace root. */
export function __setFile(relPath: string, contents: string): Uri {
  const uri = Uri.joinPath(__state.workspaceFolders![0].uri, relPath);
  __state.files.set(uri.path, contents);
  return uri;
}

// --- API surface ---

export const workspace = {
  get workspaceFolders() {
    return __state.workspaceFolders;
  },

  fs: {
    readFile: vi.fn(async (uri: Uri): Promise<Uint8Array> => {
      if (!__state.files.has(uri.path)) {
        throw new Error(`ENOENT: ${uri.path}`);
      }
      return new TextEncoder().encode(__state.files.get(uri.path)!);
    }),

    writeFile: vi.fn(async (uri: Uri, bytes: Uint8Array): Promise<void> => {
      __state.files.set(uri.path, new TextDecoder().decode(bytes));
    }),
  },

  findFiles: vi.fn(
    async (_glob: string, _exclude?: string, _max?: number): Promise<Uri[]> =>
      __state.findFilesResult
  ),

  asRelativePath: vi.fn((uri: Uri): string => {
    const base = __state.workspaceFolders?.[0]?.uri.path;
    if (base && uri.path.startsWith(base + '/')) {
      return uri.path.slice(base.length + 1);
    }
    return uri.path;
  }),

  openTextDocument: vi.fn(async (uri: Uri) => ({
    getText: (range?: Range): string => {
      const full = __state.files.get(uri.path) ?? '';
      if (!range) {
        return full;
      }
      const lines = full.split('\n');
      return lines
        .slice(range.start.line, range.end.line + 1)
        .join('\n');
    },
  })),
};

export const window = {
  showWarningMessage: vi.fn(
    async (..._args: unknown[]): Promise<string | undefined> =>
      __state.warningResponse
  ),
};

export const lm = {
  registerTool: vi.fn((name: string, impl: unknown) => {
    __state.registeredTools.set(name, impl);
    return { dispose: vi.fn() };
  }),
};

export const chat = {
  createChatParticipant: vi.fn((_id: string, _handler: unknown) => ({
    followupProvider: undefined as unknown,
    onDidReceiveFeedback: vi.fn(),
    dispose: vi.fn(),
  })),
};
