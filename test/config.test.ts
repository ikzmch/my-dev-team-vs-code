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
} from '../src/config/models';
import { parseFrontmatter } from '../src/config/frontmatter';
import { agents } from '../src/config/agents';
import {
  loadTools,
  toolConfigs,
  toolNames,
  renderToolsSection,
} from '../src/config/tools';
import {
  describeEnvironment,
  environment,
  renderEnvironmentSection,
} from '../src/config/environment';
import { PlanStepSchema } from '../src/core/planner';

beforeEach(() => {
  __reset();
});

describe('messages templates', () => {
  it('renders the intent block with the intent and reason', () => {
    const block = messages.triage.block('oneshot', 'because');
    expect(block).toContain('**Detected intent:** `oneshot`');
    expect(block).toContain('**Reason:** because');
  });

  it('appends the Ollama troubleshooting hint to triage errors', () => {
    const text = messages.triage.error('connection refused');
    expect(text).toContain('**Triage error:** connection refused');
    expect(text).toContain(settings.ollamaEndpoint);
    expect(text).toContain(selectModel(agents.triage.capabilities).model);
  });

  it('appends the Ollama troubleshooting hint to planner errors', () => {
    const text = messages.plan.error('model missing');
    expect(text).toContain('**Planner error:** model missing');
    expect(text).toContain(settings.ollamaEndpoint);
  });

  it('appends the Ollama troubleshooting hint to answerer errors', () => {
    const text = messages.answer.error('model missing');
    expect(text).toContain('**Answerer error:** model missing');
    expect(text).toContain(settings.ollamaEndpoint);
    expect(text).toContain(selectModel(agents.answerer.capabilities).model);
  });

  it('derives the hint endpoint from the user setting, not a constant', () => {
    __setConfig('myDevTeam.ollama.endpoint', 'http://gpu-box:11434');
    expect(messages.triage.error('x')).toContain('http://gpu-box:11434');
    expect(messages.plan.error('x')).toContain('http://gpu-box:11434');
  });

  it('provides the plan and answer headers as streamable prefixes', () => {
    expect(messages.plan.header).toBe('**Plan:** ');
    expect(messages.answer.header).toBe('**Answer:**\n\n');
  });

  it('provides an approval title and decline reply for the run tool', () => {
    expect(messages.approval.runCommandTitle).toBeTruthy();
    expect(messages.notApproved.run).toMatch(/not.*approved/i);
  });

  it('renders the in-chat approval question with the detail fenced', () => {
    const block = messages.approval.block('Run command', '$ ls');
    expect(block).toContain('**Run command?**');
    expect(block).toContain('```\n$ ls\n```');
    expect(messages.approval.approve).toBe('Approve');
    expect(messages.approval.decline).toBe('Decline');
  });

  it('appends the Ollama troubleshooting hint to executor errors', () => {
    const text = messages.execution.error('model missing');
    expect(text).toContain('**Executor error:** model missing');
    expect(text).toContain(settings.ollamaEndpoint);
    expect(text).toContain(selectModel(agents.executor.capabilities).model);
  });

  it('renders execution transcript lines as appendable fragments', () => {
    // The renderer streams the transcript append-only: each call line must be
    // self-prefixed (it follows arbitrary text) and each result a pure suffix.
    const call = messages.execution.call('read', '{"path":"a.ts"}');
    expect(call).toBe('\n\n- **read** `{"path":"a.ts"}`');
    expect(messages.execution.result('ok', false)).toBe(' → `ok`');
    expect(messages.execution.result('boom', true)).toBe(' → **failed** `boom`');
    expect(messages.execution.emptyResult).toBeTruthy();
    expect(messages.execution.header).toBe('**Execution:**');
  });

  it('keeps the Ollama hint sourced from the router, not a hardcoded id', () => {
    // The hint must name whatever model the router selects for the failing
    // agent, so the troubleshooting text can never drift from the model in use.
    expect(messages.triage.error('x')).toContain(
      selectModel(agents.triage.capabilities).model
    );
    expect(messages.plan.error('x')).toContain(
      selectModel(agents.planner.capabilities).model
    );
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

  it('exposes positive executor loop and preview limits', () => {
    expect(settings.executor.maxSteps).toBeGreaterThan(0);
    expect(settings.executor.inputPreviewMaxChars).toBeGreaterThan(0);
    expect(settings.executor.resultPreviewMaxChars).toBeGreaterThan(0);
  });

  it('exposes the tool hardening limits', () => {
    expect(settings.readMaxChars).toBeGreaterThan(0);
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
    expect(settings.ollamaEndpoint).toBe(defaults.ollamaEndpoint);
    expect(settings.runCommandTimeoutMs).toBe(defaults.runCommandTimeoutMs);
    expect(settings.search.globMaxResults).toBe(defaults.search.globMaxResults);
    expect(settings.search.contentScanLimit).toBe(defaults.search.contentScanLimit);
    expect(settings.search.contentMaxMatches).toBe(defaults.search.contentMaxMatches);
    expect(settings.executor.snippetLines).toBe(defaults.chat.toolSnippetLines);
  });

  it('reads the snippet line count live, accepting 0 to hide snippets', () => {
    __setConfig('myDevTeam.chat.toolSnippetLines', 3);
    expect(settings.executor.snippetLines).toBe(3);
    __setConfig('myDevTeam.chat.toolSnippetLines', 0);
    expect(settings.executor.snippetLines).toBe(0);
    __setConfig('myDevTeam.chat.toolSnippetLines', -1);
    expect(settings.executor.snippetLines).toBe(defaults.chat.toolSnippetLines);
  });

  it('reads user-configured values live', () => {
    __setConfig('myDevTeam.ollama.endpoint', 'http://gpu-box:11434');
    __setConfig('myDevTeam.run.commandTimeoutMs', 5_000);
    __setConfig('myDevTeam.search.globMaxResults', 10);
    __setConfig('myDevTeam.search.contentScanLimit', 20);
    __setConfig('myDevTeam.search.contentMaxMatches', 5);

    expect(settings.ollamaEndpoint).toBe('http://gpu-box:11434');
    expect(settings.runCommandTimeoutMs).toBe(5_000);
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
      '---\nid: twin\nprovider: ollama\nmodel: twin:1b\ncapabilities:\n  speed: 1\n---\nnote';
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
  it('discovers the four workspace tools', () => {
    // Order follows the config filenames, so compare as a sorted set.
    expect([...toolNames].sort()).toEqual(['read', 'run', 'search', 'write']);
  });

  it('marks only run as side-effecting; write, read and search are not', () => {
    expect(toolConfigs.read.sideEffecting).toBe(false);
    expect(toolConfigs.search.sideEffecting).toBe(false);
    expect(toolConfigs.run.sideEffecting).toBe(true);
    expect(toolConfigs.write.sideEffecting).toBe(false);
  });

  it('maps each tool to its Language Model Tools API id', () => {
    for (const name of toolNames) {
      expect(toolConfigs[name].lmTool).toBe(`devteam__${name}`);
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
    // (e.g. just the file name for write); the names must match the zod
    // input schemas in tools/agentTools.ts or the preview silently falls
    // back to JSON.
    expect(toolConfigs.read.previewArg).toBe('path');
    expect(toolConfigs.write.previewArg).toBe('path');
    expect(toolConfigs.search.previewArg).toBe('query');
    expect(toolConfigs.run.previewArg).toBe('command');
  });

  it('names write\'s contents as its snippet argument; the others have none', () => {
    // The transcript shows this argument's first lines as a fenced snippet
    // under the call line; the name must match the zod input schema in
    // tools/agentTools.ts or the snippet silently disappears.
    expect(toolConfigs.write.snippetArg).toBe('contents');
    expect(toolConfigs.read.snippetArg).toBeUndefined();
    expect(toolConfigs.search.snippetArg).toBeUndefined();
    expect(toolConfigs.run.snippetArg).toBeUndefined();
  });

  it('renders a tools section with one line per tool', () => {
    const section = renderToolsSection(['read', 'run']);
    expect(section).toContain('You have exactly 2 tools available:');
    expect(section).toContain('- "read": Read the full text of one workspace file.');
    expect(section).toContain('Requires user approval.');
  });

  it('does not flag the write tool as needing approval', () => {
    const section = renderToolsSection(['write']);
    expect(section).toContain('- "write": Create or overwrite a file.');
    expect(section).not.toContain('Requires user approval');
  });

  it('rejects an unknown tool name', () => {
    expect(() => renderToolsSection(['delete'])).toThrow(/Unknown tool "delete"/);
  });

  it('rejects two tool files sharing one name', () => {
    const file =
      '---\nname: twin\ndisplayName: Twin\nlmTool: devteam__twin\nsideEffecting: false\n---\ndesc';
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

  it('keeps the executor contract: all four tools, decline handling, a report', () => {
    expect([...agents.executor.tools].sort()).toEqual([...toolNames].sort());
    const p = agents.executor.instructions;
    expect(p).not.toContain('{{tools}}');
    expect(p).toContain('You have exactly 4 tools available:');
    expect(p).toContain('not approved');
    expect(p).toMatch(/report/i);
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

  it('keeps the planner contract: all four tools, the step cap, and JSON output', () => {
    expect([...agents.planner.tools].sort()).toEqual([...toolNames].sort());
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
    expect(p).toContain('You have exactly 4 tools available:');
    for (const name of toolNames) {
      expect(p).toContain(`- "${name}": ${toolConfigs[name].description}`);
    }
    // The placeholder position is honoured: tools come before the rules.
    expect(p.indexOf('tools available')).toBeLessThan(p.indexOf('Rules:'));
  });

  it('matches the tool enum the planner schema actually accepts', () => {
    // The prompt advertises a tool vocabulary; keep it aligned with the schema
    // the model must satisfy so it can never name a tool the schema rejects.
    for (const tool of PlanStepSchema.shape.tool.options) {
      if (tool === 'none') continue;
      expect(agents.planner.instructions).toContain(`"${tool}"`);
    }
  });
});
