import { describe, it, expect, beforeEach } from 'vitest';
import { messages } from '../src/config/messages';
import { defaults, settings } from '../src/config/settings';
import { __reset, __setConfig } from './mocks/vscode';
import {
  capabilityNames,
  loadModels,
  modelRegistry,
  scoreModel,
  selectModel,
} from '../src/engine/config/models';
import { parseFrontmatter } from '../src/engine/config/frontmatter';
import { agents } from '../src/engine/config/agents';
import {
  loadTools,
  toolConfigs,
  toolNames,
  renderToolsSection,
} from '../src/engine/config/tools';
import { clientTools, clientToolNames } from '../src/protocol/toolContract';
import {
  describeEnvironment,
  environment,
  renderEnvironmentSection,
} from '../src/config/environment';

beforeEach(() => {
  __reset();
});

describe('messages templates', () => {
  it('renders the intent block with the intent and reason', () => {
    const block = messages.triage.block('oneshot', 'because');
    expect(block).toContain('**Detected intent:** `oneshot`');
    expect(block).toContain('**Reason:** because');
  });

  it('renders the step error templates from the protocol detail alone', () => {
    // The Ollama hint is no longer baked in: it arrives as the protocol
    // error's `hint`, supplied by the engine (see localEngine.test.ts).
    expect(messages.triage.error('connection refused')).toBe(
      '**Triage error:** connection refused\n\n'
    );
    expect(messages.plan.error('model missing')).toBe(
      '**Planner error:** model missing\n\n'
    );
    expect(messages.answer.error('model missing')).toBe(
      '**Answerer error:** model missing\n\n'
    );
  });

  it('renders the Ollama hint template from the given endpoint and model', () => {
    const hint = messages.ollamaHint('http://gpu-box:11434', 'qwen3:8b');
    expect(hint).toContain('http://gpu-box:11434');
    expect(hint).toContain('`qwen3:8b`');
  });

  it('provides the plan and answer headers as streamable prefixes', () => {
    expect(messages.plan.header).toBe('**Plan:** ');
    expect(messages.answer.header).toBe('**Answer:**\n\n');
  });

  it('provides an approval title and decline reply for the run tool', () => {
    expect(messages.approval.runCommandTitle).toBeTruthy();
    expect(messages.notApproved.run).toMatch(/not.*approved/i);
  });

  it('still reports a cancelled write or edit, the only ungated side effects', () => {
    // write/edit are not gated, but a mid-run stop still cancels them, so the
    // model can note the skip in its report.
    expect(messages.cancelled.write).toMatch(/not changed/i);
    expect(messages.cancelled.edit).toMatch(/not changed/i);
  });

  it('renders the read range header with a continue hint only mid-file', () => {
    expect(messages.read.range(3, 5, 10)).toBe(
      '(lines 3-5 of 10; continue with startLine 6)'
    );
    expect(messages.read.range(9, 10, 10)).toBe('(lines 9-10 of 10)');
  });

  it('phrases every read failure as a recovery instruction for the model', () => {
    expect(messages.readFailed.pastEnd('a.ts', 7, 3)).toContain('only 3 lines');
    expect(messages.readFailed.pastEnd('a.ts', 7, 3)).toContain('startLine 7');
    expect(messages.readFailed.emptyRange(5, 2)).toMatch(/at or after startLine/);
  });

  it('phrases every edit failure as a recovery instruction for the model', () => {
    expect(messages.editFailed.missingFile('a.ts')).toMatch(/write tool/);
    expect(messages.editFailed.notFound('a.ts')).toMatch(/read the file/i);
    expect(messages.editFailed.multipleMatches(3, 'a.ts')).toContain('3');
    expect(messages.editFailed.multipleMatches(3, 'a.ts')).toMatch(/surrounding/);
    expect(messages.editFailed.identical).toMatch(/identical/);
  });

  it('renders the in-chat approval question with the detail fenced', () => {
    const block = messages.approval.block('Run command', '$ ls');
    expect(block).toContain('**Run command?**');
    expect(block).toContain('```\n$ ls\n```');
    expect(messages.approval.approve).toBe('Approve');
    expect(messages.approval.decline).toBe('Decline');
  });

  it('grows the approval fence so a backtick-laden command cannot break out', () => {
    // A command containing a triple-backtick run must be wrapped in a longer
    // fence, or it would close the block early and inject markdown.
    const detail = '$ echo ```pwned```';
    const block = messages.approval.block('Run command', detail);
    expect(block).toContain('````\n' + detail + '\n````');
  });

  it('grows the snippet fence past any backtick run inside the snippet', () => {
    // The snippet baseline is four backticks; a snippet that itself contains a
    // four-backtick run needs five.
    const snippet = 'before\n````\nafter';
    expect(messages.execution.snippet(snippet)).toBe(
      '\n\n`````\n' + snippet + '\n`````'
    );
  });

  it('renders the executor error template from the protocol detail alone', () => {
    expect(messages.execution.error('model missing')).toBe(
      '**Executor error:** model missing\n\n'
    );
  });

  it('renders execution transcript lines as appendable fragments', () => {
    // The renderer streams the transcript append-only: each call line must be
    // self-prefixed (it follows arbitrary text) and each result a pure suffix.
    const call = messages.execution.call('Read File', '{"path":"a.ts"}');
    expect(call).toBe('\n\n**Read File** `{"path":"a.ts"}`');
    expect(messages.execution.result('ok', false)).toBe(' → `ok`');
    expect(messages.execution.result('boom', true)).toBe(' → **failed** `boom`');
    expect(messages.execution.emptyResult).toBeTruthy();
    expect(messages.execution.header).toBe('**Execution:**');
  });

  it('warns about the not-yet-available remote engine by name', () => {
    expect(messages.engine.remoteUnavailable).toContain('myDevTeam.engine');
    expect(messages.engine.remoteUnavailable).toContain('local');
  });
});

