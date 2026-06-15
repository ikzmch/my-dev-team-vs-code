import { describe, it, expect, beforeEach } from 'vitest';
import {
  PlanPreview,
  PLAN_PREVIEW_MIN_STEPS,
  formatPlanDocument,
  isBigPlan,
} from '../src/ui/planPreview';
import { Plan } from '../src/protocol/types';
import {
  __reset,
  __getContentProvider,
  __openTabLabels,
  Uri,
} from './mocks/vscode';

beforeEach(() => {
  __reset();
});

const simplePlan: Plan = {
  summary: 'Tweak a constant',
  steps: [{ title: 'Edit the file', detail: 'change the value' }],
  complexity: 'simple',
};

const complexPlan: Plan = {
  summary: 'Add a preview surface',
  steps: [
    { title: 'Add the module', detail: 'render and serve the document' },
    { title: 'Wire the reviewer', detail: 'open and close per review' },
  ],
  decisions: [
    {
      decision: 'Use a read-only virtual document',
      rationale: 'no temp file to clean up and no save prompt',
    },
  ],
  complexity: 'complex',
};

/** A fake ExtensionContext: only the subscriptions array register() touches. */
function fakeContext() {
  return { subscriptions: [] as { dispose(): void }[] };
}

describe('formatPlanDocument', () => {
  it('renders the summary, steps, and complexity', () => {
    const doc = formatPlanDocument(simplePlan, 'simple');
    expect(doc).toContain('Tweak a constant');
    expect(doc).toContain('1. **Edit the file** - change the value');
    expect(doc).toContain('**Complexity:** `simple`');
  });

  it('includes the design decisions when the plan carries them', () => {
    const doc = formatPlanDocument(complexPlan, 'complex');
    expect(doc).toContain('Key design decisions');
    expect(doc).toContain('1. **Use a read-only virtual document** - no temp file');
  });

  it('omits the decisions heading when there are none', () => {
    const doc = formatPlanDocument(simplePlan, 'simple');
    expect(doc).not.toContain('Key design decisions');
  });
});

describe('isBigPlan', () => {
  it('is false for a short, simple plan with no decisions', () => {
    const doc = formatPlanDocument(simplePlan, 'simple');
    expect(isBigPlan(simplePlan, 'simple', doc)).toBe(false);
  });

  it('is true when the planner judged the work complex', () => {
    const plan: Plan = { ...simplePlan, complexity: 'complex' };
    const doc = formatPlanDocument(plan, 'complex');
    expect(isBigPlan(plan, 'complex', doc)).toBe(true);
  });

  it('is true when the plan carries design decisions', () => {
    // Use a moderate complexity so only the decisions can trip the check.
    const doc = formatPlanDocument(complexPlan, 'moderate');
    expect(isBigPlan(complexPlan, 'moderate', doc)).toBe(true);
  });

  it('is true when the plan has many steps', () => {
    const steps = Array.from({ length: PLAN_PREVIEW_MIN_STEPS }, (_, i) => ({
      title: `Step ${i}`,
      detail: 'do a thing',
    }));
    const plan: Plan = { summary: 's', steps, complexity: 'moderate' };
    const doc = formatPlanDocument(plan, 'moderate');
    expect(isBigPlan(plan, 'moderate', doc)).toBe(true);
  });
});

describe('PlanPreview', () => {
  it('opens a preview tab and serves the markdown, then closes on dispose', () => {
    const preview = new PlanPreview();
    preview.register(fakeContext());

    const handle = preview.open('# Plan review\n\nhello', '0');

    // A preview tab opened, labelled for the review's document.
    expect(__openTabLabels()).toContain('Preview Plan review 0.md');

    // The content provider serves the markdown for the review's uri.
    const provider = __getContentProvider('devteam-plan');
    const uri = Uri.from({ scheme: 'devteam-plan', path: '/Plan review 0.md' });
    expect(provider?.provideTextDocumentContent(uri)).toBe('# Plan review\n\nhello');

    handle.dispose();

    // The tab is closed and the content is gone.
    expect(__openTabLabels()).not.toContain('Preview Plan review 0.md');
    expect(provider?.provideTextDocumentContent(uri)).toBe('');
  });

  it('keeps concurrent reviews apart by id', () => {
    const preview = new PlanPreview();
    preview.register(fakeContext());

    const first = preview.open('first', '0');
    const second = preview.open('second', '1');

    expect(__openTabLabels()).toEqual([
      'Preview Plan review 0.md',
      'Preview Plan review 1.md',
    ]);

    // Closing one leaves the other open.
    first.dispose();
    expect(__openTabLabels()).toEqual(['Preview Plan review 1.md']);
    second.dispose();
    expect(__openTabLabels()).toEqual([]);
  });

  it('refreshes in place rather than opening a second tab for the same id', () => {
    const preview = new PlanPreview();
    preview.register(fakeContext());

    preview.open('first draft', '0');
    preview.open('second draft', '0');

    expect(__openTabLabels()).toEqual(['Preview Plan review 0.md']);
    const provider = __getContentProvider('devteam-plan');
    const uri = Uri.from({ scheme: 'devteam-plan', path: '/Plan review 0.md' });
    expect(provider?.provideTextDocumentContent(uri)).toBe('second draft');
  });
});
