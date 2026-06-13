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
  constructor(
    public readonly prompt: string,
    public readonly command?: string,
    public readonly participant: string = 'myDevTeam.agent'
  ) {}
}

export class ChatResponseMarkdownPart {
  // Mirrors the real shape: `.value` is a MarkdownString with its own `.value`.
  public readonly value: { value: string };
  constructor(text: string) {
    this.value = { value: text };
  }
}

export class ChatResponseTurn {
  // Mirrors the real shape: `result` is the ChatResult the handler returned
  // for this turn, whose metadata pairs feedback (and the /compact history
  // rule) with the run that produced it.
  constructor(
    public readonly response: unknown[],
    public readonly participant: string = 'myDevTeam.agent',
    public readonly result: { metadata?: unknown } = {}
  ) {}
}

export enum ChatResultFeedbackKind {
  Unhelpful = 0,
  Helpful = 1,
}

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

export enum ConfigurationTarget {
  Global = 1,
  Workspace = 2,
  WorkspaceFolder = 3,
}

/** Mirrors vscode.FileType: a bitmask, with SymbolicLink OR'd onto the base type. */
export enum FileType {
  Unknown = 0,
  File = 1,
  Directory = 2,
  SymbolicLink = 64,
}

export class EventEmitter<T> {
  private listeners: Array<(e: T) => void> = [];

  event = (listener: (e: T) => void) => {
    this.listeners.push(listener);
    return {
      dispose: () => {
        this.listeners = this.listeners.filter((l) => l !== listener);
      },
    };
  };

  fire(e: T): void {
    for (const listener of [...this.listeners]) {
      listener(e);
    }
  }

  dispose(): void {
    this.listeners = [];
  }
}

/** Fake of a terminal created via window.createTerminal. */
export interface FakeTerminal {
  name: string;
  /** The options the terminal was created with (pty access for tests). */
  creationOptions: { name: string; pty?: any };
  dispose: ReturnType<typeof vi.fn>;
  show: ReturnType<typeof vi.fn>;
}

// --- Mutable test state ---

interface MockState {
  files: Map<string, string>;
  /** Paths (by `uri.path`) that fs.stat should report as symbolic links. */
  symlinks: Set<string>;
  workspaceFolders: Array<{ uri: Uri }> | undefined;
  findFilesResult: Uri[];
  warningResponse: string | undefined;
  registeredTools: Map<string, unknown>;
  registeredCommands: Map<string, (...args: unknown[]) => unknown>;
  /** User settings by `<section>.<key>` (e.g. "myDevTeam.ollama.endpoint"). */
  configuration: Map<string, unknown>;
  /** Listeners registered via workspace.onDidChangeConfiguration. */
  configChangeListeners: Array<(e: unknown) => void>;
  /** Terminals created via window.createTerminal, in creation order. */
  terminals: FakeTerminal[];
  terminalCloseListeners: Array<(t: FakeTerminal) => void>;
  /** Status-bar items created via window.createStatusBarItem. */
  statusBarItems: FakeStatusBarItem[];
  /** What window.showQuickPick returns next (an index into items, or undefined). */
  quickPickResponse: number | undefined;
  /** What window.showInputBox returns next. */
  inputBoxResponse: string | undefined;
  /** SecretStorage values by key. */
  secrets: Map<string, string>;
}

export const __state: MockState = {
  files: new Map(),
  symlinks: new Set(),
  workspaceFolders: [{ uri: Uri.file('/ws') }],
  findFilesResult: [],
  warningResponse: undefined,
  registeredTools: new Map(),
  registeredCommands: new Map(),
  configuration: new Map(),
  configChangeListeners: [],
  terminals: [],
  terminalCloseListeners: [],
  statusBarItems: [],
  quickPickResponse: undefined,
  inputBoxResponse: undefined,
  secrets: new Map(),
};

export function __reset(): void {
  __state.files = new Map();
  __state.symlinks = new Set();
  __state.workspaceFolders = [{ uri: Uri.file('/ws') }];
  __state.findFilesResult = [];
  __state.warningResponse = undefined;
  __state.registeredTools = new Map();
  __state.registeredCommands = new Map();
  __state.configuration = new Map();
  __state.configChangeListeners = [];
  __state.terminals = [];
  __state.terminalCloseListeners = [];
  __state.statusBarItems = [];
  __state.quickPickResponse = undefined;
  __state.inputBoxResponse = undefined;
  __state.secrets = new Map();
}

/** Choose which quick-pick item index showQuickPick returns next. */
export function __setQuickPickResponse(index: number | undefined): void {
  __state.quickPickResponse = index;
}

/** Set what showInputBox returns next. */
export function __setInputBoxResponse(value: string | undefined): void {
  __state.inputBoxResponse = value;
}

/** A fake SecretStorage backed by __state.secrets, for context.secrets in tests. */
export const secrets = {
  get: vi.fn(async (key: string): Promise<string | undefined> => __state.secrets.get(key)),
  store: vi.fn(async (key: string, value: string): Promise<void> => {
    __state.secrets.set(key, value);
  }),
  delete: vi.fn(async (key: string): Promise<void> => {
    __state.secrets.delete(key);
  }),
};

