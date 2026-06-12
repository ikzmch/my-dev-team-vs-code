import { describe, it, expect } from 'vitest';
import { messages, OLLAMA_ENDPOINT } from '../src/config/messages';
import { settings } from '../src/config/settings';
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
import { PlanStepSchema } from '../src/core/planner';

describe('messages templates', () => {
  it('renders the intent block with the intent and reason', () => {
    const block = messages.triage.block('oneshot', 'because');
    expect(block).toContain('**Detected intent:** `oneshot`');
    expect(block).toContain('**Reason:** because');
  });

  it('appends the Ollama troubleshooting hint to triage errors', () => {
    const text = messages.triage.error('connection refused');
    expect(text).toContain('**Triage error:** connection refused');
    expect(text).toContain(OLLAMA_ENDPOINT);
    expect(text).toContain(selectModel(agents.triage.capabilities).model);
  });

  it('appends the Ollama troubleshooting hint to planner errors', () => {
    const text = messages.plan.error('model missing');
    expect(text).toContain('**Planner error:** model missing');
    expect(text).toContain(OLLAMA_ENDPOINT);
  });

  it('renders the plan header from the summary', () => {
    expect(messages.plan.header('Do the thing')).toContain('**Plan:** Do the thing');
  });

  it('labels both progress phases', () => {
    expect(messages.progress.understanding).toBeTruthy();
    expect(messages.progress.drafting).toBeTruthy();
  });

  it('provides approval titles and decline replies for side-effecting tools', () => {
    expect(messages.approval.runCommandTitle).toBeTruthy();
    expect(messages.approval.writeFileTitle).toBeTruthy();
    expect(messages.notApproved.run).toMatch(/not.*approved/i);
    expect(messages.notApproved.write).toMatch(/not.*approved/i);
  });

  it('marks every not-yet-implemented next step so the reply stays honest', () => {
    expect(messages.triage.oneshotNextStep).toContain('not yet implemented');
    expect(messages.plan.nextStep).toContain('not yet implemented');
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
    expect(settings.writePreviewMaxChars).toBeGreaterThan(0);
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

describe('tool configs', () => {
  it('discovers the four workspace tools', () => {
    // Order follows the config filenames, so compare as a sorted set.
    expect([...toolNames].sort()).toEqual(['read', 'run', 'search', 'write']);
  });

  it('marks run and write as side-effecting, read and search as not', () => {
    expect(toolConfigs.read.sideEffecting).toBe(false);
    expect(toolConfigs.search.sideEffecting).toBe(false);
    expect(toolConfigs.run.sideEffecting).toBe(true);
    expect(toolConfigs.write.sideEffecting).toBe(true);
  });

  it('maps each tool to its Language Model Tools API id', () => {
    for (const name of toolNames) {
      expect(toolConfigs[name].lmTool).toBe(`devteam__${name}`);
    }
  });

  it('renders a tools section with one line per tool', () => {
    const section = renderToolsSection(['read', 'write']);
    expect(section).toContain('You have exactly 2 tools available:');
    expect(section).toContain('- "read": Read the full text of one workspace file.');
    expect(section).toContain(
      '- "write": Create or overwrite a file. Requires user approval.'
    );
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
    expect(agents.triage.instructions).toContain('triage agent');
    expect(agents.planner.instructions).toContain('planner');
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

  it('keeps the planner contract: all four tools, the step cap, and JSON output', () => {
    expect([...agents.planner.tools].sort()).toEqual([...toolNames].sort());
    const p = agents.planner.instructions;
    expect(p).toContain('never more than 8');
    expect(p).toMatch(/JSON object/i);
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
