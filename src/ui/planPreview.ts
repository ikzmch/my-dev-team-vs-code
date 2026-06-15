// The read-only plan preview: a big or design-bearing plan, paused at the
// approval gate, opens beside the chat as rendered markdown so the user can
// read the whole plan and its design decisions while deciding. This is a
// pure client concern - the engine only ever asks the client to review a plan
// (RunClient.reviewPlan) and never learns an editor opened - so nothing here
// crosses the engine protocol; the Approve/Cancel/Revise choices stay in the
// chat (see ChatPlanReviewer), this is only the reading surface.
//
// The document is virtual and read-only: a TextDocumentContentProvider serves
// the markdown from memory under a custom scheme, so nothing is written to the
// workspace (no temp file to clean up, no save prompt, no git noise) and the
// preview disposes itself when the review settles.

import * as vscode from 'vscode';
import { Complexity, Plan } from '../protocol/types';
import { messages } from '../config/messages';

/** The virtual-document scheme the preview content provider serves. */
const SCHEME = 'devteam-plan';

/**
 * Under the `auto` preview setting, a plan opens a preview when it is "big".
 * A plan tops out at 12 short steps, so "big" means awkward to read inline in
 * the chat scroll, not huge: the planner judged it `complex`, it carries design
 * decisions, its rendered document is long, or it has many steps.
 */
export const PLAN_PREVIEW_MIN_CHARS = 1_400;
export const PLAN_PREVIEW_MIN_STEPS = 8;

/**
 * Render a drafted plan into the standalone markdown the preview displays: the
 * goal, the design decisions (when any), the numbered steps, and the
 * complexity. Exported for tests and for the reviewer's "is it big" check,
 * which measures this document's length.
 */
export function formatPlanDocument(plan: Plan, complexity: Complexity): string {
  let doc = messages.planDocument.title;
  doc += messages.planDocument.summary(plan.summary);
  if (plan.decisions && plan.decisions.length > 0) {
    doc += messages.planDocument.decisionsHeading;
    doc +=
      plan.decisions
        .map((d, i) => messages.planDocument.decision(i + 1, d.decision, d.rationale))
        .join('\n') + '\n';
  }
  doc += messages.planDocument.stepsHeading;
  doc +=
    plan.steps.map((s, i) => messages.planDocument.step(i + 1, s.title, s.detail)).join('\n') +
    '\n';
  doc += messages.planDocument.complexity(complexity);
  return doc;
}

/**
 * Whether a plan warrants the editor preview under the `auto` setting (the
 * `always`/`never` settings bypass this). True when the plan is complex, when
 * it carries design decisions, when its rendered document is long, or when it
 * has many steps - the cases where the chat checklist alone reads poorly.
 */
export function isBigPlan(plan: Plan, complexity: Complexity, document: string): boolean {
  return (
    complexity === 'complex' ||
    (plan.decisions?.length ?? 0) > 0 ||
    document.length >= PLAN_PREVIEW_MIN_CHARS ||
    plan.steps.length >= PLAN_PREVIEW_MIN_STEPS
  );
}

/**
 * Serves the plan markdown as read-only virtual documents and opens/closes the
 * preview tab. One instance is registered on activation; the reviewer opens a
 * preview per review (keyed by the review id so concurrent runs do not collide)
 * and disposes it when the review settles.
 */
export class PlanPreview {
  /** Review id -> the markdown its virtual document currently serves. */
  private readonly contents = new Map<string, string>();
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();

  /** Register the content provider. Call once on activation. */
  register(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      this.changed,
      vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
        onDidChange: this.changed.event,
        provideTextDocumentContent: (uri) => this.contents.get(uri.path) ?? '',
      })
    );
  }

  /** The virtual-document uri for a review id; its last path segment is the tab name. */
  private uriFor(id: string): vscode.Uri {
    return vscode.Uri.from({ scheme: SCHEME, path: `/${messages.planDocument.fileName(id)}` });
  }

  /**
   * Open the preview for review `id` showing `markdown`, and return a disposable
   * that removes the content and closes the tab. Opening to the side keeps the
   * chat visible. Idempotent for a given id: a second call refreshes the content
   * of the already-open preview in place rather than opening a second tab.
   */
  open(markdown: string, id: string): vscode.Disposable {
    const uri = this.uriFor(id);
    const existed = this.contents.has(uri.path);
    this.contents.set(uri.path, markdown);
    if (existed) {
      this.changed.fire(uri);
    } else {
      void vscode.commands.executeCommand('markdown.showPreviewToSide', uri);
    }
    return { dispose: () => this.close(id) };
  }

  private close(id: string): void {
    const uri = this.uriFor(id);
    if (!this.contents.delete(uri.path)) {
      return;
    }
    // Best-effort: close the preview tab. The markdown preview is a webview tab
    // VS Code labels "Preview <fileName>", so match it by our per-id file name
    // (the ".md" suffix keeps "1.md" from matching "10.md"). A broken or stubbed
    // tabGroups must never throw out of a review's cleanup - a stale preview tab
    // is harmless, it just shows the last plan until the user closes it.
    const fileName = messages.planDocument.fileName(id);
    try {
      for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
          if (tab.label.includes(fileName)) {
            void vscode.window.tabGroups.close(tab);
          }
        }
      }
    } catch {
      // tabGroups unavailable; leave the preview open.
    }
  }
}
