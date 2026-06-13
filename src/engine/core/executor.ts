import { Agent } from '@mastra/core/agent';
import { resolveModel, routeModel } from './models';
import { buildAgentTools, PROGRESS_TOOL, ProgressReportSchema } from './agentTools';
import { resolveTokenCounts, UsageReporter } from './usage';
import { agents } from '../config/agents';
import { toolConfigs } from '../config/tools';
import { settings } from '../../config/settings';
import {
  ExecutionEvent,
  Execution,
  ExecutionSchema,
  PartialExecution,
} from '../../protocol/types';
import { ToolHost } from '../../protocol/toolContract';

export { ExecutionSchema } from '../../protocol/types';
export type { ExecutionEvent, PartialExecution } from '../../protocol/types';

/**
 * The execution transcript shapes live in the protocol (src/protocol/types.ts):
 * the ordered interleaving of model commentary and tool calls *is* the
 * user-visible product of this agent, so its schema is part of the wire
 * contract. This file produces those events; the input/result previews are
 * computed here, bounded by config/settings.ts, because the engine is what
 * saw the full values.
 */
export type ExecutionResult = Execution;

/** Receives execution snapshots as the run produces them. Must not throw. */
export type ExecutionProgress = (partial: PartialExecution) => void;

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + '…' : text;
}

/**
 * Display preview of a tool call's arguments. When the tool's config names a
 * `previewArg`, only that value is shown - the transcript should say
 * "write calculator.py", not dump the args JSON with the file contents.
 * Otherwise falls back to compact JSON without Mastra's metadata.
 */
function inputPreview(tool: string, args: unknown): string {
  const max = settings.executor.inputPreviewMaxChars;
  if (typeof args !== 'object' || args === null) {
    return truncate(JSON.stringify(args) ?? '{}', max);
  }
  const { __mastraMetadata, ...rest } = args as Record<string, unknown>;
  const previewArg = toolConfigs[tool]?.previewArg;
  const headline = previewArg === undefined ? undefined : rest[previewArg];
  if (typeof headline === 'string' && headline) {
    return truncate(headline, max);
  }
  return truncate(JSON.stringify(rest), max);
}

/**
 * Multi-line snippet of a tool call's snippet argument: its first
 * `settings.executor.snippetLines` lines (each bounded like the input
 * preview), with a truncation message when more follow. Undefined when the
 * tool has no `snippetArg`, the argument is missing or empty, or snippets
 * are turned off (line count 0).
 */
function inputSnippet(tool: string, args: unknown): string | undefined {
  const snippetArg = toolConfigs[tool]?.snippetArg;
  if (snippetArg === undefined || typeof args !== 'object' || args === null) {
    return undefined;
  }
  const value = (args as Record<string, unknown>)[snippetArg];
  const maxLines = settings.executor.snippetLines;
  if (typeof value !== 'string' || !value.trim() || maxLines <= 0) {
    return undefined;
  }
  const lines = value.trimEnd().split('\n');
  const head = lines
    .slice(0, maxLines)
    .map((line) => truncate(line, settings.executor.inputPreviewMaxChars));
  if (lines.length > maxLines) {
    head.push('…(truncated)');
  }
  return head.join('\n');
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
 * `settings.executor.maxSteps` iterations) over proxies that delegate every
 * call to the client's ToolHost - the host owns the implementations and the
 * approval gate, the engine only decides what to call.
 */
export class Executor {
  private readonly modelName: string;
  private readonly agent: Agent;
  /**
   * The current run's cancellation signal, set for the duration of `execute`.
   * The tool proxies read it through the getter handed to `buildAgentTools`,
   * so a cancelled request stops an in-flight command or write even though
   * the toolset itself is built once here.
   */
  private currentSignal: AbortSignal | undefined;

  /**
   * `modelPin` is the user's per-run model choice (a registry id, or "auto"/
   * undefined for the capability router). The executor is already built per
   * run (it is bound to the run's ToolHost), so the choice is resolved here.
   */
  constructor(toolHost: ToolHost, modelPin?: string) {
    this.modelName = routeModel(agents.executor.capabilities, modelPin).model;
    this.agent = new Agent({
      id: agents.executor.id,
      name: agents.executor.name,
      description: agents.executor.description,
      instructions: agents.executor.instructions,
      model: resolveModel(agents.executor.capabilities, modelPin),
      tools: buildAgentTools(toolHost, () => this.currentSignal),
    });
  }

  async execute(
    prompt: string,
    onPartial?: ExecutionProgress,
    signal?: AbortSignal,
    onUsage?: UsageReporter
  ): Promise<ExecutionResult> {
    this.currentSignal = signal;
    try {
      return await this.run(prompt, onPartial, signal, onUsage);
    } finally {
      this.currentSignal = undefined;
    }
  }

  private async run(
    prompt: string,
    onPartial: ExecutionProgress | undefined,
    signal: AbortSignal | undefined,
    onUsage: UsageReporter | undefined
  ): Promise<ExecutionResult> {
    // Forward the signal so Mastra stops the tool-calling loop when the request
    // is cancelled; only add it when present so the no-signal call still passes
    // exactly { maxSteps } to the model.
    const options: { maxSteps: number; abortSignal?: AbortSignal } = {
      maxSteps: settings.executor.maxSteps,
    };
    if (signal) {
      options.abortSignal = signal;
    }
    const output = await this.agent.stream([{ role: 'user', content: prompt }], options);

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
          const tool = String(chunk.payload?.toolName ?? '');
          // The progress tool is engine-only: rather than a transcript tool
          // call, its arguments become a `progress` checklist event. A
          // malformed or empty report is dropped (it only fails to render,
          // never the run), and its result chunk is ignored below because it
          // was never put in `pendingCalls`.
          if (tool === PROGRESS_TOOL) {
            const parsed = ProgressReportSchema.safeParse(chunk.payload?.args);
            if (parsed.success && parsed.data.items.length > 0) {
              events.push({ kind: 'progress', items: parsed.data.items });
              emit();
            }
            break;
          }
          const snippet = inputSnippet(tool, chunk.payload?.args);
          const event = {
            kind: 'tool' as const,
            tool,
            input: inputPreview(tool, chunk.payload?.args),
            ...(snippet === undefined ? {} : { snippet }),
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

    // The transcript's text events are the model's prose output; join them as
    // the reply estimate for when the SDK reports no counts.
    const replyText = events
      .map((event) => (event.kind === 'text' ? event.text : ''))
      .join('');
    onUsage?.({
      model: this.modelName,
      ...(await resolveTokenCounts(output, prompt, replyText)),
    });

    // Validate rather than cast, mirroring the planner: a malformed transcript
    // fails here with a schema error instead of rendering broken markdown.
    return ExecutionSchema.parse({ events });
  }
}