export interface FakeStatusBarItem {
  text: string;
  tooltip: string | undefined;
  command: string | undefined;
  show: ReturnType<typeof vi.fn>;
  hide: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
}

/** Simulate the user closing a terminal tab. */
export function __closeTerminal(terminal: FakeTerminal): void {
  for (const listener of [...__state.terminalCloseListeners]) {
    listener(terminal);
  }
}

/** Seed a user setting, e.g. __setConfig('myDevTeam.ollama.endpoint', url). */
export function __setConfig(fullKey: string, value: unknown): void {
  __state.configuration.set(fullKey, value);
}

/** Seed a file into the fake fs under the workspace root. */
export function __setFile(relPath: string, contents: string): Uri {
  const uri = Uri.joinPath(__state.workspaceFolders![0].uri, relPath);
  __state.files.set(uri.path, contents);
  return uri;
}

/**
 * Seed a path that fs.stat reports as a symbolic link (it still has readable
 * bytes, standing in for a link whose target is outside the workspace).
 */
export function __setSymlink(relPath: string, contents = ''): Uri {
  const uri = __setFile(relPath, contents);
  __state.symlinks.add(uri.path);
  return uri;
}

/**
 * Seed a directory path that fs.stat reports as a symbolic link, standing in
 * for a symlinked directory whose target is outside the workspace. Files
 * "inside" it are seeded separately with __setFile.
 */
export function __setSymlinkDir(relPath: string): Uri {
  const uri = Uri.joinPath(__state.workspaceFolders![0].uri, relPath);
  __state.symlinks.add(uri.path);
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

    createDirectory: vi.fn(async (_uri: Uri): Promise<void> => {
      // Directories are implicit in the flat file map.
    }),

    stat: vi.fn(async (uri: Uri): Promise<{ type: number; size: number }> => {
      if (!__state.files.has(uri.path)) {
        // A symlink seeded without bytes stands in for a symlinked directory.
        if (__state.symlinks.has(uri.path)) {
          return { type: FileType.Directory | FileType.SymbolicLink, size: 0 };
        }
        throw new Error(`ENOENT: ${uri.path}`);
      }
      const size = new TextEncoder().encode(__state.files.get(uri.path)!).length;
      const type = __state.symlinks.has(uri.path)
        ? FileType.File | FileType.SymbolicLink
        : FileType.File;
      return { type, size };
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

  getConfiguration: vi.fn((section?: string) => ({
    get: <T>(key: string, fallback?: T): T | undefined => {
      const fullKey = section ? `${section}.${key}` : key;
      return __state.configuration.has(fullKey)
        ? (__state.configuration.get(fullKey) as T)
        : fallback;
    },
    update: async (key: string, value: unknown): Promise<void> => {
      __state.configuration.set(section ? `${section}.${key}` : key, value);
    },
  })),

  onDidChangeConfiguration: vi.fn((listener: (e: unknown) => void) => {
    __state.configChangeListeners.push(listener);
    return {
      dispose: () => {
        __state.configChangeListeners = __state.configChangeListeners.filter(
          (l) => l !== listener
        );
      },
    };
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

  createTerminal: vi.fn((options: { name: string; pty?: unknown }): FakeTerminal => {
    const terminal: FakeTerminal = {
      name: options.name,
      creationOptions: options as FakeTerminal['creationOptions'],
      dispose: vi.fn(),
      show: vi.fn(),
    };
    __state.terminals.push(terminal);
    return terminal;
  }),

  onDidCloseTerminal: vi.fn((listener: (t: FakeTerminal) => void) => {
    __state.terminalCloseListeners.push(listener);
    return {
      dispose: () => {
        __state.terminalCloseListeners = __state.terminalCloseListeners.filter(
          (l) => l !== listener
        );
      },
    };
  }),

  showInformationMessage: vi.fn(async (..._args: unknown[]): Promise<undefined> => undefined),

  createStatusBarItem: vi.fn((..._args: unknown[]): FakeStatusBarItem => {
    const item: FakeStatusBarItem = {
      text: '',
      tooltip: undefined,
      command: undefined,
      show: vi.fn(),
      hide: vi.fn(),
      dispose: vi.fn(),
    };
    __state.statusBarItems.push(item);
    return item;
  }),

  // Returns the item at __state.quickPickResponse (set via __setQuickPickResponse).
  showQuickPick: vi.fn(async (items: unknown): Promise<unknown> => {
    const resolved = await items;
    const list = resolved as unknown[];
    const index = __state.quickPickResponse;
    return index === undefined ? undefined : list[index];
  }),

  showInputBox: vi.fn(
    async (..._args: unknown[]): Promise<string | undefined> => __state.inputBoxResponse
  ),
};

export const commands = {
  registerCommand: vi.fn((id: string, fn: (...args: unknown[]) => unknown) => {
    __state.registeredCommands.set(id, fn);
    return { dispose: vi.fn() };
  }),

  executeCommand: vi.fn(async (id: string, ...args: unknown[]) => {
    const fn = __state.registeredCommands.get(id);
    if (!fn) {
      throw new Error(`command '${id}' not found`);
    }
    return fn(...args);
  }),
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
