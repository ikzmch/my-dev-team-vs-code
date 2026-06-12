# My Dev Team - design and architecture

The developer documentation for the My Dev Team VS Code extension: how the
agent pipeline, the engine protocol, the configuration system, and the tools
fit together, and how to build, run, and test it from source.

For what the extension is and why, start at [README.md](README.md); for the
end-user guide (setup, slash commands, approvals, settings), see
[QUICKSTART.md](QUICKSTART.md).

The agent routes each request through a **local triage agent** (Ollama via
the Vercel AI SDK + Mastra) before deciding how to respond. Agents don't name
models: each declares **weighted capability requirements**, and a router picks
the best match from a **registry of models scored per capability**, discovered
from `.md` config files at build time. The side-effecting
actions - running a command and writing or editing a file - are gated by an
**approval seam**, so the chat confirmation can later be swapped for a rich
Webview dialog **without touching the agent core**.

The whole agent pipeline sits behind an **engine protocol**
(`src/protocol/`): the UI starts a run, receives a stream of typed events,
and executes the tool calls the engine asks for - today against the
in-process **LocalEngine**, later against a remote backend speaking the same
contract (see [The engine protocol](#the-engine-protocol-srcprotocol)). A
`myDevTeam.engine` setting switches implementations without a reload.

> **Status:** the full pipeline is live - the routing layer (triage), the
> **planner**, the **oneshot answerer**, and the **executor**. The workflow
> classifies your request, answers `oneshot` questions directly, and for
> `planning` requests drafts a step-by-step plan and then **executes it**: the
> executor's capability-routed model drives a tool-calling loop over the five
> workspace tools, with side effects gated by the approval seam. Every turn
> carries the **conversation history** (size-capped), so follow-ups like
> "now rename it too" resolve against the earlier exchanges. Seven engine
> **slash commands** (`/explain`, `/review`, `/plan`, `/do`, `/fix`, `/test`,
> `/compact`) pin the route without a triage call and frame the request for
> the agents; `/plan` stops after the plan is drafted, `/compact` summarizes
> the conversation into a turn that replaces it, and a client-side `/clear`
> drops the history without starting a run. The pipeline now
> runs behind the engine protocol (Phase A of the backend split): only the
> local engine exists, but the seam, the event stream, the tool inversion,
> and the usage (billing) events are in place. See
> [Current behavior](#current-behavior) and [Roadmap](#roadmap).

## Architecture

```
src/
  extension.ts            entry point - wires tools + engine + UI together
  protocol/               the engine/client contract: wire-shaped, zod-validated, version-stamped
    types.ts              run request + reply data shapes and their streaming snapshots
    events.ts             the run event stream + ReplyFolder (folds events back into snapshots)
    toolContract.ts       client tool names, input schemas, lm ids, display names + the ToolHost seam
    engine.ts             the Engine port, RunClient/RunHandle, AuthProvider, run error types
  engine/                 the implementation a future backend hides - nothing above may import its internals
    localEngine.ts        in-process Engine: runs the workflow, translates progress into protocol events
    core/
      workflow.ts         Mastra workflow: triage -> plan -> execute | answer; per-run progress + usage sinks
      models.ts           provider wiring: turns the selected registry entry into an AI SDK model
      triage.ts           Mastra agent: triage request as oneshot | planning
      planner.ts          Mastra agent: draft an ordered, tool-aware plan, streamed as partial snapshots
      answerer.ts         Mastra agent: answer a oneshot request directly, streamed as accumulated text
      executor.ts         Mastra agent: walk the plan in a tool-calling loop, streamed as a transcript
      agentTools.ts       the executor's tool proxies: every call delegates to the client's ToolHost
      usage.ts            best-effort token-count extraction feeding the usage (billing) events
    config/
      agents/*.md         one agent per file: frontmatter + system prompt
      models/*.md         one registered model per file: provider, model id, capability scores
      tools/*.md          model-facing tool descriptions + transcript preview hints
      commands/*.md       one slash command per file: pinned route, execute flag + prompt preamble
      agents.ts           loads agents/*.md, renders the tools + environment sections, exports `agents`
      models.ts           discovers models/*.md, exports the registry + capability-based `selectModel`
      tools.ts            discovers tools/*.md, exports `toolConfigs` + `renderToolsSection`
      commands.ts         discovers commands/*.md, exports `commandConfigs` (route pinning + preambles)
      frontmatter.ts      minimal frontmatter parser for the .md config files
      markdown.d.ts       lets TS treat `*.md` and `glob:` imports as strings / string[]
  client/
    engineFactory.ts      the myDevTeam.engine switch: LocalEngine today, RemoteEngine in Phase B
    auth.ts               AuthProvider implementations (anonymous today; real credentials in Phase B)
    evalLog.ts            opt-in local JSONL eval store: per-run route/usage/outcome records + 👍/👎 feedback
  config/                 client-side configuration, kept out of the logic (see below)
    settings.ts           operational limits; engine/endpoint/timeout/search caps read live from VS Code settings
    messages.ts           user-facing chat copy (errors, warnings, templates)
    environment.ts        runtime OS/shell facts: fills prompt placeholders, picks the run tool's shell
    clientCommands.ts     the client-handled /clear command + the /compact history-replacement marker
  tools/                  the client's hands - these never move to a backend
    workspaceTools.ts     read / search / run / write / edit implementations (UI-agnostic)
    toolHost.ts           WorkspaceToolHost: validates + dispatches every tool call (engine or editor)
    registerTools.ts      registers the tools with vscode.lm, delegating to the same host
    types.ts              the client seams: Approver (approval) + RunMirror (run-command transparency)
  ui/
    chatParticipant.ts    chat handler: folds run events, streams the reply + Phase-1 ChatApprover
    runTerminal.ts        Phase-1 RunMirror: a read-only "Dev Team" terminal logging every run command live
    startupCheck.ts       activation health check: surfaces the selected engine's startup warnings
test/                     Vitest unit tests + an in-memory `vscode` mock
examples/                 one prompt file per triage route - the manual smoke suite for pipeline changes
esbuild.mjs               bundle build script: esbuild API + the md-glob plugin
md-glob.mjs               build-time `glob:./dir/*.md` expansion, shared with Vitest
```

Three layers, deliberately decoupled:

- **Engine** (`engine/`) is the brain: agents, prompts, the model router, the
  workflow. It knows nothing about VS Code UI surfaces, and nothing outside
  `engine/` imports its internals - only `engine/localEngine.ts` and the
  protocol. This import discipline *is* the future repo split: Phase B lifts
  `engine/` + `protocol/` out as the backend, and the extension keeps the rest.
- **Client** (`tools/`, `client/`, `ui/`) is the hands: the tool
  implementations, the approval gate, the run mirror, and the chat rendering
  all stay on the user's machine whichever engine runs. An engine can only
  ever *ask* for a side effect through the ToolHost.
- **Protocol** (`protocol/`) is the contract between them - see
  [The engine protocol](#the-engine-protocol-srcprotocol).
- **`Approver`** stays the approval seam. `ChatApprover` is Phase 1; a
  `WebviewApprover` implementing the same interface is Phase 2 - the tools
  never change. **`RunMirror`** is a second seam of the same shape: the `run`
  tool reports each executed command's lifecycle and live output to it, and
  the Phase-1 `TerminalRunMirror` (`ui/runTerminal.ts`) displays that as a
  read-only "Dev Team" terminal. Both are client seams: an engine never
  knows how approval or mirroring happened.

### Request flow

```
@devteam <prompt>
        │
        ▼
ui/chatParticipant.ts          resolve attached files/selections into labelled
  createHandler                attachments and the session's prior turns into
        │                      capped history turns, build a protocol
        │                      RunRequest (version, prompt, attachments,
        │                      history, environment facts, offered tools) and
        │                      start a run on whichever engine the provider
        │                      selects; fold the run's events back into reply
        │                      snapshots and stream each render's new suffix.
        │                      No custom progress labels - the chat shows VS
        │                      Code's standard "Thinking" indicator
        ▼
engine/localEngine.ts          the in-process engine: validates the request,
  startRun                     assembles the workflow (the executor bound to
        │                      the run's ToolHost), translates the workflow's
        │                      grow-only progress snapshots into protocol
        │                      events (triaged, plan-snapshot, answer-delta,
        │                      execution-event, usage, done/error), and maps
        │                      a failed step onto the protocol step + an
        │                      Ollama hint
        ▼
engine/core/workflow.ts        Mastra workflow (createWorkflow + createStep)
  triage                       ── Triage.classify(triagePrompt)
        │                         conversation so far + prompt + attachment
        │                         labels only (contents omitted: routing needs
        │                         no file text, and it would crowd a small
        │                         local model's context; the history stays in
        │                         because a follow-up cannot be routed
        │                         without the conversation it follows)
        │                         → { intent: "oneshot" | "planning", reason }
        │                         (model picked by the capability router; a
        │                         known slash command pins the intent without
        ▼                         the model call - see Slash commands)
      branch
        ├─▶ draft-plan         ── Planner.plan(fullPrompt, onPartial)  (intent = "planning")
        │                         conversation + prompt + full attachment text;
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
        │                         conversation + prompt + attachment text + the
        │                         numbered plan;
        │                         Mastra runs the tool-calling loop over the five
        │                         workspace tools (run/write/edit Approver-gated);
        │                         → { events[] } transcript (capability-routed model);
        │                         pushes every transcript snapshot to the sink
        └─▶ deliver-answer     ── pass-through for the oneshot path, so a oneshot
        │                         run never starts an executor step
        ▼
  the UI folds the run events back into grow-only snapshots (the protocol's
  ReplyFolder), renders each one conservatively, and emits only the newly
  appended markdown; the validated final reply completes the render.
```

The branch steps carry the original `prompt`/`attachments`/`history` forward
(the `StagedReplySchema` superset of the reply), because the execute step
still needs them to brief the executor; the final steps strip them off again
so the workflow's output is just the reply - which is the protocol's
`ReplySchema`, so the engine cannot produce a result the contract does not
describe.

### The engine protocol (`src/protocol/`)

Everything the extension knows about the agent pipeline goes through one
port, designed wire-shaped from day one so a remote backend can implement it
without the client changing:

- **`Engine.startRun(request, client)`** takes a versioned `RunRequest`
  (prompt, attachments, history, the client's OS/shell facts, and the names
  of the tools the client offers) plus a `RunClient` (an event sink and the
  ToolHost) and returns a `RunHandle` (`result` promise + `cancel()`).
- **Events, not callbacks**, carry the streaming reply: `triaged`,
  `plan-snapshot` (plans are small), `answer-delta`, `execution-event`
  (indexed, since only the transcript's last event ever changes), `usage`,
  and `done`/`error`. The client folds them back into grow-only snapshots
  with `ReplyFolder`, so rendering from events is pixel-identical to the old
  direct wiring - the property that makes local and remote engines
  indistinguishable. `tool-call`/`ToolResultMessage` are defined for the
  Phase-B wire; the LocalEngine calls the ToolHost in-process instead.
- **Tools are inverted.** The engine's executor never touches the workspace:
  its Mastra tools are proxies that delegate to the client's **`ToolHost`**
  (`tools/toolHost.ts`), which validates the arguments against the
  protocol's input schemas and runs the implementations - including the
  approval gate. A compromised or buggy engine can request a command or a
  file write, but it cannot land either without the user's click, and it
  never learns how approval happened. The tool contract (`protocol/toolContract.ts`) carries the
  client-facing half of each tool (input schema, `devteam__*` id, display
  name); the engine's configs keep the model-facing half (description,
  preview hints).
- **`usage` events are the billing seam.** Each workflow step reports its
  model call's token counts when the SDK exposes them (best-effort,
  engine-side `usage.ts`); the LocalEngine forwards them as events, and the
  chat handler currently logs them. Server-side, this same stream becomes
  the metering record.
- **`AuthProvider`** (`client/auth.ts`) supplies credentials per run -
  anonymous today; a VS Code auth session or stored API key slots in for the
  remote engine without touching the protocol.
- **Errors are protocol-shaped.** A failed run rejects with `RunFailedError`
  carrying the protocol step (`triage | plan | answer | execute`) and an
  engine-supplied hint (the LocalEngine names the routed model and the
  configured Ollama endpoint); cancellation rejects with `RunCancelledError`.

The **`myDevTeam.engine`** setting (read live per request,
`client/engineFactory.ts`) selects the implementation: `local` runs the
in-process engine; `remote` warns once and falls back to local until the
Phase-B RemoteEngine exists.

**Conversation history.** The handler converts `ChatContext.history` into the
workflow's `history` turns: this participant's exchanges only (a request turn
becomes a `User:` turn, with its slash command restored; a response turn's
markdown parts become an `Assistant:` turn), capped by `settings.history` -
each turn truncated to `maxTurnChars` (2 000) and only the `maxTurns` (10)
most recent kept - so a long session can never crowd a small local model's
context window. The workflow renders the turns as a delimited
`--- Conversation so far ---` section in front of every agent prompt, so a
follow-up like "now rename it too" carries the turns that say what "it" is,
and triage can route it correctly. Each agent's system prompt explains the
section: it is context to resolve references, not work to redo.

Two commands manage this history, and because the history is client state
(the engine is stateless and receives it per request), their rules live in
the handler's collection, not in the engine: a `/clear` request turn resets
the collection - neither the turns before it, the marker, nor its
confirmation reach future prompts; a **successful** `/compact` response also
resets it but keeps itself, so the summary becomes the sole opening assistant
turn standing in for everything it summarized. The handler stamps each turn's
chat result metadata with the run's `outcome`, and only an `ok` compact is
trusted - a failed or cancelled one is skipped entirely, never wiping the
history it failed to summarize.

### Configuration vs. code (`config/`)

Anything that's *configuration* - prose an author tunes, tunable limits, UI
copy, model selection - lives apart from the logic that consumes it, split
along the engine/client boundary: prompt material and the model registry in
`src/engine/config/` (a future backend's assets), limits and chat copy in
`src/config/` (the client's). The agents and tools import from there and
never carry literals inline.

| File                            | Holds                                                          |
| ------------------------------- | ------------------------------------------------------------- |
| `engine/config/agents/*.md`     | One agent per file: frontmatter (id, name, description, capability weights, tools) + the system prompt |
| `engine/config/models/*.md`     | One registered model per file: frontmatter (id, provider, model name, capability scores) + a note on its strengths |
| `engine/config/tools/*.md`      | The model-facing half of one tool per file: frontmatter (name, sideEffecting, optional previewArg - the argument shown for a call in the execution transcript, optional snippetArg - the argument whose first lines render as a snippet under the call, e.g. write's contents) + the model-facing description. The client-facing half (input schema, `devteam__*` id, display name) lives in `protocol/toolContract.ts` |
| `engine/config/commands/*.md`   | One slash command per file: frontmatter (name, description, the pinned `intent`, `execute: false` for plan-only) + a preamble rendered ahead of the user's prompt for the downstream agents. The same name + description pairs must be declared in `package.json` (`contributes.chatParticipants[].commands`) for autocomplete; a unit test keeps the two lists in sync |
| `engine/config/agents.ts`       | Loads the agent files, validates the frontmatter, exports typed `agents` |
| `engine/config/models.ts`       | Discovers the model files, exports the registry and the capability-based `selectModel` |
| `engine/config/tools.ts`        | Discovers the tool files, exports `toolConfigs`/`toolNames` and the prompt-section renderer |
| `engine/config/commands.ts`     | Discovers the command files, exports `commandConfigs`/`commandNames` and the pinned-route reason |
| `engine/config/frontmatter.ts`  | Minimal parser for the frontmatter subset the config files use |
| `config/environment.ts`         | Runtime environment facts (OS name, shell): substituted into `{{os}}`/`{{shell}}` tool-description placeholders and the agents' `{{environment}}` prompt section, sent to the engine in every run request, and the shell the `run` tool spawns (PowerShell on Windows, `/bin/sh` elsewhere) - one source so the prompts and the actual shell can never disagree |
| `config/settings.ts`            | Operational limits: run timeout/output buffer, the run-mirror terminal's backlog cap, read cap, search caps + excludes, truncation, the conversation-history caps (`history.maxTurns`, `history.maxTurnChars`), and the executor's loop/preview caps (`executor.maxSteps`, transcript input/result preview lengths, the write-snippet line count). The engine choice, Ollama endpoint, run timeout, search caps, and snippet line count are read live from the `myDevTeam.*` VS Code settings (see [User settings](#user-settings-contributesconfiguration)); the rest are compile-time constants |
| `config/messages.ts`            | Error text, startup warnings, reply markdown templates, the engine-switch warning, the Ollama-hint template the LocalEngine fills in, the /clear confirmation, and the run-mirror terminal's copy (tab name, command header, outcome note). Knows nothing about agents or models - which model is routed where is engine knowledge that reaches the UI only as a protocol error's `hint` |
| `config/clientCommands.ts`      | The client-handled commands (`/clear`, with its autocomplete description) plus the `/compact` marker name the history collection watches for - client-side because conversation history is client state. The commands unit test keeps these, the engine registry, and `package.json` in sync |

**Agents, models, and tools are real `.md` files with frontmatter.** esbuild's
text loader inlines them into the bundle at build time (see `esbuild.mjs`), so
each config lives in its own editable file but ships as a plain string - no
runtime file I/O. The model and tool folders are **discovered, not listed**: a
`glob:./models/*.md` import (expanded by the `md-glob` plugin in `esbuild.mjs`,
with `md-glob.mjs` shared by the matching Vitest plugin) resolves to the
contents of every `.md` file in the folder, in filename order - dropping a new
config file in registers it with no code change. `engine/config/markdown.d.ts`
declares both module types (`*.md` as a string, `glob:*` as a string[]).
Agents stay on explicit imports because `agents.triage`/`agents.planner` are
statically typed keys used across the code.

The frontmatter carries everything an agent needs besides its prose: its `id`,
`name`, `description`, the weighted **capability requirements** that drive
model selection, and the list of **tools** it may plan with. Prompts never
hardcode tool descriptions - the `{{tools}}` placeholder in the prompt body is
replaced with a section rendered from the tool configs, so adding a tool to an
agent is a one-line frontmatter change. The planner's `tool` enum in its output
schema is derived from the same registry, so the prompt and the schema can
never drift apart.

Prompts never hardcode a platform either. The planner and executor prompts
carry an `{{environment}}` placeholder, and the `run` tool's description
carries `{{os}}`/`{{shell}}`; both are filled at load time from
`config/environment.ts`, which derives the facts from the actual host
(`process.platform`). The model is told it is on Windows writing PowerShell
(or on macOS/Linux writing POSIX sh) instead of defaulting to Linux commands,
and the same module supplies the shell the `run` tool spawns, so what the
prompts announce is always what executes.

### User settings (`contributes.configuration`)

The runtime knobs an end user may need to turn are real VS Code settings
(Settings UI → "My Dev Team", or `settings.json`), declared in `package.json`
and read **live** by `config/settings.ts` on every access - no reload needed:

| Setting                              | Default                  | Controls                                  |
| ------------------------------------ | ------------------------ | ----------------------------------------- |
| `myDevTeam.engine`                   | `local`                  | Which engine handles `@devteam` runs: `local` (in-process) or `remote` (Phase B; warns and falls back to local until it exists) |
| `myDevTeam.ollama.endpoint`          | `http://localhost:11434` | Ollama server origin (no `/api` suffix)   |
| `myDevTeam.run.commandTimeoutMs`     | `60000`                  | `run` tool shell-command timeout (ms)     |
| `myDevTeam.read.maxLines`            | `200`                    | Max lines one `read` call returns; partial results name the range and total so the model continues |
| `myDevTeam.search.globMaxResults`    | `200`                    | Max files a glob search returns           |
| `myDevTeam.search.contentScanLimit`  | `500`                    | Max files a content search scans          |
| `myDevTeam.search.contentMaxMatches` | `50`                     | Max matches before a content search stops |
| `myDevTeam.chat.toolSnippetLines`    | `5`                      | Leading lines of a written file (or an edit's replacement text) shown under a `write`/`edit` call in the transcript (`0` hides the snippet) |
| `myDevTeam.telemetry.evalLog`        | `false`                  | Opt-in local eval log: store per-run route/usage/outcome records and 👍/👎 feedback as JSON lines in extension storage (no prompt or reply text; nothing leaves the machine) |

Invalid values (wrong type, non-positive numbers, an endpoint that is not an
http(s) URL) silently fall back to the defaults, so the tools always see sane
limits. The endpoint is the **single source of truth**: the provider wiring
(`createOllama({ baseURL })` in `engine/core/models.ts`), the troubleshooting
hint in chat errors, and the activation health check all derive from
`settings.ollamaEndpoint`, so they can never disagree. Changing the endpoint
mid-session rebuilds the provider and drops the memoised model instances; the
next request talks to the new server. Everything not listed above
(buffer/truncation caps, search excludes) stays a compile-time constant in
`config/settings.ts`.

On activation the extension asks the selected engine for startup warnings
(`Engine.startupWarnings`, surfaced by `ui/startupCheck.ts`, never blocks
activation): the LocalEngine pings `<endpoint>/api/tags` (3s timeout) and
reports an unreachable server or a router-selected model that is not
pulled - instead of letting the first chat request be the thing that fails.

### Capability-based model router (`engine/config/models.ts` + `engine/core/models.ts`)

Agents never name a concrete model. Instead:

- **Registered models** (`engine/config/models/*.md`) score how good each model is at
  a set of capabilities - `reasoning`, `coding`, `classification`, `planning`,
  `speed`, `structured-output` - each 0-1.
- **Agents** (`engine/config/agents/*.md`) declare the same capabilities as
  *weights*: how much each one matters to that agent.
- `selectModel` (`engine/config/models.ts`) picks the registered model with
  the highest weighted score (Σ weight × score; an unscored capability counts
  as 0), and `resolveModel` (`engine/core/models.ts`) wires the winner onto an
  [AI SDK](https://sdk.vercel.ai) provider instance built from the configured
  `myDevTeam.ollama.endpoint`, memoised per model and endpoint.

Retune an agent by editing its weights, and upgrade the whole system by
registering a stronger model - no agent code changes either way. Only register
models that are actually available (pulled in Ollama): selection assumes every
registered model can run.

| Agent      | Weights (what it cares about)                                | Currently selects |
| ---------- | ------------------------------------------------------------ | ----------------- |
| `triage`   | classification 1, speed 0.8, structured-output 0.5           | Ollama `qwen3:8b` |
| `planner`  | planning 1, reasoning 0.8, structured-output 0.6, speed 0.3  | Ollama `qwen3:14b`|
| `answerer` | reasoning 1, speed 0.9                                       | Ollama `qwen3:8b` |
| `executor` | coding 1, reasoning 0.7, speed 0.3                           | Ollama `qwen3-coder` |

```yaml
# engine/config/models/qwen3-14b.md - a registered model (scores):
id: qwen3-14b
provider: ollama
model: qwen3:14b
capabilities:
  reasoning: 0.75
  planning: 0.8
  speed: 0.6
  # …

# engine/config/agents/planner.md - an agent's requirements (weights):
capabilities:
  planning: 1
  reasoning: 0.8
  structured-output: 0.6
  speed: 0.3
```

```ts
// engine/core/triage.ts / engine/core/planner.ts - the dynamic wiring:
model: resolveModel(agents.planner.capabilities),

// …and how a paid provider would slot in later: add it to the registry's
// provider enum and a factory in engine/core/models.ts:
//   import { createAnthropic } from '@ai-sdk/anthropic';
//   const anthropic = createAnthropic({ apiKey: /* … */ });
//   const factories = { ollama: …, anthropic: (model) => anthropic(model) };
```

### Slash commands (`engine/config/commands/` + `engine/config/commands.ts`)

`@devteam` offers eight slash commands - seven **engine commands** and one
**client command** (`/clear`, see below). Each engine command is a `.md`
config file (discovered like the models and tools - dropping a file in
registers the command) that does exactly two things:

- **Pins the route.** A known command skips the triage model call entirely:
  the user typing `/fix` already *is* the routing decision, so the call would
  only add latency and a chance to misroute. The workflow returns the
  command's `intent` with the reason `Requested via /<name>.`, rendered where
  the model's reason would be - the UI needs no special case. `/plan`
  additionally carries `execute: false`, so the run stops after the plan is
  drafted. Every command-pinned run is also a labelled example of what triage
  *should* have decided - the eval log records the command per run, so triage
  accuracy can be measured against it.
- **Frames the request.** The file's markdown body is a preamble rendered
  ahead of the user's prompt for the planner, answerer, and executor (after
  the conversation section, before the attachments) - e.g. `/fix` briefs the
  agents to diagnose the root cause before editing.

| Command    | Route                  | What it does                                          |
| ---------- | ---------------------- | ----------------------------------------------------- |
| `/explain` | oneshot                | Explain a file, selection, or concept - no changes    |
| `/review`  | oneshot                | Review the attached code - findings in chat, no edits |
| `/plan`    | planning, plan-only    | Draft the plan and stop; the reply ends with a "nothing was executed" note. A follow-up ("go ahead") re-plans with the drafted plan in the conversation history and executes |
| `/do`      | planning               | Plan and execute - for when triage misrouting is the annoyance |
| `/fix`     | planning               | Diagnose first (read, search, run tests), fix the root cause, verify |
| `/test`    | planning               | Write or update tests for the target code, then run them |
| `/compact` | oneshot                | Summarize the conversation so far; once it succeeds, the summary replaces all earlier turns in future prompts (see below) |
| `/clear`   | client-side, no run    | Drop the conversation so far from future requests; the panel still shows it, the models no longer see it |

The command travels on the protocol as `RunRequest.command` - the name only.
What a command does is the engine's business; the client just relays what the
user typed, and an engine that does not know the name (version skew with a
Phase-B backend) treats the prompt as plain text, so unknown commands degrade
instead of breaking. VS Code's autocomplete reads the static declarations in
`package.json` (`contributes.chatParticipants[].commands`); a unit test
(`test/commands.test.ts`) asserts they match the discovered configs, so the
lists cannot drift.

**Context commands are the client's, not the engine's.** The "client only
relays names" rule holds for engine commands; `/clear` and `/compact`'s
history rule are the deliberate exception, because conversation history is
client-owned state - the engine is stateless and receives the history in
every run request. `/clear` (`config/clientCommands.ts`) never starts a run:
the handler answers it with a confirmation, and `collectHistory` drops every
turn before the marker on later requests. `/compact` *is* an engine command
(the answerer writes the summary through the normal oneshot path), but the
replacement effect is the client's: a successful compact response resets the
collected history to just the summary turn. Success is read from the turn's
result metadata (`TurnMetadata.outcome`), so a failed or cancelled compact
never wipes the history it failed to summarize - see
[Conversation history](#the-engine-protocol-srcprotocol). Auto-compaction is
deliberately absent: compacting spends tokens and changes what the models
see, so it only happens when the user asks.

### Executor (`engine/core/executor.ts` + `engine/core/agentTools.ts`)

The executor is the step that turns a drafted plan into actual work. Design
decisions, in the order they matter:

- **Mastra drives the loop, not hand-rolled control flow.** The `Executor`
  wraps a Mastra `Agent` constructed with `tools: buildAgentTools(toolHost)` -
  proxies that delegate every call to the client's ToolHost - and calls
  `agent.stream(prompt, { maxSteps: settings.executor.maxSteps })`.
  Mastra handles the model→tool-calls→results→model iteration; the step cap
  bounds a runaway loop. The executor itself only *observes* the run.
- **Briefing.** The executor's prompt (`executionPrompt` in
  `engine/core/workflow.ts`) is the full request - the conversation so far, the
  prompt, and the inlined attachment text, exactly what the planner saw -
  followed by a `--- Drafted plan ---` section: the plan summary and the numbered steps with their tool hints
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
  A tool with a configured `snippetArg` (write's `contents`, edit's
  `newText`) also records a `snippet`: the first `myDevTeam.chat.toolSnippetLines` lines of that
  argument (default 5, `0` turns snippets off), so the transcript can show
  the start of the file being written; when the file has more lines, the
  snippet ends in an `…(truncated)` line. Order is preserved because "searched,
  then wrote, then reported" *is* the answer. Previews are bounded
  (`settings.executor.*PreviewMaxChars`): the model saw the full values, the
  transcript only shows the user what happened. A run-level `error` chunk throws, failing the workflow step so
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
- **Approvals live in the host, not the engine.** The proxies delegate to
  the same `WorkspaceToolHost` the editor-wide registrations use, so `run`
  invokes the same `Approver` with the same command echo, `write` with the
  same path + contents preview, and `edit` with the same path + diff-style
  old/new preview - and the engine never learns how the
  decision was made. A decline is not an error: the tool returns the "not
  approved" message and the system prompt tells the model to skip that
  action and note it in the report.

### Tools (`tools/`)

Declared in `package.json` under `contributes.languageModelTools` and
registered with `vscode.lm.registerTool` in `registerTools.ts`. The
implementations in `workspaceTools.ts` are UI-agnostic, and every call -
from either surface - goes through the one `WorkspaceToolHost`
(`tools/toolHost.ts`), which validates the arguments against the protocol's
input schemas and dispatches: `registerTools.ts` registers each tool with
the Language Model Tools API delegating to the host (so any tool-calling
chat model in the editor can invoke them), and the engine's executor loop
reaches the same host through its tool proxies (`engine/core/agentTools.ts`).
Either way the same Approver gates the same side effects.

| Tool                   | Effect                          | Approval        |
| ---------------------- | ------------------------------- | --------------- |
| `devteam__read`        | Read a file's text, whole or a line range | none (read-only)|
| `devteam__search`      | Glob file names or grep content | none (read-only)|
| `devteam__run`         | Run a shell command (configurable timeout, 60s default) | **Approver** |
| `devteam__write`       | Create/overwrite a file         | **Approver**    |
| `devteam__edit`        | Replace text in an existing file | **Approver**   |

The tools treat their inputs as untrusted (they are callable by any
tool-calling chat model in the editor, not just `@devteam`):

- `read`/`write`/`edit` resolve paths against the workspace root and **reject
  anything that escapes it** (absolute paths, `..` traversal, and **symbolic
  links anywhere in the resolved path** - the target itself or any ancestor
  directory - since a link inside the workspace can point outside it).
- `read` returns at most **`myDevTeam.read.maxLines` lines per call** (plus a
  character backstop against enormous lines), so one read of a large file
  cannot flood a small model's context. An optional `startLine`/`endLine`
  pair selects a 1-based inclusive range; a partial result is prefixed with
  the range shown, the file's total line count (counted `wc -l` style), and
  the `startLine` to continue with, and the tool description tells the model
  it can count a file's lines with a `run` command first.
- `edit` replaces an **exact, unique match**: the given old text must match
  exactly one place in the file (a model that misremembers the file gets a
  recovery instruction - re-read, or add surrounding lines - instead of a
  corrupted file), it never creates files (that stays `write`'s job), and an
  LF/CRLF mismatch between the model's snippet and the file is bridged by
  adapting the snippet, never by rewriting the file's line endings. The
  replacement is literal: `$&`-style substitution patterns in code are not
  interpreted. After approval the file is **re-read and the match
  re-verified**, so an edit applies to the file as it is then - a change made
  while the prompt was open survives, and a vanished or no-longer-unique
  match returns the recovery message instead of writing a stale snapshot.
- `search` never scans `node_modules`, `.git`, `dist`, `out`, or `coverage`,
  and content mode skips binary and oversized files (see
  `config/settings.ts` for the limits; the result/scan caps are user-tunable
  via the `myDevTeam.search.*` settings).
- `run` executes with a configured timeout (`myDevTeam.run.commandTimeoutMs`)
  and output buffer; on expiry or cancellation the **whole spawned process
  tree** is killed (`taskkill /t` on Windows, a process-group signal to the
  detached child elsewhere), so grandchild processes never linger. A failed
  command's stdout and stderr are returned so a caller can diagnose it, and
  the model-facing result is capped (`settings.runResultMaxChars`, head and
  tail kept) so one chatty command cannot flood a small model's context.
  Commands run in the shell `config/environment.ts` announces to the model:
  **PowerShell on Windows** (its Unix-style aliases absorb residual
  `ls`/`cat` habits, and models write it more reliably than cmd.exe batch),
  the platform default `/bin/sh` elsewhere.
- every approved `run` command is also **mirrored live into a "Dev Team"
  terminal** (the `RunMirror` seam; `ui/runTerminal.ts`). The child process
  stays owned by the tool - capture, timeout, and kill-tree are unchanged -
  while the terminal shows a session log: a `$ command` header, the live
  stdout/stderr, and a one-line outcome. The terminal is created lazily on
  the first command and never steals focus; the user opens the "Dev Team"
  tab in the terminal panel to see it. Output is buffered (capped at
  `settings.runMirrorBacklogMaxChars`) and replayed when the terminal is
  first opened - or reopened after closing it - so the full history is
  visible whenever the user looks. Declined commands never ran, so they
  never appear.

The side-effecting tools call `approver.confirm(title, detail)`: `run` with
the command echo, `write` with the target path above a capped preview of the
new contents (`settings.writeApprovalPreviewMaxChars`), and `edit` with the
target path above a diff-style pair (the matched text prefixed `-`, its
replacement prefixed `+`, each side capped), so an in-workspace
change - itself destructive, with no undo - never lands silently. The
Phase-1 `ChatApprover` renders the proposed action into the chat panel
followed by **Approve / Decline buttons** (wired through the
`myDevTeam.approval` command) and blocks the tool until one is clicked. Each
request opens its own **approval session** for its stream; a finished or
cancelled request closes its session, declining only its own still-pending
approvals - so a run can never hang on an unanswered question, and
concurrent chat turns cannot settle (or write into the stream of) one
another's approvals. When a tool is invoked outside a `@devteam` turn (they
are registered editor-wide, so any chat model can call them) there is no
session to ask in, and the approver falls back to a modal dialog. A declined
`write` or `edit` returns "not approved" to the model and leaves the file
untouched.

## Current behavior

On activation, the extension asks the selected engine for startup warnings;
the local engine pings the configured Ollama endpoint and warns (once,
non-blocking) if the server is down or a router-selected model is not pulled.

Out of the box, `@devteam <prompt>`:

1. Resolves any attached files/selections into labelled attachments (an
   attached file beyond `settings.maxAttachmentReadBytes` becomes a too-large
   notice instead of being read) and the chat session's prior turns (your
   prompts and the participant's replies, capped per `settings.history`) into
   conversation history, and starts a
   protocol run on the selected engine (`myDevTeam.engine`, the in-process
   local engine by default) with both alongside the prompt. Follow-ups work:
   "now rename it too" reaches every agent with the turns that say what "it"
   is. A prior `/clear` cuts the history off at its marker, and a successful
   `/compact` replaces everything before it with its summary turn. While
   agents work, the chat shows VS Code's standard "Thinking"
   indicator - no custom progress labels are streamed. (`/clear` itself
   skips all of this: the handler confirms it in chat and starts no run.)
2. Triages the prompt as `oneshot` or `planning` via the capability-routed
   local Ollama model (currently `qwen3:8b`) - this stays a buffered
   structured-output call, since its whole product is a small validated
   object. A slash command (`/explain`, `/review`, `/plan`, `/do`, `/fix`,
   `/test`, `/compact` - see [Slash commands](#slash-commands-engineconfigcommands--engineconfigcommandsts))
   skips this call and pins the route directly, with `Requested via /<name>.`
   as the rendered reason. The boundary is the deliverable, not the difficulty: requests
   whose product is text in the chat are `oneshot`; anything that should
   create or modify workspace files - even one small new file that needs no
   exploration - is `planning`, so it reaches the executor and its `write`
   tool. Triage sees the conversation so far (a follow-up cannot be routed
   without it) but only the attachment labels (e.g. `File: src/a.ts`), not
   their contents: the routing decision does not need file text, and on a
   small local model a large attachment would crowd out the question. The
   planner and answerer get the full attachment text inlined.
3. Renders the **detected intent and reason** back to the panel as soon as
   triage completes, without waiting for the rest of the run.
4. For `oneshot` requests, **streams a real
   answer** - the answerer's routed model (currently `qwen3:8b`) replies in a
   single call with no tools, and the markdown answer appears incrementally
   behind an "**Answer:**" header as the model writes it. If a file-creating
   request slips through triage as `oneshot`, the answerer states it cannot
   write files and suggests rephrasing (e.g. "create the file X that ..."),
   while still showing the would-be content in a fenced block.
5. For `planning` requests, **streams the
   plan itself** - an ordered, tool-aware checklist (`summary` + at most 8
   numbered steps, each hinting which workspace tool it would use) appears
   incrementally while the planner's routed model (currently `qwen3:14b`)
   writes it. Plan steps describe the work and its requirements in plain
   prose; they never carry code of any kind (no file contents, no snippets) -
   authoring the code is the executor's job (it is the routed coding
   specialist). The partial-JSON snapshots are rendered conservatively so the
   already-emitted markdown is never revised, and the validated final result
   completes the reply.
6. Then **executes the plan**: the
   executor's routed model (currently `qwen3-coder`) is briefed with the full
   request plus the numbered plan and runs a Mastra tool-calling loop over
   `read`/`search`/`run`/`write`/`edit` (up to `settings.executor.maxSteps`
   iterations). The executor changes an existing file with `edit` (an exact,
   unique text replacement; on a failed or ambiguous match the tool answers
   with a recovery instruction instead of touching the file) and uses `write`
   for new files and full rewrites. The planner and executor prompts state the host OS and shell
   (from `config/environment.ts`), so `run` commands are written for the
   machine they execute on - PowerShell on Windows - instead of defaulting
   to Linux commands. The transcript streams in behind an "**Execution:**" header
   as it happens: the model's commentary, one line per tool call leading with
   the tool's display name from the protocol's tool contract (no bullet) and its
   key argument (`**Write File** \`calculator.py\``; tools without a configured
   `previewArg` fall back to compact args JSON) completed with a flattened,
   truncated result preview (`→ \`…\``, or `→ **failed** \`…\`` when the
   tool errored), and the executor's closing report of what changed. A
   completed `write` call additionally shows the first lines of the written
   file (and an `edit` call the first lines of its replacement text) in a
   fenced snippet under its line (`myDevTeam.chat.toolSnippetLines`,
   default 5; `0` hides it); longer content ends in an `…(truncated)` line.
