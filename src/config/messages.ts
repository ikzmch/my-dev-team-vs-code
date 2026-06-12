/**
 * User-facing copy for the chat UI: progress labels, error text, and the
 * markdown templates the reply renderer uses. Kept out of the logic so the
 * wording (and the Ollama troubleshooting hint) can be tuned without editing
 * control flow. Functions take only the dynamic bits; static prose lives here.
 */
import { selectModel } from './models';
import { agents, AgentName } from './agents';
import { settings } from './settings';

/**
 * Hint appended to triage/planner errors, naming the model the router
 * actually selected for that agent and the endpoint the provider wiring
 * actually uses (`settings.ollamaEndpoint`), so the troubleshooting text can
 * never drift from either.
 */
function ollamaHint(agent: AgentName): string {
  const { model } = selectModel(agents[agent].capabilities);
  return `Is Ollama running on ${settings.ollamaEndpoint} with \`${model}\` pulled?\n\n`;
}

export const messages = {
  progress: {
    understanding: 'Understanding your request…',
    drafting: 'Drafting a plan…',
  },

  /** Approval-dialog titles for side-effecting tools. */
  approval: {
    runCommandTitle: 'Run command',
    writeFileTitle: 'Write file',
  },

  /** Returned to the model when the user declines a side-effecting tool. */
  notApproved: {
    run: 'Command was not approved by the user.',
    write: 'Write was not approved by the user.',
  },

  triage: {
    block: (intent: string, reason: string) =>
      `**Detected intent:** \`${intent}\`\n\n` + `**Reason:** ${reason}\n\n`,
    oneshotNextStep:
      '**Next step (not yet implemented):** answer the question directly.\n\n',
    error: (detail: string) =>
      `**Triage error:** ${detail}\n\n` + ollamaHint('triage'),
  },

  plan: {
    error: (detail: string) => `**Planner error:** ${detail}\n\n` + ollamaHint('planner'),
    nextStep:
      '**Next step (not yet implemented):** execute these steps with tools.\n\n',
    // A prefix rather than a template: the renderer streams the summary in
    // behind it while the planner is still writing it.
    header: '**Plan:** ',
  },

  run: {
    /** Shown when the workflow run ends in a state we do not render yet. */
    unexpectedStatus: (status: string) =>
      `**The workflow run ended with status \`${status}\`.**\n\n`,
  },

  /** Warnings the activation health check may surface (ui/startupCheck.ts). */
  startup: {
    unreachable: (endpoint: string) =>
      `My Dev Team: cannot reach Ollama at ${endpoint}. ` +
      'Start it with "ollama serve", or point the "myDevTeam.ollama.endpoint" setting at your server.',
    missingModels: (models: readonly string[]) =>
      `My Dev Team: Ollama is missing the model(s) the router selected: ${models.join(', ')}. ` +
      'Pull them with "ollama pull <model>".',
  },
} as const;
