import { Agent } from '@mastra/core/agent';
import { resolveModel } from './models';
import { agents } from '../config/agents';

/**
 * Receives the answer-so-far as the model streams it. Each call carries the
 * full accumulated text, not a delta, so snapshots have the same grow-only
 * shape as the planner's partial plans. Must not throw.
 */
export type AnswerProgress = (textSoFar: string) => void;

/**
 * Direct answer for a "oneshot" request. The classifier decides a request
 * needs no planning; the Answerer replies in a single model call, streaming
 * the markdown answer as it forms. No tools and no structured output: the
 * product is the prose itself.
 */
export class Answerer {
  private readonly agent = new Agent({
    id: agents.answerer.id,
    name: agents.answerer.name,
    description: agents.answerer.description,
    instructions: agents.answerer.instructions,
    model: resolveModel(agents.answerer.capabilities),
  });

  async answer(prompt: string, onPartial?: AnswerProgress): Promise<string> {
    const output = await this.agent.stream([{ role: 'user', content: prompt }]);
    // The text stream delivers deltas; accumulate them into snapshots for the
    // caller. Reading the stream is also what drives the generation to
    // completion, so this loop runs even when nobody listens.
    const reader = output.textStream.getReader();
    let text = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        text += value;
        onPartial?.(text);
      }
    }
    return output.text;
  }
}
