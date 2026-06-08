import { ChatTurn, AgentReply, OutputSink } from './types';
import { IntentClassifier } from './intentClassifier';
import { Planner, PlanResult } from './planner';

/**
 * The backend abstraction. Swap the implementation to point at the Anthropic
 * API, the M365 Copilot Chat API, or VS Code's `vscode.lm` models. The rest of
 * the extension only depends on this interface.
 */
export interface Backend {
  /**
   * Produce a reply given the conversation so far.
   * In a real backend this is where you'd run the tool-calling loop with the
   * model: the model asks for a tool, you execute it via the ToolRegistry,
   * feed the result back, and repeat until it returns a final answer.
   *
   * The `sink` lets the backend stream transient progress messages
   * (e.g. "Understanding your request…") to the UI as work progresses.
   */
  reply(history: ChatTurn[], sink: OutputSink): Promise<AgentReply>;
}

/**
 * Stub backend. Returns canned responses so the extension runs end-to-end
 * with no API key. Replace `reply()` with a real client when ready.
 *
 * To wire a real backend later:
 *  - Anthropic:  POST to https://api.anthropic.com/v1/messages with tools[],
 *                loop on stop_reason === "tool_use".
 *  - M365 Copilot Chat API: POST to the Graph /beta copilot conversations
 *                endpoint (preview); requires a Copilot add-on license.
 *  - vscode.lm:  use vscode.lm.selectChatModels() + sendRequest().
 */
export class StubBackend implements Backend {
  constructor(
    private readonly classifier?: IntentClassifier,
    private readonly planner?: Planner
  ) {}

  async reply(history: ChatTurn[], sink: OutputSink): Promise<AgentReply> {
    const lastUser = [...history].reverse().find((t) => t.role === 'user');
    const prompt = lastUser?.content ?? '';

    let intentBlock = '';
    if (this.classifier) {
      try {
        sink.progress('Understanding your request…');
        const result = await this.classifier.classify(prompt);
        intentBlock =
          `**Detected intent:** \`${result.intent}\`\n\n` +
          `**Reason:** ${result.reason}\n\n`;

        if (result.intent === 'oneshot') {
          intentBlock +=
            `**Next step (not yet implemented):** answer the question directly.\n\n`;
        } else {
          // Planning path: draft the plan now; execution is the next roadmap item.
          intentBlock += await this.renderPlan(prompt, sink);
        }
      } catch (err: any) {
        intentBlock =
          `**Intent classifier error:** ${err?.message ?? String(err)}\n\n` +
          'Is Ollama running on http://localhost:11434 with `qwen3:8b` pulled?\n\n';
      }
    }

    return {
      text:
        `**(stub backend)** You said:\n\n> ${prompt.replace(/\n/g, '\n> ')}\n\n` +
        intentBlock +
        'The executor is not wired up yet, so I stop after planning for now.',
    };
  }

  /**
   * Draft a step-by-step plan for a request the classifier routed to "planning".
   * Returns a markdown block; the executor that walks these steps is the next
   * roadmap item, so we render the plan rather than running it.
   */
  private async renderPlan(prompt: string, sink: OutputSink): Promise<string> {
    if (!this.planner) {
      return `**Next step (not yet implemented):** draft a plan, then execute it with tools.\n\n`;
    }
    try {
      sink.progress('Drafting a plan…');
      const plan = await this.planner.plan(prompt);
      return this.formatPlan(plan);
    } catch (err: any) {
      return (
        `**Planner error:** ${err?.message ?? String(err)}\n\n` +
        'Is Ollama running on http://localhost:11434 with `qwen3:8b` pulled?\n\n'
      );
    }
  }

  /** Render a structured plan as a readable markdown checklist. */
  private formatPlan(plan: PlanResult): string {
    const steps = plan.steps
      .map((step, i) => {
        const tool = step.tool === 'none' ? '' : ` _(${step.tool})_`;
        return `${i + 1}. **${step.title}**${tool} — ${step.detail}`;
      })
      .join('\n');
    return (
      `**Plan:** ${plan.summary}\n\n` +
      `${steps}\n\n` +
      `**Next step (not yet implemented):** execute these steps with tools.\n\n`
    );
  }
}