7. Side effects still ask first: when the loop reaches a `run` call the
   `ChatApprover` renders the command into the chat, and when it reaches a
   `write` call it renders the target path above a capped preview of the new
   contents (`settings.writeApprovalPreviewMaxChars`); an `edit` call renders
   the path above a diff-style old/new pair. Each is followed by
   Approve and Decline buttons, and waits for the click. A cancelled request
   declines pending approvals automatically, and a tool invoked outside a
   `@devteam` turn falls back to a modal dialog. Declining does not abort the
   run - the tool returns "not approved" to the model, which is instructed to
   skip that action and carry on, noting the skip in its report; a declined
   `write` or `edit` leaves the file untouched.
8. Every approved command's real output also streams into the **"Dev Team"
   terminal** in the terminal panel: open the tab to watch commands run live,
   or later to read the session log of everything the agent executed
   (replayed in full when the terminal is opened). The chat transcript keeps
   showing only the truncated previews.

The five workspace tools also stay registered with `vscode.lm`, callable by
any VS Code chat model that supports tool calling - every call goes through
the same `WorkspaceToolHost` validation and approval gate the engine uses.

Each step's model call also emits a protocol `usage` event (model + token
counts when the SDK reports them); the chat handler logs them to the console
and collects them per run - the data the future backend's billing meters.
With `myDevTeam.telemetry.evalLog` enabled (it is off by default), every
finished run lands as one JSON line in an `eval-log.jsonl` under the
extension's global storage - run id, slash command, triage route, outcome,
and the collected per-step usage - and every 👍/👎 click on a reply is
recorded next to it, paired with its run through the turn's chat result
metadata, so routing and prompt changes can be measured against real feedback
per token spent. The records carry no prompt text, file contents, or reply
text, and the log never leaves your machine.

