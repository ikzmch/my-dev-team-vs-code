# My Dev Team — VS Code agent

An agentic chat participant for VS Code. It lives in the **native chat panel**
(invoke with `@devteam`), gets 👍/👎 **feedback for free**, and can **read,
search, run, and write** files in your workspace via the Language Model Tools
API.

The agent routes each request through a **local triage agent** (Ollama via
the Vercel AI SDK + Mastra) before deciding how to respond. Agents don't name
models: each declares **weighted capability requirements**, and a router picks
the best match from a **registry of models scored per capability**, discovered
from `.md` config files at build time. Side-effecting
actions (run command, write file) are gated by an **approval seam**, so the chat
confirmation can later be swapped for a rich Webview diff dialog **without
touching the agent core**.

> **Status:** the full pipeline is live - the routing layer (triage), the
> **planner**, the **oneshot answerer**, and the **executor**. The workflow
> classifies your request, answers `oneshot` questions directly, and for
> `planning` requests drafts a step-by-step plan and then **executes it**: the
> executor's capability-routed model drives a tool-calling loop over the four
> workspace tools, with side effects gated by the approval seam. See
> [Current behavior](#current-behavior) and [Roadmap](#roadmap).

## Architecture

```
src/
  extension.ts            entry point — wires core + tools + UI together
  config/                 configuration, kept out of the logic (see below)
    agents/
      triage.md           triage config: frontmatter + system prompt
      planner.md          planner config: frontmatter + system prompt
      answerer.md         answerer config: frontmatter + system prompt
      executor.md         executor config: frontmatter + system prompt
    models/
      *.md                one registered model per file: provider, model id, capability scores
    tools/
      read.md … write.md  one config per tool: frontmatter + model-facing description
    agents.ts             loads agents/*.md, renders the tools section, exports `agents`
    models.ts             discovers models/*.md, exports the registry + capability-based `selectModel`
    tools.ts              discovers tools/*.md, exports `toolConfigs` + `renderToolsSection`
    frontmatter.ts        minimal frontmatter parser for the .md config files
    markdown.d.ts         lets TS treat `*.md` and `glob:` imports as strings / string[]
    settings.ts           operational limits; the endpoint/timeout/search caps read live from VS Code settings
    messages.ts           user-facing chat copy (progress, errors, warnings, templates)
  core/
    types.ts              Approver — the approval seam
    workflow.ts           Mastra workflow: triage -> plan -> execute | answer; streams reply progress to a per-run sink
    models.ts             provider wiring: turns the selected registry entry into an AI SDK model
    triage.ts             Mastra agent: triage request as oneshot | planning
    planner.ts            Mastra agent: draft an ordered, tool-aware plan, streamed as partial snapshots
    answerer.ts           Mastra agent: answer a oneshot request directly, streamed as accumulated text
    executor.ts           Mastra agent: walk the plan in a tool-calling loop, streamed as a transcript
  tools/
    workspaceTools.ts     read / search / run / write (UI-agnostic)
    registerTools.ts      registers tools with vscode.lm
    agentTools.ts         the same four tools as Mastra createTool()s for the executor's loop
  ui/
    chatParticipant.ts    chat handler, streaming reply renderer + Phase-1 ChatApprover
    startupCheck.ts       activation health check: ping Ollama, verify routed models are pulled
test/                     Vitest unit tests + an in-memory `vscode` mock
esbuild.mjs               bundle build script: esbuild API + the md-glob plugin
md-glob.mjs               build-time `glob:./dir/*.md` expansion, shared with Vitest
```

Three layers, deliberately decoupled:

- **Agent core** (`core/`, `tools/workspaceTools.ts`) knows nothing about the UI.
- **UI layer** (`ui/`) is swappable: Chat Participant today, add a Webview later.
- **`Approver`** is the seam. `ChatApprover` is Phase 1; a `WebviewApprover`
  implementing the same interface is Phase 2 — the tools never change.

### Request flow

```
@devteam <prompt>
        │
        ▼
ui/chatParticipant.ts          resolve attached files/selections into labelled
  createHandler                attachments passed alongside the prompt, start a
        │                      run of the workflow, bridge its step events onto
        │                      the chat stream as progress labels, and hand the
        │                      run a reply-progress sink (Mastra RequestContext)
        ▼
core/workflow.ts               Mastra workflow (createWorkflow + createStep)
  triage                       ── Triage.classify(triagePrompt)
        │                         prompt + attachment labels only (contents
        │                         omitted: routing needs no file text, and it
        │                         would crowd a small local model's context)
        │                         → { intent: "oneshot" | "planning", reason }
        ▼                         (model picked by the capability router)
      branch
        ├─▶ draft-plan         ── Planner.plan(fullPrompt, onPartial)  (intent = "planning")
        │                         prompt + full attachment text inlined;
        │                         → { summary, steps[] } (capability-routed model);
        │                         pushes the triage decision and every partial
        │                         plan snapshot to the sink as the model streams
        └─▶ answer-directly    ── Answerer.answer(fullPrompt, onPartial)  (intent = "oneshot")
        │                         → markdown answer (capability-routed model);
        │                         pushes the triage decision and the growing
        │                         answer text to the sink as the model streams
        ▼
      branch
        ├─▶ execute-plan       ── Executor.execute(executionPrompt, onPartial)  (a plan was drafted)
        │                         prompt + attachment text + the numbered plan;
        │                         Mastra runs the tool-calling loop over the four
        │                         workspace tools (run/write Approver-gated);
        │                         → { events[] } transcript (capability-routed model);
        │                         pushes every transcript snapshot to the sink
        └─▶ deliver-answer     ── pass-through for the oneshot path, so a oneshot
        │                         run never starts (or shows progress for) an
        ▼                         executor step
  the UI streams the reply onto the chat panel as it forms: each snapshot is
  rendered conservatively and only the newly appended markdown is emitted,
  then the validated final result completes the render.
```

The branch steps carry the original `prompt`/`attachments` forward (the
`StagedReplySchema` superset of the reply), because the execute step still
needs them to brief the executor; the final steps strip them off again so the
workflow's output is just the reply.

### Configuration vs. code (`config/`)

Anything that's *configuration* — prose an author tunes, tunable limits, UI
copy, model selection — lives in `src/config/`, separate from the logic that
consumes it. The agents and tools import from there and never carry literals
inline.

| File                         | Holds                                                          |
| ---------------------------- | ------------------------------------------------------------- |
| `config/agents/*.md`         | One agent per file: frontmatter (id, name, description, capability weights, tools) + the system prompt |
| `config/models/*.md`         | One registered model per file: frontmatter (id, provider, model name, capability scores) + a note on its strengths |
| `config/tools/*.md`          | One tool per file: frontmatter (name, displayName, lmTool id, sideEffecting, optional previewArg - the argument shown for a call in the execution transcript) + the model-facing description |
| `config/agents.ts`           | Loads the agent files, validates the frontmatter, exports typed `agents` |
| `config/models.ts`           | Discovers the model files, exports the registry and the capability-based `selectModel` |
| `config/tools.ts`            | Discovers the tool files, exports `toolConfigs`/`toolNames` and the prompt-section renderer |
| `config/frontmatter.ts`      | Minimal parser for the frontmatter subset the config files use |
| `config/settings.ts`         | Operational limits: run timeout/output buffer, read cap, search caps + excludes, truncation, and the executor's loop/preview caps (`executor.maxSteps`, transcript input/result preview lengths). The Ollama endpoint, run timeout, and search caps are read live from the `myDevTeam.*` VS Code settings (see [User settings](#user-settings-contributesconfiguration)); the rest are compile-time constants |
| `config/messages.ts`         | Progress labels, error text, startup warnings, and reply markdown templates |

**Agents, models, and tools are real `.md` files with frontmatter.** esbuild's
text loader inlines them into the bundle at build time (see `esbuild.mjs`), so
each config lives in its own editable file but ships as a plain string — no
runtime file I/O. The model and tool folders are **discovered, not listed**: a
`glob:./models/*.md` import (expanded by the `md-glob` plugin in `esbuild.mjs`,
with `md-glob.mjs` shared by the matching Vitest plugin) resolves to the
contents of every `.md` file in the folder, in filename order — dropping a new
config file in registers it with no code change. `config/markdown.d.ts`
declares both module types (`*.md` as a string, `glob:*` as a string[]).
Agents stay on explicit imports because `agents.triage`/`agents.planner` are
statically typed keys used across the code.

The frontmatter carries everything an agent needs besides its prose: its `id`,
`name`, `description`, the weighted **capability requirements** that drive
model selection, and the list of **tools** it may plan with. Prompts never
hardcode tool descriptions — the `{{tools}}` placeholder in the prompt body is
replaced with a section rendered from the tool configs, so adding a tool to an
agent is a one-line frontmatter change. The planner's `tool` enum in its output
schema is derived from the same registry, so the prompt and the schema can
never drift apart.

### User settings (`contributes.configuration`)

The runtime knobs an end user may need to turn are real VS Code settings
(Settings UI → "My Dev Team", or `settings.json`), declared in `package.json`
and read **live** by `config/settings.ts` on every access - no reload needed:

| Setting                              | Default                  | Controls                                  |
| ------------------------------------ | ------------------------ | ----------------------------------------- |
| `myDevTeam.ollama.endpoint`          | `http://localhost:11434` | Ollama server origin (no `/api` suffix)   |
| `myDevTeam.run.commandTimeoutMs`     | `60000`                  | `run` tool shell-command timeout (ms)     |
| `myDevTeam.search.globMaxResults`    | `200`                    | Max files a glob search returns           |
| `myDevTeam.search.contentScanLimit`  | `500`                    | Max files a content search scans          |
| `myDevTeam.search.contentMaxMatches` | `50`                     | Max matches before a content search stops |

Invalid values (wrong type, non-positive numbers, an endpoint that is not an
http(s) URL) silently fall back to the defaults, so the tools always see sane
limits. The endpoint is the **single source of truth**: the provider wiring
(`createOllama({ baseURL })` in `core/models.ts`), the troubleshooting hint in
chat errors, and the activation health check all derive from
`settings.ollamaEndpoint`, so they can never disagree. Changing the endpoint
mid-session rebuilds the provider and drops the memoised model instances; the
next request talks to the new server. Everything not listed above
(buffer/truncation caps, search excludes) stays a compile-time constant in
`config/settings.ts`.

On activation the extension pings `<endpoint>/api/tags`
(`ui/startupCheck.ts`, 3s timeout, never blocks activation) and shows a
warning if the server is unreachable or one of the router-selected models is
not pulled - instead of letting the first chat request be the thing that
fails.

### Capability-based model router (`config/models.ts` + `core/models.ts`)

Agents never name a concrete model. Instead:

- **Registered models** (`config/models/*.md`) score how good each model is at
  a set of capabilities — `reasoning`, `coding`, `classification`, `planning`,
  `speed`, `structured-output` — each 0–1.
- **Agents** (`config/agents/*.md`) declare the same capabilities as
  *weights*: how much each one matters to that agent.
- `selectModel` (`config/models.ts`) picks the registered model with the
  highest weighted score (Σ weight × score; an unscored capability counts
  as 0), and `resolveModel` (`core/models.ts`) wires the winner onto an
  [AI SDK](https://sdk.vercel.ai) provider instance built from the configured
  `myDevTeam.ollama.endpoint`, memoised per model and endpoint.

Retune an agent by editing its weights, and upgrade the whole system by
registering a stronger model — no agent code changes either way. Only register
models that are actually available (pulled in Ollama): selection assumes every
registered model can run.

| Agent      | Weights (what it cares about)                                | Currently selects |
| ---------- | ------------------------------------------------------------ | ----------------- |
| `triage`   | classification 1, speed 0.8, structured-output 0.5           | Ollama `qwen3:8b` |
| `planner`  | planning 1, reasoning 0.8, structured-output 0.6, speed 0.3  | Ollama `qwen3:14b`|
| `answerer` | reasoning 1, speed 0.9                                       | Ollama `qwen3:8b` |
| `executor` | coding 1, reasoning 0.7, speed 0.3                           | Ollama `qwen3-coder` |

```yaml
# config/models/qwen3-14b.md — a registered model (scores):
id: qwen3-14b
provider: ollama
model: qwen3:14b
capabilities:
  reasoning: 0.75
  planning: 0.8
  speed: 0.6
  # …

# config/agents/planner.md — an agent's requirements (weights):
capabilities:
  planning: 1
  reasoning: 0.8
  structured-output: 0.6
  speed: 0.3
```

```ts
// core/triage.ts / core/planner.ts — the dynamic wiring:
model: resolveModel(agents.planner.capabilities),

// …and how a paid provider would slot in later: add it to the registry's
// provider enum and a factory in core/models.ts:
//   import { createAnthropic } from '@ai-sdk/anthropic';
//   const anthropic = createAnthropic({ apiKey: /* … */ });
//   const factories = { ollama: …, anthropic: (model) => anthropic(model) };
```

### Executor (`core/executor.ts` + `tools/agentTools.ts`)

The executor is the step that turns a drafted plan into actual work. Design
decisions, in the order they matter:

- **Mastra drives the loop, not hand-rolled control flow.** The `Executor`
  wraps a Mastra `Agent` constructed with `tools: buildAgentTools(approver)`
  and calls `agent.stream(prompt, { maxSteps: settings.executor.maxSteps })`.
  Mastra handles the model→tool-calls→results→model iteration; the step cap
  bounds a runaway loop. The executor itself only *observes* the run.
- **Briefing.** The executor's prompt (`executionPrompt` in
  `core/workflow.ts`) is the full request - prompt plus inlined attachment
  text, exactly what the planner saw - followed by a `--- Drafted plan ---`
  section: the plan summary and the numbered steps with their tool hints
  (`1. Find the file (tool: search) - locate it`; a `none` hint is a schema
  artifact and is omitted). The plan is guidance, not a script: the system
  prompt tells the model to follow it in order but skip steps already covered
  by earlier results.
- **The product is a transcript.** `Executor.execute` drains the run's
  `fullStream` of chunks and folds them into an ordered list of events
  (`ExecutionSchema`): `text` events (the model's commentary and final
  report, accumulated from `text-delta` chunks) interleaved with `tool`
  events (`tool-call` chunks open one with the tool name and an input
  preview - the value of the tool's configured `previewArg`, e.g. just the
  file path for `write`, falling back to compact args JSON for tools without
  one; the matching `tool-result`/`tool-error` chunk - correlated by
  `toolCallId` - completes it with a result preview and a `failed` flag).
  Order is preserved because "searched, then wrote, then reported" *is* the
  answer. Previews are bounded (`settings.executor.*PreviewMaxChars`): the
  model saw the full values, the transcript only shows the user what
  happened. A run-level `error` chunk throws, failing the workflow step so
  the UI renders the executor error with the Ollama hint.
- **Streaming snapshots.** Like the planner's partial plans, the executor
  forwards grow-only snapshots to an optional `onPartial` callback: events
  are only appended, and only the last event still changes (a text event
  grows, a tool event gains its result). Each emission is a shallow copy, so
  a sink sees the state as of that moment, not a live view. Draining the
  stream is what drives the loop, so it runs even with no listener.
- **Rendering.** `renderReply` appends an `**Execution:**` section after the
  (now complete, so unconservatively rendered) plan. Each event's markdown is
  itself append-only - the call line is emitted when the call starts and the
  result suffix when it lands - so successive renders stay prefix-extensions
  of each other, which is exactly what the append-only `ReplyStreamer`
  needs. A tool call still awaiting its result ends a partial render.
  Previews are flattened to one backtick-safe line; an empty result renders
  as `(no output)`.
- **Approvals are unchanged.** `agentTools.ts` wraps the same
  `workspaceTools.ts` implementations the editor-wide registrations use, so
  `run` and `write` invoke the same `Approver` with the same command echo /
  before-after preview. A decline is not an error: the tool returns the
  "not approved" message and the system prompt tells the model to skip that
  action and note it in the report.

### Tools (`tools/`)

Declared in `package.json` under `contributes.languageModelTools` and
registered with `vscode.lm.registerTool` in `registerTools.ts`. The
implementations in `workspaceTools.ts` are UI-agnostic, and they are exposed
on **two surfaces** that share them: `registerTools.ts` adapts them to the
Language Model Tools API (so any tool-calling chat model in the editor can
invoke them), and `agentTools.ts` adapts the same functions to Mastra
`createTool()`s with zod input schemas mirroring the package.json
contribution - that is the toolset the executor's tool-calling loop runs
over. Either way the same Approver gates the same side effects.

| Tool                   | Effect                          | Approval        |
| ---------------------- | ------------------------------- | --------------- |
| `devteam__read`        | Read a file's text              | none (read-only)|
| `devteam__search`      | Glob file names or grep content | none (read-only)|
| `devteam__run`         | Run a shell command (configurable timeout, 60s default) | **Approver** |
| `devteam__write`       | Create/overwrite a file         | **Approver**    |

The tools treat their inputs as untrusted (they are callable by any
tool-calling chat model in the editor, not just `@devteam`):

- `read`/`write` resolve paths against the workspace root and **reject
  anything that escapes it** (absolute paths, `..` traversal); `read` also
  caps how much text it returns.
- `search` never scans `node_modules`, `.git`, `dist`, `out`, or `coverage`,
  and content mode skips binary and oversized files (see
  `config/settings.ts` for the limits; the result/scan caps are user-tunable
  via the `myDevTeam.search.*` settings).
- `run` executes with a configured timeout (`myDevTeam.run.commandTimeoutMs`;
  the whole spawned process tree is killed, also on Windows) and output
  buffer; a failed command's stdout and stderr are returned so a caller can
  diagnose it.

Side-effecting tools call `approver.confirm(title, detail)`. The Phase-1
`ChatApprover` renders the proposed action into the chat panel followed by
**Approve / Decline buttons** (wired through the `myDevTeam.approval`
command) and blocks the tool until one is clicked; a finished or cancelled
request declines whatever is still pending so a run can never hang on an
unanswered question. When a tool is invoked outside a `@devteam` turn (they
are registered editor-wide, so any chat model can call them) there is no
stream to ask in, and the approver falls back to a modal dialog. The
`writeFile` tool builds a current/proposed preview so the approval question
shows what will change.

## Current behavior

On activation, the extension pings the configured Ollama endpoint and warns
(once, non-blocking) if the server is down or a router-selected model is not
pulled.

Out of the box, `@devteam <prompt>`:

1. Resolves any attached files/selections into labelled attachments and starts
   a run of the dev-team workflow with them alongside the prompt.
2. Streams "Understanding your request…" when the triage step starts.
3. Triages the prompt as `oneshot` or `planning` via the capability-routed
   local Ollama model (currently `qwen3:8b`) - this stays a buffered
   structured-output call, since its whole product is a small validated
   object. The boundary is the deliverable, not the difficulty: requests
   whose product is text in the chat are `oneshot`; anything that should
   create or modify workspace files - even one small new file that needs no
   exploration - is `planning`, so it reaches the executor and its `write`
   tool. Triage sees only the attachment labels (e.g. `File: src/a.ts`),
   not their contents: the routing decision does not need file text, and on a
   small local model a large attachment would crowd out the question. The
   planner and answerer get the full attachment text inlined.
4. Renders the **detected intent and reason** back to the panel as soon as
   triage completes, without waiting for the rest of the run.
5. For `oneshot` requests, streams "Answering…" and then **streams a real
   answer** - the answerer's routed model (currently `qwen3:8b`) replies in a
   single call with no tools, and the markdown answer appears incrementally
   behind an "**Answer:**" header as the model writes it. If a file-creating
   request slips through triage as `oneshot`, the answerer states it cannot
   write files and suggests rephrasing (e.g. "create the file X that ..."),
   while still showing the would-be content in a fenced block.
6. For `planning` requests, streams "Drafting a plan…" and then **streams the
   plan itself** - an ordered, tool-aware checklist (`summary` + at most 8
   numbered steps, each hinting which workspace tool it would use) appears
   incrementally while the planner's routed model (currently `qwen3:14b`)
   writes it. Plan steps describe the work and its requirements; they never
   carry full file contents - authoring the code is the executor's job (it is
   the routed coding specialist), though a step may pin down an interface
   with a short fragment. The partial-JSON snapshots are rendered conservatively so the
   already-emitted markdown is never revised, and the validated final result
   completes the reply.
7. Then streams "Executing the plan…" and **executes the plan**: the
   executor's routed model (currently `qwen3-coder`) is briefed with the full
   request plus the numbered plan and runs a Mastra tool-calling loop over
   `read`/`search`/`run`/`write` (up to `settings.executor.maxSteps`
   iterations). The transcript streams in behind an "**Execution:**" header
   as it happens: the model's commentary, one line per tool call showing its
   key argument (`- **write** \`calculator.py\``; tools without a configured
   `previewArg` fall back to compact args JSON) completed with a flattened,
   truncated result preview (`→ \`…\``, or `→ **failed** \`…\`` when the
   tool errored), and the executor's closing report of what changed.
