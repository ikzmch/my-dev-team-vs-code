/**
 * The wire-shaped data contract between the extension (client) and the engine
 * (today the in-process LocalEngine, later a remote backend). Everything here
 * is user-visible data: prompts, system messages, agent configs, and model
 * identities never appear in these shapes - they are engine internals the
 * protocol deliberately hides.
 *
 * This module depends on nothing but zod. The engine imports it to validate
 * what it produces; the client imports it to validate what it consumes. Wire
 * schemas carry no prompt material: the engine's generation schemas (which
 * describe fields to the model) live engine-side and stay a superset-shaped
 * match of these.
 */
import { z } from 'zod';

/**
 * Version of this contract. A client sends it with every run request; an
 * engine rejects a version it does not speak. Bump it when an existing event
 * or field changes meaning - adding a new event type is backwards-compatible
 * and needs no bump.
 */
export const PROTOCOL_VERSION = 1;

/** One attached file/selection: a short label naming it plus its (already truncated) text. */
export const AttachmentSchema = z.object({
  label: z.string(),
  text: z.string(),
});
export type Attachment = z.infer<typeof AttachmentSchema>;

/**
 * Standing project instructions the client read from the workspace root (an
 * AGENTS.md or CLAUDE.md file): repository conventions every run should
 * follow. The client truncates the text; which file won is named in `source`
 * so prompts can attribute the rules.
 */
export const ProjectInstructionsSchema = z.object({
  /** The file the instructions came from, e.g. "AGENTS.md". */
  source: z.string(),
  /** The file's text, already truncated by the client. */
  text: z.string(),
});
export type ProjectInstructions = z.infer<typeof ProjectInstructionsSchema>;

/** One prior turn of the conversation, already capped by the client. */
export const HistoryTurnSchema = z.object({
  role: z.enum(['user', 'assistant']),
  text: z.string(),
});
export type HistoryTurn = z.infer<typeof HistoryTurnSchema>;

/**
 * The client's runtime facts. The workspace tools execute on the client's
 * machine, so the engine must write prompts (and the model must write
 * commands) for the client's OS and shell, not its own. The LocalEngine
 * shares a host with the client and derives the same facts itself; a remote
 * engine must render its prompts from this field.
 */
export const EnvironmentFactsSchema = z.object({
  /** Human-readable operating system name (e.g. "Windows"). */
  os: z.string(),
  /** Shell name commands are written for and executed in (e.g. "PowerShell"). */
  shell: z.string(),
});
export type EnvironmentFacts = z.infer<typeof EnvironmentFactsSchema>;

/**
 * Everything the client sends to start a run. `offeredTools` names the
 * client-side tools the engine may ask it to execute (see toolContract.ts) -
 * the implementations always stay on the client. `command` is the slash
 * command the user invoked (without the slash), if any: what a command does
 * is the engine's business (its command registry pins the route and shapes
 * the prompts), the client only relays the name, and an engine that does not
 * know the name treats the prompt as plain text. `instructions` carries the
 * workspace's standing instruction file (AGENTS.md/CLAUDE.md) when one exists;
 * an engine that predates the field simply ignores it.
 */
export const RunRequestSchema = z.object({
  protocolVersion: z.number().int().positive(),
  prompt: z.string(),
  command: z.string().optional(),
  instructions: ProjectInstructionsSchema.optional(),
  attachments: z.array(AttachmentSchema).optional(),
  history: z.array(HistoryTurnSchema).optional(),
  environment: EnvironmentFactsSchema.optional(),
  offeredTools: z.array(z.string()),
});
export type RunRequest = z.infer<typeof RunRequestSchema>;

/** The routing decision: answer in one shot, or plan and execute. */
export const IntentSchema = z.enum(['oneshot', 'planning']);
export type Intent = z.infer<typeof IntentSchema>;

/**
 * A drafted plan step. `tool` is a tool name from the run's offered tools, or
 * "none" for a pure-reasoning step. The wire keeps it a plain string: which
 * names are valid is the engine's business, and a client only displays it.
 */
export const PlanStepSchema = z.object({
  title: z.string(),
  tool: z.string(),
  detail: z.string(),
});
export type PlanStep = z.infer<typeof PlanStepSchema>;

export const PlanSchema = z.object({
  summary: z.string(),
  steps: z.array(PlanStepSchema).min(1),
});
export type Plan = z.infer<typeof PlanSchema>;

/**
 * A snapshot of the plan while the engine is still drafting it. Field values
 * arrive incrementally: strings grow over time and later fields are missing
 * until the model reaches them, so everything is optional and `tool` may hold
 * a not-yet-complete value.
 */
export type PartialPlanStep = {
  title?: string;
  tool?: string;
  detail?: string;
};
export type PartialPlan = {
  summary?: string;
  steps?: Array<PartialPlanStep | undefined>;
};

/**
 * The transcript of an execution run: an ordered interleaving of the model's
 * commentary and the tool calls it made while walking the plan. The order is
 * the product - "read this, then wrote that, then reported" - so the events
 * stay a single sequence instead of separate text/calls lists.
 *
 * Tool inputs and results are recorded as bounded display previews the engine
 * computes: the model saw the full values during the run, the transcript only
 * has to show the user what happened.
 */
export const TextEventSchema = z.object({
  kind: z.literal('text'),
  /** Markdown the model wrote between tool calls (commentary, final report). */
  text: z.string(),
});

export const ToolEventSchema = z.object({
  kind: z.literal('tool'),
  /** Tool name (read | search | run | write). */
  tool: z.string(),
  /** Display preview of the call arguments, truncated by the engine. */
  input: z.string(),
  /**
   * Leading lines of the tool's snippet-bearing argument (e.g. the file
   * contents for write), shown beneath the call line. Absent for tools
   * without one or when snippets are turned off.
   */
  snippet: z.string().optional(),
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
export type Execution = z.infer<typeof ExecutionSchema>;

/**
 * A snapshot of the execution while the run is still producing it. Snapshots
 * are grow-only: events only get appended, and only the last event still
 * changes (a text event's text grows, a tool event gains its result).
 */
export type PartialExecution = Execution;

/**
 * What a run produces: the routing decision plus, for "planning" requests,
 * the drafted plan and the execution transcript, or, for "oneshot" requests,
 * the direct answer. Rendering this into chat markdown is the client's job.
 */
export const ReplySchema = z.object({
  intent: IntentSchema,
  reason: z.string(),
  plan: PlanSchema.optional(),
  answer: z.string().optional(),
  execution: ExecutionSchema.optional(),
});
export type Reply = z.infer<typeof ReplySchema>;

/**
 * A snapshot of the reply while the run is still producing it: the triage
 * decision is complete from the first event on, the plan and the execution
 * transcript grow as the engine streams them, and the answer grows as
 * accumulated text. Clients rebuild this from run events with `ReplyFolder`
 * (see events.ts) and render each snapshot.
 */
export type ReplyProgress = {
  intent: Intent;
  reason: string;
  plan?: PartialPlan;
  answer?: string;
  execution?: PartialExecution;
};
