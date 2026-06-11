import { describe, it, expect } from 'vitest';
import { messages, OLLAMA_ENDPOINT } from '../src/config/messages';
import { settings } from '../src/config/settings';
import { modelConfig } from '../src/config/modelConfig';
import { parseFrontmatter } from '../src/config/frontmatter';
import { agents } from '../src/config/agents';
import { toolConfigs, toolNames, renderToolsSection } from '../src/config/tools';
import { PlanStepSchema } from '../src/core/planner';

describe('messages templates', () => {
  it('renders the intent block with the intent and reason', () => {
    const block = messages.intent.block('oneshot', 'because');
    expect(block).toContain('**Detected intent:** `oneshot`');
    expect(block).toContain('**Reason:** because');
  });

  it('appends the Ollama troubleshooting hint to classifier errors', () => {
    const text = messages.intent.error('connection refused');
    expect(text).toContain('**Intent classifier error:** connection refused');
    expect(text).toContain(OLLAMA_ENDPOINT);
    expect(text).toContain(modelConfig.intent.model);
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
    expect(messages.intent.oneshotNextStep).toContain('not yet implemented');
    expect(messages.plan.nextStep).toContain('not yet implemented');
  });

  it('keeps the Ollama hint sourced from modelConfig, not a hardcoded id', () => {
    // The hint must name whatever model the router is configured with, so the
    // troubleshooting text can never drift from the actual model in use.
    expect(messages.intent.error('x')).toContain(modelConfig.intent.model);
    expect(messages.plan.error('x')).toContain(modelConfig.intent.model);
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
});

describe('modelConfig', () => {
  it.each(['intent', 'plan'] as const)('defines provider and model for %s', (role) => {
    expect(modelConfig[role].provider).toBeTruthy();
    expect(modelConfig[role].model).toBeTruthy();
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

  it('treats a file without frontmatter as all body', () => {
    expect(parseFrontmatter('just text')).toEqual({ data: {}, body: 'just text' });
  });

  it('throws on a malformed line', () => {
    expect(() => parseFrontmatter('---\nnot yaml at all\n---\nbody')).toThrow(
      /Unsupported frontmatter/
    );
  });
});

describe('tool configs', () => {
  it('loads the four workspace tools', () => {
    expect(toolNames).toEqual(['read', 'search', 'run', 'write']);
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
});

describe('agent configs', () => {
  it('loads frontmatter fields and non-empty instructions for each agent', () => {
    expect(agents.intentClassifier.id).toBe('intent-classifier');
    expect(agents.intentClassifier.name).toBe('Intent Classifier');
    expect(agents.intentClassifier.description).toBeTruthy();
    expect(agents.intentClassifier.model).toBe('intent');
    expect(agents.planner.id).toBe('planner');
    expect(agents.planner.name).toBe('Planner');
    expect(agents.planner.description).toBeTruthy();
    expect(agents.planner.model).toBe('plan');
    expect(agents.intentClassifier.instructions).toContain('intent classifier');
    expect(agents.planner.instructions).toContain('planner');
  });

  // The prose lives in standalone .md files, so these lock the structural
  // contract each agent depends on — an accidental edit that drops a routing
  // category or a tool would fail here rather than silently degrade routing.
  it('keeps the classifier contract: no tools, both routing categories, JSON output', () => {
    expect(agents.intentClassifier.tools).toEqual([]);
    const p = agents.intentClassifier.instructions;
    expect(p).toContain('"oneshot"');
    expect(p).toContain('"planning"');
    expect(p).not.toContain('tools available');
    expect(p).toMatch(/JSON object/i);
  });

  it('keeps the planner contract: all four tools, the step cap, and JSON output', () => {
    expect(agents.planner.tools).toEqual(toolNames);
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