describe('settings', () => {
  it('exposes positive operational limits', () => {
    expect(settings.runCommandTimeoutMs).toBeGreaterThan(0);
    expect(settings.maxAttachmentChars).toBeGreaterThan(0);
  });

  it('keeps content-match cap within the scan limit', () => {
    expect(settings.search.contentMaxMatches).toBeLessThanOrEqual(
      settings.search.contentScanLimit
    );
  });

  it('exposes a positive glob result cap', () => {
    expect(settings.search.globMaxResults).toBeGreaterThan(0);
  });

  it('exposes positive conversation-history caps', () => {
    expect(settings.history.maxTurns).toBeGreaterThan(0);
    expect(settings.history.maxTurnChars).toBeGreaterThan(0);
  });

  it('exposes positive executor loop and preview limits', () => {
    expect(settings.executor.maxSteps).toBeGreaterThan(0);
    expect(settings.executor.inputPreviewMaxChars).toBeGreaterThan(0);
    expect(settings.executor.resultPreviewMaxChars).toBeGreaterThan(0);
  });

  it('exposes the tool hardening limits', () => {
    expect(settings.read.maxLines).toBeGreaterThan(0);
    expect(settings.read.maxChars).toBeGreaterThan(0);
    expect(settings.runCommandMaxBufferBytes).toBeGreaterThan(0);
    expect(settings.search.maxFileSizeBytes).toBeGreaterThan(0);
    // The exclude glob replaces VS Code's defaults, so it must at least keep
    // dependency and VCS folders out of scans.
    expect(settings.search.excludeGlob).toContain('node_modules');
    expect(settings.search.excludeGlob).toContain('.git');
  });
});

