/**
 * User-facing copy for the chat UI: progress labels, error text, and the
 * markdown templates the reply renderer uses. Kept out of the logic so the
 * wording (and the Ollama troubleshooting hint) can be tuned without editing
 * control flow. Functions take only the dynamic bits; static prose lives here.
 */
import { modelConfig } from './modelConfig';

/** Where the local Ollama server is expected to be listening. */
export const OLLAMA_ENDPOINT = 'http://localhost:11434';

/** Shared hint appended to classifier/planner errors. */
function ollamaHint(): string {
  return `Is Ollama running on ${OLLAMA_ENDPOINT} with \`${modelConfig.intent.model}\` pulled?\n\n`;
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

  intent: {
    block: (intent: string, reason: string) =>
      `**Detected intent:** \`${intent}\`\n\n` + `**Reason:** ${reason}\n\n`,
    oneshotNextStep:
      '**Next step (not yet implemented):** answer the question directly.\n\n',
    error: (detail: string) =>
      `**Intent classifier error:** ${detail}\n\n` + ollamaHint(),
  },

  plan: {
    error: (detail: string) => `**Planner error:** ${detail}\n\n` + ollamaHint(),
    nextStep:
      '**Next step (not yet implemented):** execute these steps with tools.\n\n',
    header: (summary: string) => `**Plan:** ${summary}\n\n`,
  },

  run: {
    /** Shown when the workflow run ends in a state we do not render yet. */
    unexpectedStatus: (status: string) =>
      `**The workflow run ended with status \`${status}\`.**\n\n`,
  },
} as const;
