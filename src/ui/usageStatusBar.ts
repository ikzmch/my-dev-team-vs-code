/**
 * The status-bar token counter: a running total of the input + output tokens
 * spent by every @devteam run this session (the extension's lifetime). It sits
 * beside the model item and, clicked, opens the "Show Token Usage" report. The
 * counter is independent of the opt-in eval log - it accumulates live usage the
 * chat handler hands it, so it works even with logging off.
 */
import * as vscode from 'vscode';
import { UsageEntry } from '../client/evalLog';
import {
  TokenSummary,
  addSummary,
  emptySummary,
  formatTokenCount,
  sumUsage,
} from '../client/usageStats';
import { messages } from '../config/messages';

export class UsageStatusBar {
  private readonly item: vscode.StatusBarItem;
  private readonly session: TokenSummary = emptySummary();

  constructor(reportCommandId: string) {
    // Priority 99 places it just left of the model item (100), so the two read
    // as one "what ran / what it cost" cluster.
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    this.item.command = reportCommandId;
    this.item.tooltip = messages.usage.statusBarTooltip;
    this.render();
    this.item.show();
  }

  /** Fold one finished run's per-step usage into the session total and redraw. */
  add(usage: readonly UsageEntry[]): void {
    addSummary(this.session, sumUsage(usage));
    this.render();
  }

  private render(): void {
    this.item.text = messages.usage.statusBar(
      formatTokenCount(this.session.totalTokens),
      this.session.hasEstimates
    );
  }

  dispose(): void {
    this.item.dispose();
  }
}