describe('user-tunable settings (VS Code configuration)', () => {
  it('falls back to the defaults when nothing is configured', () => {
    expect(settings.engine).toBe(defaults.engine);
    expect(settings.ollamaEndpoint).toBe(defaults.ollamaEndpoint);
    expect(settings.runCommandTimeoutMs).toBe(defaults.runCommandTimeoutMs);
    expect(settings.read.maxLines).toBe(defaults.read.maxLines);
    expect(settings.search.globMaxResults).toBe(defaults.search.globMaxResults);
    expect(settings.search.contentScanLimit).toBe(defaults.search.contentScanLimit);
    expect(settings.search.contentMaxMatches).toBe(defaults.search.contentMaxMatches);
    expect(settings.executor.snippetLines).toBe(defaults.chat.toolSnippetLines);
    expect(settings.telemetry.evalLogEnabled).toBe(defaults.telemetry.evalLog);
  });

  it('treats the eval log as opt-in: only the literal true enables it', () => {
    expect(settings.telemetry.evalLogEnabled).toBe(false);
    __setConfig('myDevTeam.telemetry.evalLog', true);
    expect(settings.telemetry.evalLogEnabled).toBe(true);
    __setConfig('myDevTeam.telemetry.evalLog', 'yes');
    expect(settings.telemetry.evalLogEnabled).toBe(false);
    __setConfig('myDevTeam.telemetry.evalLog', 1);
    expect(settings.telemetry.evalLogEnabled).toBe(false);
  });

  it('reads the snippet line count live, accepting 0 to hide snippets', () => {
    __setConfig('myDevTeam.chat.toolSnippetLines', 3);
    expect(settings.executor.snippetLines).toBe(3);
    __setConfig('myDevTeam.chat.toolSnippetLines', 0);
    expect(settings.executor.snippetLines).toBe(0);
    __setConfig('myDevTeam.chat.toolSnippetLines', -1);
    expect(settings.executor.snippetLines).toBe(defaults.chat.toolSnippetLines);
  });

  it('accepts only the literal "remote" for the engine and falls back otherwise', () => {
    __setConfig('myDevTeam.engine', 'remote');
    expect(settings.engine).toBe('remote');
    __setConfig('myDevTeam.engine', 'cloud');
    expect(settings.engine).toBe('local');
    __setConfig('myDevTeam.engine', 42);
    expect(settings.engine).toBe('local');
  });

  it('reads user-configured values live', () => {
    __setConfig('myDevTeam.ollama.endpoint', 'http://gpu-box:11434');
    __setConfig('myDevTeam.run.commandTimeoutMs', 5_000);
    __setConfig('myDevTeam.read.maxLines', 50);
    __setConfig('myDevTeam.search.globMaxResults', 10);
    __setConfig('myDevTeam.search.contentScanLimit', 20);
    __setConfig('myDevTeam.search.contentMaxMatches', 5);

    expect(settings.ollamaEndpoint).toBe('http://gpu-box:11434');
    expect(settings.runCommandTimeoutMs).toBe(5_000);
    expect(settings.read.maxLines).toBe(50);
    expect(settings.search.globMaxResults).toBe(10);
    expect(settings.search.contentScanLimit).toBe(20);
    expect(settings.search.contentMaxMatches).toBe(5);
  });

  it('normalises the endpoint: trims whitespace and trailing slashes', () => {
    __setConfig('myDevTeam.ollama.endpoint', '  http://gpu-box:11434/// ');
    expect(settings.ollamaEndpoint).toBe('http://gpu-box:11434');
  });

  it('rejects a non-http(s) or non-string endpoint and falls back', () => {
    __setConfig('myDevTeam.ollama.endpoint', 'gpu-box:11434');
    expect(settings.ollamaEndpoint).toBe(defaults.ollamaEndpoint);
    __setConfig('myDevTeam.ollama.endpoint', 42);
    expect(settings.ollamaEndpoint).toBe(defaults.ollamaEndpoint);
    __setConfig('myDevTeam.ollama.endpoint', '');
    expect(settings.ollamaEndpoint).toBe(defaults.ollamaEndpoint);
  });

  it('rejects non-positive, non-finite, or non-number limits and falls back', () => {
    __setConfig('myDevTeam.run.commandTimeoutMs', 0);
    __setConfig('myDevTeam.search.globMaxResults', -5);
    __setConfig('myDevTeam.search.contentScanLimit', Number.NaN);
    __setConfig('myDevTeam.search.contentMaxMatches', 'lots');

    expect(settings.runCommandTimeoutMs).toBe(defaults.runCommandTimeoutMs);
    expect(settings.search.globMaxResults).toBe(defaults.search.globMaxResults);
    expect(settings.search.contentScanLimit).toBe(defaults.search.contentScanLimit);
    expect(settings.search.contentMaxMatches).toBe(defaults.search.contentMaxMatches);
  });

  it('floors fractional limits to whole numbers', () => {
    __setConfig('myDevTeam.run.commandTimeoutMs', 1500.9);
    expect(settings.runCommandTimeoutMs).toBe(1500);
  });
});

