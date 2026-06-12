import { Agent } from '@mastra/core/agent';
import { z } from 'zod';
import { resolveModel } from './models';
import { Approver } from './types';
import { agents } from '../config/agents';
import { settings } from '../config/settings';
import { buildAgentTools } from '../tools/agentTools';

/**
 * The transcript of an execution run: an ordered interleaving of the model's
 * commentary and the tool calls it made while walking the plan. The order is
 * the product - "read this, then wrote that, then reported" - so the events
 * stay a single sequence instead of separate text/calls lists.
 *
 * Tool inputs and results are recorded as bounded display previews (compact
 * JSON / flattened text, truncated per config/settings.ts): the model saw the
 * full values during the run, the transcript only has to show the user what
 * happened.
 */
export const TextEventSchema = z.object({
  kind: z.literal('text'),
  /** Markdown the model wrote between tool calls (commentary, final report). */
  text: z.string(),
});

export const ToolEventSchema = z.object({
  kind: z.literal('tool'),
  /** Tool name from the config registry (read | search | run | write). */
  tool: z.string(),
  /** Compact JSON preview of the call arguments, truncated. */
  input: z.string(),
  /** Preview of the tool's result, truncated; absent while the call runs. */
  result: z.string().optional(),
  /** True when the tool threw instead of returning. */
  failed: z.boolean().optional(),
});

export const ExecutionEventSchema = z.discriminatedUnion('kind', [
  TextEventSchema,
  ToolEventSchema,
]);

export const ExecutionSchema = z.object({
  events: z.array(ExecutionEventSchema),
});

export type ExecutionEvent = z.infer<typeof ExecutionEventSchema>;
export type ExecutionResult = z.infer<typeof ExecutionSchema>;

/**
 * A snapshot of the execution while the run is still producing it. Snapshots
 * are grow-only the way the planner's partial plans are: events only get
 * appended, and only the last event still changes (a text event's text grows,
 * a tool event gains its result).
 */
export type PartialExecution = ExecutionResult;

/** Receives execution snapshots as the run produces them. Must not throw. */
export type ExecutionProgress = (partial: PartialExecution) => void;

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + '…' : text;
}

/** Compact JSON preview of a tool call's arguments, without Mastra's metadata. */
function inputPreview(args: unknown): string {
  if (typeof args !== 'object' || args === null) {
    return truncate(JSON.stringify(args) ?? '{}', settings.executor.inputPreviewMaxChars);
  }
  const { __mastraMetadata, ...rest } = args as Record<string, unknown>;
  return truncate(JSON.stringify(rest), settings.executor.inputPreviewMaxChars);
}

/** Bounded preview of a tool result (ours return strings; be safe anyway). */
function resultPreview(result: unknown): string {
  const text = typeof result === 'string' ? result : JSON.stringify(result) ?? '';
  return truncate(text, settings.executor.resultPreviewMaxChars);
}

/**
 * Executes the drafted plan for a "planning" request. Unlike the planner and
 * the answerer this agent carries tools: Mastra drives the tool-calling loop
 * (model call -> tool calls -> results back to the model, up to
 * `settings.executor.maxSteps` iterations) over the four workspace tools, with
 * the side-effecting ones (run, write) gated by the shared Approver exactly as
 * they are everywhere else.
 */
export class Executor {
  private readonly agent: Agent;

  constructor(approver: Approver) {
    this.agent = new Agent({
      id: agents.executor.id,
      name: agents.executor.name,
      description: agents.executor.description,
      instructions: agents.executor.instructions,
      model: resolveModel(agents.executor.capabilities),
      tools: buildAgentTools(approver),
    });
  }

  async execute(prompt: string, onPartial?: ExecutionProgress): Promise<ExecutionResult> {
    const output = await this.agent.stream([{ role: 'user', content: prompt }], {
      maxSteps: settings.executor.maxSteps,
    });

    const events: ExecutionEvent[] = [];
    // Tool results arrive by call id, possibly after further chunks; map the
    // id back to the event the matching tool-call chunk created.
    const pendingCalls = new Map<string, ExecutionEvent & { kind: 'tool' }>();
    // Snapshots are shallow copies: the sink must see the state as of each
    // emission, not a live view that later mutations of the last event change.
    const emit = () => onPartial?.({ events: events.map((event) => ({ ...event })) });

    // Drain the full chunk stream: reading it is what drives the tool-calling
    // loop to completion, so this runs even when nobody listens.
    const reader = output.fullStream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const chunk = value as { type: string; payload?: any };
      switch (chunk.type) {
        case 'text-delta': {
          const delta: string = chunk.payload?.text ?? '';
          if (!delta) {
            break;
          }
          const last = events[events.length - 1];
          if (last?.kind === 'text') {
            last.text += delta;
          } else {
            events.push({ kind: 'text', text: delta });
          }
          emit();
          break;
        }
        case 'tool-call': {
          const event = {
            kind: 'tool' as const,
            tool: String(chunk.payload?.toolName ?? ''),
            input: inputPreview(chunk.payload?.args),
          };
          events.push(event);
          pendingCalls.set(String(chunk.payload?.toolCallId ?? ''), event);
          emit();
          break;
        }
        case 'tool-result': {
          const event = pendingCalls.get(String(chunk.payload?.toolCallId ?? ''));
          if (event) {
            event.result = resultPreview(chunk.payload?.result);
            if (chunk.payload?.isError) {
              event.failed = true;
            }
            emit();
          }
          break;
        }
        case 'tool-error': {
          const event = pendingCalls.get(String(chunk.payload?.toolCallId ?? ''));
          if (event) {
            event.result = resultPreview(
              chunk.payload?.error instanceof Error
                ? chunk.payload.error.message
                : chunk.payload?.error
            );
            event.failed = true;
            emit();
          }
          break;
        }
        case 'error': {
          // The run itself broke (model unreachable, stream aborted…); fail
          // the step so the UI renders the executor error with the hint.
          const error = chunk.payload?.error;
          throw error instanceof Error ? error : new Error(String(error));
        }
      }
    }

    // Validate rather than cast, mirroring the planner: a malformed transcript
    // fails here with a schema error instead of rendering broken markdown.
    return ExecutionSchema.parse({ events });
  }
}