Cancelling the chat request cancels the engine run (and with it the model
call) instead of letting it finish in the background; a cancelled turn stops
rendering immediately (plan content already streamed before the cancellation
stays visible, nothing more is added). The cancellation also reaches the
executor's tool loop through an `AbortSignal`: an in-flight `run` command has
its process tree killed and a pending `write` or `edit` is dropped rather than
landing on disk, so a cancel is honoured end to end and not just at the next
step.

If Ollama is not reachable, the failed run is rendered with the step that
failed (delivered as a protocol `RunFailedError`) and an engine-supplied
hint reminding you to start Ollama (on the configured endpoint) with the
model the router selected for that agent pulled.

## Prerequisites

- **VS Code** ^1.95.0
- **Node.js** 20.x
- **[Ollama](https://ollama.com)** running locally, with the registered models
  pulled (the router assumes every model in `engine/config/models/` can run):

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
# (there is no launch.json yet - when F5 asks for a debugger,
#  pick "VS Code Extension Development")
```

In the dev window, open the Chat view (Ctrl+Alt+I) and type `@devteam hello`.
Type `/` after
`@devteam` to pick a slash command (`/explain`, `/review`, `/plan`, `/do`,
`/fix`, `/test`, `/compact`, `/clear`): a command pins the route without a
triage call and frames the request for the agents, and the context commands
manage what history later requests carry - see
[Slash commands](#slash-commands-engineconfigcommands--engineconfigcommandsts).
Commands work in follow-ups too: the conversation history gives
"/explain what you just did" a real referent (and prior command turns keep
their slash command when they are folded into later prompts).

### Manual smoke tests (`examples/`)

The unit suite never talks to a model, so changes to anything the models
actually see - an agent prompt, a tool description, capability weights, the
triage boundary, a new slash command - need a manual pass against real
Ollama models. [`examples/`](examples/README.md) is that pass: one file of
copy-pasteable prompts per pipeline path, each targeting one triage route:

| File | Route | Exercises |
| --- | --- | --- |
| [`oneshot.md`](examples/oneshot.md) | `oneshot` | The answerer: a direct streamed answer, no tools |
| [`planning-simple.md`](examples/planning-simple.md) | `planning` | Plan + execution with little or no workspace exploration |
| [`planning-advanced.md`](examples/planning-advanced.md) | `planning` | Multi-step plans that must search/read before editing |
| [`editing.md`](examples/editing.md) | `planning` | The `edit` tool: read first, exact-match replacement, diff-style approval |

After touching a routing-relevant surface, run a few prompts from each file
in the Extension Development Host and check that triage picks the expected
route, the plan uses sensible tools, and the execution lands. With
`myDevTeam.telemetry.evalLog` enabled, each run's route and outcome land in
the eval log, so a prompt or weight change can be compared before/after on
the same prompts. When a change adds a new pipeline path or a new tool
behavior, extend the example files in the same piece of work, keeping their
one-route-per-file structure.

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
Node - no editor required. The extension imports the `vscode` module (which only
exists inside a running editor), so `vitest.config.ts` aliases it to an
in-memory fake in `test/mocks/vscode.ts`; the fakes are real classes so the
source's `instanceof` checks still hold. The config also mirrors the bundle's
markdown handling: a `markdown-as-text` transform for plain `.md` imports and
an `md-glob` plugin (sharing `md-glob.mjs` with `esbuild.mjs`) for the
`glob:./dir/*.md` discovery imports. Mastra agents are stubbed (and the
LocalEngine takes injected fake agents) so tests never construct a model or
reach Ollama. Coverage of the protocol (schemas, the event fold), the engine
(workflow, agents, the LocalEngine's event translation and error mapping),
the client (ToolHost, tools, engine factory), the UI handler, and `config/`
is comprehensive - run `npm run test:coverage` to see it.

## Roadmap

- **Phase B: the remote engine.** Lift `engine/` + `protocol/` into packages,
  host the engine in a thin Node server (one HTTP POST starts a run and
  returns an SSE event stream; tool results post back per call id; DELETE
  cancels), and implement a `RemoteEngine` client speaking that wire. The
  protocol - events, tool inversion, usage, auth - already exists, so the
  extension's UI and tools require **no changes**; `myDevTeam.engine:
  "remote"` stops falling back.
- **Phase C: the real backend.** Authentication on the `AuthProvider` seam
  (VS Code auth session or stored API key), metering/billing on the `usage`
  events, server-held provider keys (e.g. Anthropic slots into the model
  registry + a provider factory), rate limits, multi-tenancy.
- **Add a Webview front end.**
  1. Add a `WebviewApprover implements Approver` with a diff/confirm UI.
  2. Pass it instead of `ChatApprover` in `extension.ts`.
  3. Optionally add a Webview panel as a second front-end calling the same core.

  The engine and tools require **no changes**.