describe('model registry and selection', () => {
  it('registers models with provider, model name, and at least one capability', () => {
    expect(modelRegistry.length).toBeGreaterThan(0);
    for (const info of modelRegistry) {
      expect(info.id).toBeTruthy();
      expect(info.label).toBeTruthy();
      expect(info.provider).toBeTruthy();
      expect(info.model).toBeTruthy();
      expect(Object.keys(info.capabilities).length).toBeGreaterThan(0);
    }
  });

  it('keeps registry ids unique', () => {
    const ids = modelRegistry.map((info) => info.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('rejects two model files sharing one id', () => {
    const file =
      '---\nid: twin\nlabel: Twin\nprovider: ollama\nmodel: twin:1b\ncapabilities:\n  speed: 1\n---\nnote';
    expect(() => loadModels([file, file])).toThrow(/Duplicate model id "twin"/);
  });

  it('keeps every capability score within [0, 1]', () => {
    for (const info of modelRegistry) {
      for (const score of Object.values(info.capabilities)) {
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(1);
      }
    }
  });

  it('scores a model as the weight-by-score sum, missing capabilities as 0', () => {
    const info = {
      id: 'x',
      provider: 'ollama',
      model: 'x',
      description: '',
      capabilities: { reasoning: 0.5, speed: 1 },
    } as const;
    // 0.8 * 0.5 (reasoning) + 0.2 * 1 (speed) + 1 * 0 (coding, unscored)
    expect(scoreModel(info, { reasoning: 0.8, speed: 0.2, coding: 1 })).toBeCloseTo(0.6);
  });

  it('selects the registered model with the highest weighted score', () => {
    for (const requirements of [
      agents.triage.capabilities,
      agents.planner.capabilities,
      agents.answerer.capabilities,
      agents.executor.capabilities,
    ]) {
      const selected = selectModel(requirements);
      const best = Math.max(
        ...modelRegistry.map((info) => scoreModel(info, requirements))
      );
      expect(scoreModel(selected, requirements)).toBe(best);
    }
  });

  it('routes triage to a faster model than the planner cares about', () => {
    // The point of capability routing: triage (speed-weighted) and planning
    // (reasoning-weighted) should be free to land on different models.
    const triageModel = selectModel(agents.triage.capabilities);
    const plannerModel = selectModel(agents.planner.capabilities);
    expect((triageModel.capabilities.speed ?? 0)).toBeGreaterThanOrEqual(
      plannerModel.capabilities.speed ?? 0
    );
  });

  it('routes the executor to the strongest coding model in the registry', () => {
    // The executor weights coding hardest, so it must land on the registry's
    // code specialist rather than a generalist.
    const executorModel = selectModel(agents.executor.capabilities);
    const bestCoding = Math.max(
      ...modelRegistry.map((info) => info.capabilities.coding ?? 0)
    );
    expect(executorModel.capabilities.coding).toBe(bestCoding);
  });
});

describe('parseFrontmatter', () => {
  it('parses scalar keys and returns the body', () => {
    const { data, body } = parseFrontmatter(
      '---\nid: planner\nname: Planner\n---\n\nThe prompt.\n'
    );
    expect(data).toEqual({ id: 'planner', name: 'Planner' });
    expect(body).toBe('The prompt.\n');
  });

  it('parses booleans and numbers', () => {
    const { data } = parseFrontmatter(
      '---\nsideEffecting: true\nenabled: false\nlimit: 8\n---\nbody'
    );
    expect(data).toEqual({ sideEffecting: true, enabled: false, limit: 8 });
  });

  it('parses block lists', () => {
    const { data } = parseFrontmatter('---\ntools:\n  - read\n  - search\n---\nbody');
    expect(data).toEqual({ tools: ['read', 'search'] });
  });

  it('parses an empty inline list', () => {
    expect(parseFrontmatter('---\ntools: []\n---\nbody').data).toEqual({ tools: [] });
  });

  it('parses a one-level nested map of scalars', () => {
    const { data } = parseFrontmatter(
      '---\ncapabilities:\n  reasoning: 0.8\n  speed: 1\nname: x\n---\nbody'
    );
    expect(data).toEqual({ capabilities: { reasoning: 0.8, speed: 1 }, name: 'x' });
  });

  it('rejects mixing list items and map entries under one key', () => {
    expect(() =>
      parseFrontmatter('---\nthings:\n  - a\n  b: 1\n---\nbody')
    ).toThrow(/Cannot mix/);
    expect(() =>
      parseFrontmatter('---\nthings:\n  b: 1\n  - a\n---\nbody')
    ).toThrow(/Cannot mix/);
  });

  it('treats a file without frontmatter as all body', () => {
    expect(parseFrontmatter('just text')).toEqual({ data: {}, body: 'just text' });
  });

  it('ignores a UTF-8 BOM before the opening fence', () => {
    const { data, body } = parseFrontmatter('\uFEFF---\nid: x\n---\nbody');
    expect(data).toEqual({ id: 'x' });
    expect(body).toBe('body');
  });

  it('throws on a malformed line', () => {
    expect(() => parseFrontmatter('---\nnot yaml at all\n---\nbody')).toThrow(
      /Unsupported frontmatter/
    );
  });
});

describe('environment', () => {
  it('uses PowerShell on Windows, both as exec shell and in the prompt text', () => {
    const win = describeEnvironment('win32');
    expect(win.os).toBe('Windows');
    expect(win.shell).toBe('PowerShell');
    expect(win.execShell).toBe('powershell.exe');
  });

  it('keeps the platform default shell on macOS and Linux', () => {
    expect(describeEnvironment('darwin')).toEqual({
      os: 'macOS',
      shell: 'POSIX sh',
      execShell: undefined,
    });
    expect(describeEnvironment('linux')).toEqual({
      os: 'Linux',
      shell: 'POSIX sh',
      execShell: undefined,
    });
  });

  it('describes the platform the extension host actually runs on', () => {
    expect(environment).toEqual(describeEnvironment(process.platform));
  });

  it('renders a prompt section naming the OS and the shell', () => {
    const section = renderEnvironmentSection(describeEnvironment('win32'));
    expect(section).toContain('Windows');
    expect(section).toContain('PowerShell syntax');
    // Without an argument it must describe the host environment, so the
    // prompts can never claim a platform other than the one commands run on.
    expect(renderEnvironmentSection()).toContain(environment.os);
  });
});

describe('tool configs', () => {
  it('discovers the five workspace tools plus the engine-only progress tool', () => {
    // Order follows the config filenames, so compare as a sorted set.
    expect([...toolNames].sort()).toEqual([
      'edit',
      'progress',
      'read',
      'run',
      'search',
      'write',
    ]);
    // progress is engine-only: the executor carries it, the planner never
    // lists it (plan steps no longer name a tool at all).
    expect(agents.executor.tools).toContain('progress');
    expect(agents.planner.tools).not.toContain('progress');
  });

  it('marks only run as side-effecting; read, search, write, and edit are not', () => {
    // write/edit are not gated - the workspace is git-backed, so their changes
    // are recoverable; only run still asks before acting.
    expect(toolConfigs.read.sideEffecting).toBe(false);
    expect(toolConfigs.search.sideEffecting).toBe(false);
    expect(toolConfigs.write.sideEffecting).toBe(false);
    expect(toolConfigs.edit.sideEffecting).toBe(false);
    expect(toolConfigs.run.sideEffecting).toBe(true);
  });

  it('agrees with the protocol contract on the tool vocabulary', () => {
    // The engine's workspace tool configs (model-facing) and the protocol's
    // client tools (ids, display names, input schemas) describe the same five
    // tools; a tool added on one side only would silently break the other. The
    // engine-only progress tool has no client contract.
    const workspaceTools = toolNames.filter((name) => name !== 'progress');
    expect([...workspaceTools].sort()).toEqual([...clientToolNames].sort());
    expect(clientToolNames).not.toContain('progress');
    for (const name of clientToolNames) {
      expect(clientTools[name].lmToolId).toBe(`devteam__${name}`);
      expect(clientTools[name].displayName).toBeTruthy();
    }
  });

  it('tells the model which OS and shell run commands land in', () => {
    // The placeholders must be substituted, not shipped verbatim, and the
    // description must name the same environment the run tool executes in.
    expect(toolConfigs.run.description).not.toContain('{{');
    expect(toolConfigs.run.description).toContain(environment.os);
    expect(toolConfigs.run.description).toContain(`${environment.shell} syntax`);
  });

  it('names a preview argument matching each tool\'s input schema', () => {
    // The transcript shows this argument's value instead of the args JSON
    // (e.g. just the file name for write); the names must match the input
    // schemas in protocol/toolContract.ts or the preview silently falls
    // back to JSON.
    expect(toolConfigs.read.previewArg).toBe('path');
    expect(toolConfigs.write.previewArg).toBe('path');
    expect(toolConfigs.edit.previewArg).toBe('path');
    expect(toolConfigs.search.previewArg).toBe('query');
    expect(toolConfigs.run.previewArg).toBe('command');
  });

  it('names write\'s and edit\'s snippet arguments; the others have none', () => {
    // The transcript shows this argument's first lines as a fenced snippet
    // under the call line; the name must match the input schema in
    // protocol/toolContract.ts or the snippet silently disappears.
    expect(toolConfigs.write.snippetArg).toBe('contents');
    expect(toolConfigs.edit.snippetArg).toBe('newText');
    expect(toolConfigs.read.snippetArg).toBeUndefined();
    expect(toolConfigs.search.snippetArg).toBeUndefined();
    expect(toolConfigs.run.snippetArg).toBeUndefined();
  });

  it('renders a tools section with one line per tool', () => {
    const section = renderToolsSection(['read', 'run']);
    expect(section).toContain('You have exactly 2 tools available:');
    expect(section).toContain('- "read": Read the text of one workspace file');
    expect(section).toContain('Requires user approval.');
  });

  it('does not flag the write tool as needing approval', () => {
    // write is not gated, so its rendered description must not claim approval -
    // that would mislead the model into treating a write as a user decision.
    const section = renderToolsSection(['write']);
    expect(section).toContain('- "write": Create or overwrite a file.');
    expect(section).not.toContain('Requires user approval.');
  });

  it('rejects an unknown tool name', () => {
    expect(() => renderToolsSection(['delete'])).toThrow(/Unknown tool "delete"/);
  });

  it('rejects two tool files sharing one name', () => {
    const file = '---\nname: twin\nsideEffecting: false\n---\ndesc';
    expect(() => loadTools([file, file])).toThrow(/Duplicate tool name "twin"/);
  });
});

describe('agent configs', () => {
  it('loads frontmatter fields and non-empty instructions for each agent', () => {
    expect(agents.triage.id).toBe('triage');
    expect(agents.triage.name).toBe('Triage');
    expect(agents.triage.description).toBeTruthy();
    expect(agents.planner.id).toBe('planner');
    expect(agents.planner.name).toBe('Planner');
    expect(agents.planner.description).toBeTruthy();
    expect(agents.answerer.id).toBe('answerer');
    expect(agents.answerer.name).toBe('Answerer');
    expect(agents.answerer.description).toBeTruthy();
    expect(agents.executor.id).toBe('executor');
    expect(agents.executor.name).toBe('Executor');
    expect(agents.executor.description).toBeTruthy();
    expect(agents.triage.instructions).toContain('triage agent');
    expect(agents.planner.instructions).toContain('planner');
    expect(agents.answerer.instructions).toContain('answerer');
    expect(agents.executor.instructions).toContain('executor');
  });

  it('declares only known capabilities with weights in [0, 1] for each agent', () => {
    for (const agent of Object.values(agents)) {
      const entries = Object.entries(agent.capabilities);
      expect(entries.length).toBeGreaterThan(0);
      for (const [capability, weight] of entries) {
        expect(capabilityNames).toContain(capability);
        expect(weight).toBeGreaterThanOrEqual(0);
        expect(weight).toBeLessThanOrEqual(1);
      }
    }
  });

  it('weights triage toward fast classification and the planner toward planning', () => {
    expect(agents.triage.capabilities.classification).toBe(1);
    expect(agents.planner.capabilities.planning).toBe(1);
  });

  it('weights the answerer toward reasoning with speed close behind', () => {
    expect(agents.answerer.capabilities.reasoning).toBe(1);
    expect(agents.answerer.capabilities.speed).toBeGreaterThan(0);
  });

  it('weights the executor toward coding', () => {
    expect(agents.executor.capabilities.coding).toBe(1);
  });

  it('keeps the executor contract: all tools, decline handling, a report', () => {
    // The executor carries every tool, including the engine-only progress tool.
    expect([...agents.executor.tools].sort()).toEqual([...toolNames].sort());
    const p = agents.executor.instructions;
    expect(p).not.toContain('{{tools}}');
    expect(p).toContain('You have exactly 6 tools available:');
    expect(p).toContain('not approved');
    expect(p).toMatch(/report/i);
    // It is told to print a progress checklist from time to time.
    expect(p).toContain('"progress"');
    expect(p).toMatch(/from time to time/i);
  });

  it('tells the run-capable agents which OS and shell they work on', () => {
    // Both agents that plan or issue run commands carry the environment
    // section; without it a model defaults to Linux commands on Windows.
    for (const agent of [agents.planner, agents.executor]) {
      expect(agent.instructions).not.toContain('{{environment}}');
      expect(agent.instructions).toContain(renderEnvironmentSection());
    }
    // Agents without tools have no placeholder and gain no section.
    expect(agents.triage.instructions).not.toContain('Environment:');
    expect(agents.answerer.instructions).not.toContain('Environment:');
  });

  it('explains the project-instructions section to the working agents', () => {
    // The workflow may prepend a "--- Project instructions ---" section (the
    // workspace's AGENTS.md/CLAUDE.md); the agents that act on the request
    // must know to treat it as standing rules. Triage never receives it.
    for (const agent of [agents.planner, agents.answerer, agents.executor]) {
      expect(agent.instructions).toContain('--- Project instructions ---');
      expect(agent.instructions).toMatch(/AGENTS\.md or CLAUDE\.md/);
    }
    expect(agents.triage.instructions).not.toContain('Project instructions');
  });

  it('keeps the answerer contract: no tools, oneshot framing', () => {
    expect(agents.answerer.tools).toEqual([]);
    const p = agents.answerer.instructions;
    expect(p).toContain('"oneshot"');
    expect(p).not.toContain('tools available');
    // The escape hatch for residual misroutes: the answerer must state it
    // cannot write files and point the user at rephrasing, not silently
    // pretend fenced code in chat fulfilled a file-creation request.
    expect(p).toContain('cannot create or modify files');
    expect(p).toMatch(/rephras/i);
  });

  // The prose lives in standalone .md files, so these lock the structural
  // contract each agent depends on — an accidental edit that drops a routing
  // category or a tool would fail here rather than silently degrade routing.
  it('keeps the triage contract: no tools, both routing categories, JSON output', () => {
    expect(agents.triage.tools).toEqual([]);
    const p = agents.triage.instructions;
    expect(p).toContain('"oneshot"');
    expect(p).toContain('"planning"');
    expect(p).not.toContain('tools available');
    expect(p).toMatch(/JSON object/i);
  });

  it('keeps triage routing any file-changing request to planning, however small', () => {
    const p = agents.triage.instructions;
    // The boundary is the deliverable: a created/changed file means planning.
    expect(p).toMatch(/create or change a file/);
    expect(p).toMatch(/even if/);
    // A trivial new-script request is an explicit planning example: without
    // it a small model reads "needs no exploration" as oneshot and the user
    // gets fenced code in chat instead of a written file.
    expect(p).toContain('create a python script');
  });

  it('keeps the planner contract: the five workspace tools, the step cap, and JSON output', () => {
    // The planner is grounded in the workspace tools (so it plans only doable
    // work); the engine-only progress tool is never offered to it.
    expect([...agents.planner.tools].sort()).toEqual([
      'edit',
      'read',
      'run',
      'search',
      'write',
    ]);
    expect(agents.planner.tools).not.toContain('progress');
    const p = agents.planner.instructions;
    expect(p).toContain('never more than 8');
    expect(p).toMatch(/JSON object/i);
  });

  it('keeps the planner describing steps, not authoring code', () => {
    // Code generation belongs to the executor (the routed coding specialist);
    // a plan step that inlines code wastes the routing, bloats the structured
    // output, and crowds the executor's context. The ban is total: the old
    // "short fragment" allowance was stretched into whole programs.
    const p = agents.planner.instructions;
    expect(p).toMatch(/Never write code in\s+the plan/);
    expect(p).toMatch(/executor writes the code/);
    expect(p).toMatch(/no snippets of\s+any length/);
    expect(p).not.toMatch(/fragment of a few lines/);
  });

  it('renders the tools section into the planner prompt at the placeholder', () => {
    const p = agents.planner.instructions;
    expect(p).not.toContain('{{tools}}');
    expect(p).toContain('You have exactly 5 tools available:');
    for (const name of agents.planner.tools) {
      expect(p).toContain(`- "${name}": ${toolConfigs[name].description}`);
    }
    // The engine-only progress tool is never advertised to the planner.
    expect(p).not.toContain(`- "progress":`);
    // The placeholder position is honoured: tools come before the rules.
    expect(p.indexOf('tools available')).toBeLessThan(p.indexOf('Rules:'));
  });
});