8. Side effects still ask first: when the loop reaches a `run` or `write`
   call, the `ChatApprover` renders the command / file preview into the chat
   followed by Approve and Decline buttons and waits for the click. A
   cancelled request declines pending approvals automatically, and a tool
   invoked outside a `@devteam` turn falls back to a modal dialog. Declining
   does not abort the run - the tool returns "not approved" to the model,
   which is instructed to skip that action and carry on, noting the skip in
   its report.

The four workspace tools also stay registered with `vscode.lm`, callable by
any VS Code chat model that supports tool calling.

Cancelling the chat request cancels the workflow run (and with it the model
call) instead of letting it finish in the background; a cancelled turn stops
rendering immediately (plan content already streamed before the cancellation
stays visible, nothing more is added).

If Ollama is not reachable, the failed run is rendered with the step that
failed and a reminder to start Ollama (on the configured endpoint) with the
model the router selected for that agent pulled.

## Prerequisites

- **VS Code** ^1.95.0
- **Node.js** 20.x
- **[Ollama](https://ollama.com)** running locally, with the registered models
  pulled (the router assumes every model in `config/models/` can run):

  ```bash
  ollama serve                 # listens on http://localhost:11434
  ollama pull qwen3:8b         # currently selected for triage and the answerer
  ollama pull qwen3:14b        # currently selected for the planner
  ollama pull qwen3-coder      # currently selected for the executor
  ollama pull gemma3:4b        # registered fast fallback
  ```

  If your server listens elsewhere, set `myDevTeam.ollama.endpoint`; the
  activation health check will tell you if the endpoint or a routed model is
  missing.

## Run it

```bash
npm install
npm run build      # esbuild bundle -> dist/extension.js
# then press F5 in VS Code to launch the Extension Development Host
# (there is no launch.json yet — when F5 asks for a debugger,
#  pick "VS Code Extension Development")
```

In the dev window, open the Chat view (Ctrl+Alt+I) and type `@devteam hello`.
An `/explain` slash command is declared in `package.json`, but it has no
dedicated handling yet — its prompt flows through the same
triage → plan → execute workflow as any other message.

Scripts:

| Script                  | What it does                                                     |
| ----------------------- | --------------------------------------------------------------- |
| `npm run compile`       | Type-check / emit with `tsc`                                     |
| `npm run watch`         | `tsc` in watch mode                                             |
| `npm run build`         | Bundle to `dist/extension.js` via `esbuild.mjs` (alias of `package`) |
| `npm test`              | Run the Vitest unit suite once                                  |
| `npm run test:watch`    | Vitest in watch mode                                            |
| `npm run test:coverage` | Run the suite with a v8 coverage report                        |

### Tests

Unit tests live in `test/` and run on [Vitest](https://vitest.dev) in plain
Node — no editor required. The extension imports the `vscode` module (which only
exists inside a running editor), so `vitest.config.ts` aliases it to an
in-memory fake in `test/mocks/vscode.ts`; the fakes are real classes so the
source's `instanceof` checks still hold. The config also mirrors the bundle's
markdown handling: a `markdown-as-text` transform for plain `.md` imports and
an `md-glob` plugin (sharing `md-glob.mjs` with `esbuild.mjs`) for the
`glob:./dir/*.md` discovery imports. Mastra agents are stubbed so tests never
construct a model or reach Ollama. Coverage of the agent core, tools, UI
handler, and `config/` is comprehensive — run `npm run test:coverage` to see it.

## Tech stack

- **[Mastra](https://mastra.ai)** (`@mastra/core`) — agents (triage, planner, answerer, executor), the executor's tool-calling loop (`createTool` + `agent.stream` with `maxSteps`), and the orchestrating workflow
- **[Vercel AI SDK](https://sdk.vercel.ai)** (`ai`) — model interface
- **`ollama-ai-provider-v2`** — AI SDK provider for local Ollama models
- **`zod`** — structured-output schemas for the triage agent and planner, the executor's transcript and tool-input schemas, the workflow's step I/O schemas, and validation of the `.md` config frontmatter (agents, models, tools)
- **VS Code Chat + Language Model Tools APIs** — the front end and tool surface

## Roadmap

- **Use conversation history.** The handler ignores `ChatContext.history`, so
  every turn starts from scratch: "now rename it too" has no idea what "it"
  is. Fold prior turns into the workflow input (with a size cap like the
  attachment truncation); this would also make the `/explain` command
  meaningful.
- **Add a Webview front end.**
  1. Add a `WebviewApprover implements Approver` with a diff/confirm UI.
  2. Pass it instead of `ChatApprover` in `extension.ts`.
  3. Optionally add a Webview panel as a second front-end calling the same core.

  The agent core and tools require **no changes**.
- **Feedback telemetry.** `participant.onDidReceiveFeedback` currently logs
  👍/👎; forward it to telemetry/eval storage.

## License

Apache License 2.0 — see [LICENSE](LICENSE).
