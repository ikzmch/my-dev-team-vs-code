import { describe, it, expect } from 'vitest';
import { messages, OLLAMA_ENDPOINT } from '../src/config/messages';
import { settings } from '../src/config/settings';
import { modelConfig } from '../src/config/modelConfig';
import { prompts } from '../src/config/prompts';
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

describe('prompts', () => {
  it('inlines non-empty prompt prose for each agent', () => {
    expect(prompts.intentClassifier.length).toBeGreaterThan(0);
    expect(prompts.planner.length).toBeGreaterThan(0);
    expect(prompts.intentClassifier).toContain('intent classifier');
    expect(prompts.planner).toContain('planner');
  });

  // The prose now lives in standalone .md files, so these lock the structural
  // contract each agent depends on — an accidental edit that drops a routing
  // category or a tool would fail here rather than silently degrade routing.
  it('keeps the classifier contract: both routing categories and JSON output', () => {
    const p = prompts.intentClassifier;
    expect(p).toContain('"oneshot"');
    expect(p).toContain('"planning"');
    expect(p).toMatch(/JSON object/i);
  });

  it('keeps the planner contract: all four tools, the step cap, and JSON output', () => {
    const p = prompts.planner;
    for (const tool of ['read', 'search', 'run', 'write']) {
      expect(p).toContain(`"${tool}"`);
    }
    expect(p).toContain('never more than 8');
    expect(p).toMatch(/JSON object/i);
  });

  it('matches the tool enum the planner schema actually accepts', () => {
    // The prompt advertises a tool vocabulary; keep it aligned with the schema
    // the model must satisfy so it can never name a tool the schema rejects.
    for (const tool of PlanStepSchema.shape.tool.options) {
      if (tool === 'none') continue;
      expect(prompts.planner).toContain(`"${tool}"`);
    }
  });
});
