/**
 * The single "My Dev Team" status-bar button. Clicked, it opens a small menu (a
 * quick pick) with two actions - change the active model, and open the
 * token-usage report - that delegate to the existing select-model and
 * show-usage commands. It folds together what used to be two separate
 * status-bar items (the model picker and the session token counter): the bar
 * itself is just the brand, while the live model label and the running session
 * token total ride in the two menu rows.
 *
 * It keeps the live state the menu shows: `add` accumulates each finished run's
 * tokens (independent of the opt-in eval log, exactly as the old counter did),
 * and `refresh` re-reads the engine catalogue for the current model's label.
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
import { Engine } from '../protocol/engine';
import { settings } from '../config/settings';
import { messages } from '../config/messages';
import { currentModelLabel, SELECT_MODEL_COMMAND_ID } from './modelCommands';
import { SHOW_USAGE_COMMAND_ID } from './usageView';

/** Command id the status-bar button fires to open its menu. */
export const STATUS_MENU_COMMAND_ID = 'myDevTeam.statusMenu';

interface StatusMenuItem extends vscode.QuickPickItem {
  /** The command this row runs when picked. */
  command: string;
}

export class StatusBar {
  private readonly item: vscode.StatusBarItem;
  private readonly session: TokenSummary = emptySummary();
  private modelLabel: string = settings.model;

  constructor(
    private readonly engine: Engine,
    menuCommandId: string
  ) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = menuCommandId;
    this.item.text = messages.status.statusBar;
    this.item.tooltip = messages.status.statusBarTooltip;
    this.item.show();
  }

  /** Fold one finished run's per-step usage into the session total. */
  add(usage: readonly UsageEntry[]): void {
    addSummary(this.session, sumUsage(usage));
  }

  /** Re-read the catalogue and remember the current model's label for the menu. */
  async refresh(): Promise<void> {
    try {
      this.modelLabel = currentModelLabel(await this.engine.listModels());
    } catch {
      this.modelLabel = settings.model;
    }
  }

  /**
   * Open the button's menu: pick a row and run its command. The labels carry
   * the live model label and session token total, read at open time.
   */
  async openMenu(): Promise<void> {
    const items: StatusMenuItem[] = [
      {
        label: messages.status.menuModel(this.modelLabel),
        command: SELECT_MODEL_COMMAND_ID,
      },
      {
        label: messages.status.menuUsage(
          formatTokenCount(this.session.totalTokens),
          this.session.hasEstimates
        ),
        command: SHOW_USAGE_COMMAND_ID,
      },
    ];
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: messages.status.menuPlaceholder,
    });
    if (picked) {
      await vscode.commands.executeCommand(picked.command);
    }
  }

  dispose(): void {
    this.item.dispose();
  }
}
