# My Dev Team - design and architecture

The developer documentation for the My Dev Team VS Code extension: how the
agent pipeline, the engine protocol, the configuration system, and the tools
fit together, and how to build, run, and test it from source.

For what the extension is and why, start at [README.md](../README.md); for the
end-user guide (setup, slash commands, approvals, settings), see
[HOWTO.md](HOWTO.md), or [QUICKSTART.md](QUICKSTART.md) for the shortest
post-install setup.

The agent routes each request through a **local triage agent** (Ollama via
the Vercel AI SDK + Mastra) before deciding how to respond. Agents don't name
models: each declares **weighted capability requirements**, and a router picks
the best match from a **registry of models scored per capability**, discovered
from `.md` config files at build time. Running a command is gated by an
**approval seam**, so the chat confirmation can later be swapped for a rich
Webview dialog **without touching the agent core**; writing and editing files
are ungated by default (the workspace is git-backed, so their changes are
recoverable) but can be put behind the same gate with
`myDevTeam.approval.fileChanges` - see [Tools](#tools-tools).

The whole agent pipeline sits behind an **engine protocol**
(`src/protocol/`): the UI starts a run, receives a stream of typed events,
and executes the tool calls the engine asks for - today against the
in-process **LocalEngine**, later against a remote backend speaking the same
contract (see [The engine protocol](#the-engine-protocol-srcprotocol)). A
`myDevTeam.engine` setting switches implementations without a reload.

> **Status:** the full pipeline is live - the routing layer (triage), the
> **planner**, the **oneshot answerer**, the **executor**, and the
> **summarizer**. The workflow classifies your request, answers `oneshot`
> questions directly, and for `planning` requests drafts a step-by-step plan and
> then **executes it**: the executor's capability-routed model drives a
> tool-calling loop over the five workspace tools, with the `run` tool gated by
> the approval seam. When the run changed files, a **summarizer** then recaps it
> in three sections (what ships, how it's built, tests and docs). Every turn
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
      workflow.ts         Mastra workflow: triage -> plan -> (approval gate) -> execute | answer; per-run progress, usage + thinking sinks
      models.ts           provider wiring (ollama/openai/anthropic/groq): availability + pin-aware routing into an AI SDK model
      rateLimiter.ts      per-provider request throttle (RPM) + 429 retry-after-delay, as an AI SDK model middleware
      triage.ts           Mastra agent: triage request as oneshot | planning
      planner.ts          Mastra agent: draft an ordered plan of titled steps + a complexity judgement, streamed as partial snapshots; model sized by triage's complexity
      answerer.ts         Mastra agent: answer a oneshot request directly, streamed as accumulated text (+ reasoning split out as thinking)
      executor.ts         Mastra agent: walk the plan in a tool-calling loop, streamed as a transcript (+ reasoning split out as thinking)
      summarizer.ts       Mastra agent: recap an executed, file-changing run in three sections, streamed as snapshots
      repair.ts           bounded self-repair for structured output: re-ask on a schema-validation failure
      agentTools.ts       the executor's tool proxies: every call delegates to the client's ToolHost
      thinking.ts         condense a reasoning model's <think> output to its latest line for the (ephemeral) thinking signal
      usage.ts            token-count extraction (SDK counts, else a length-based estimate) feeding the usage (billing) events
    config/
      agents/*.md         one agent per file: frontmatter + system prompt
      models/*.md         one registered model per file: provider, model id, capability scores
      tools/*.md          model-facing tool descriptions + transcript preview hints
      commands/*.md       one slash command per file: pinned route, execute flag + prompt preamble
      skills/*.md         one built-in skill per file: name + description frontmatter + instruction body
      backend.ts          loads + validates the root config/backend.json (below), exports the typed `backendConfig`
      agents.ts           loads agents/*.md, renders the tools + environment sections, exports `agents`
      models.ts           discovers models/*.md, exports the registry + capability-based `selectModel`
      tools.ts            discovers tools/*.md, exports `toolConfigs` + `renderToolsSection`
      commands.ts         discovers commands/*.md, exports `commandConfigs` (route pinning + preambles)
      skills.ts           discovers skills/*.md, merges them with workspace skills (`resolveSkills`) + renders the executor's catalogue
      frontmatter.ts      minimal frontmatter parser for the .md config files
      markdown.d.ts       lets TS treat `*.md` and `glob:` imports as strings / string[]
  client/
    engineFactory.ts      the myDevTeam.engine switch: LocalEngine, the sidecar child, or RemoteEngine (Phase B); respawns a crashed child (gives up after repeated crashes), disposes the sidecar
    sidecarEngine.ts      client end of the sidecar: an Engine that forks the child (createForkedChannel) or a stream (createStreamChannel/NDJSON), holds runs until the ready handshake, times out queries, folds events back, services tool-call/plan-review
    secrets.ts            the host's SecretStorage-backed secret source (+ the Set API Key cache), injected into config/credentials for the local engine
    auth.ts               AuthProvider implementations (anonymous today; real credentials in Phase B)
    instructions.ts       reads the workspace's AGENTS.md/CLAUDE.md as standing project instructions per request
    skills.ts             discovers SKILL.md files per request (workspace roots + home dir), ships their raw text on the run request
    mcp.ts                McpHub: launches the configured stdio MCP servers, discovers + namespaces their tools, runs a call back through the ToolHost (trust-gated, disposed on deactivate)
    references.ts         resolves a request's references into attachments: files/selections/symbols + inline #codebase/#changes
    evalLog.ts            opt-in local JSONL eval store: per-run route/usage/outcome records + 👍/👎 feedback; reads them back for the usage report
    usageStats.ts         pure token-usage aggregation: roll the log up by step/model/route/day + input-by-source + a feedback-cost join, derive cache/estimate ratios
    changeTracker.ts      per-turn change collector: write/edit report each landed file, rolled up into the reply's "N files changed, +X -Y" line
  config/                 configuration, kept out of the logic (see below)
    providers.ts          the single provider registry: one descriptor per provider (id, label, keyless, env-var key, base-URL setting, build factory) - everything provider-specific derives from this
    settings.ts           the vscode-backed user settings (read live); builds the engine's runtime-config view (client only)
    limits.ts             vscode-free compile-time constants the engine reads (executor/retry/skills caps, ...); settings.ts re-exposes them
    uiLimits.ts           compile-time constants the client reads (plan-preview "big" thresholds, MCP-args approval-preview cap, status-bar priority); the client-side analog of limits.ts
    runtimeConfig.ts      vscode-free injected seam: the user settings the engine reads, set by the host (live view) or the sidecar child (snapshot)
    credentials.ts        cloud-provider API keys behind an injectable source (vscode-free): default env-only (the sidecar's only source); the host injects a SecretStorage source for the local engine
    messages.ts           user-facing chat copy (errors, warnings, templates, the model-selection copy)
    environment.ts        runtime OS/shell facts: fills prompt placeholders, picks the run tool's shell
    clientCommands.ts     the client-handled /clear and /model commands + the /compact history-replacement marker
  sidecar/                the engine-as-a-child-process plumbing (vscode-free)
    transport.ts          the sidecar wire: parent<->child message types (incl. the ready handshake) + the SidecarChannel seam
    childRuntime.ts       hosts an Engine and maps messages to engine calls; posts the ready handshake; the tool-call/plan-review proxies that invert side effects back to the parent
    main.ts               the child entry point: wires childRuntime to process IPC + a real LocalEngine; bundled to dist/sidecar.js, never imports vscode
  tools/                  the client's hands - these never move to a backend
    workspaceTools.ts     read / search / run / write / edit implementations (UI-agnostic)
    contentSearch.ts      content search: bundled ripgrep (fast path) with a JS extension-host scan fallback
    diff.ts               tiny LCS line-diff: git-style added/removed counts for the change summary
    toolHost.ts           WorkspaceToolHost: validates + dispatches every tool call (engine or editor)
    registerTools.ts      registers the tools with vscode.lm, delegating to the same host
    types.ts              the client seams: Approver (approval) + RunMirror (run transparency) + ChangeReporter (change tracking)
  ui/
    chatParticipant.ts    chat handler: folds run events, streams the reply + Phase-1 ChatApprover + ChatPlanReviewer (plan-approval gate)
    planPreview.ts        read-only editor preview of a big paused plan: a virtual-document content provider opened beside the chat for review (myDevTeam.planApproval.preview)
    modelCommands.ts      model selection UI: the /model picker and the Set API Key command (SecretStorage; used by the local engine)
    statusBar.ts          the single "My Dev Team" status-bar button: a rich hover (trusted markdown with command links) and a click menu to change the model or open the usage report; holds the live model label and session token total
    usageView.ts          the "Show Token Usage" command: rolls the eval log up into a markdown report
    runTerminal.ts        Phase-1 RunMirror: a read-only "Dev Team" terminal logging every run command live
    editorEntryPoints.ts  editor shims: "Fix with Dev Team" code action, "Explain" selection action, write/repair-tests CodeLens - each opens the chat with a pinned command
    startupCheck.ts       activation health check: surfaces the selected engine's startup warnings
config/
  backend.json            the universal backend config: a namespaced JSON file - `models` (disabled providers/models - the enforced floor), `providers` (per-provider endpoint + request-rate defaults the user can override), `agents` (triage routing default); inlined at build time by src/engine/config/backend.ts
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
  read-only "Dev Team" terminal. **`ChangeReporter`** is a third: the `write`
  and `edit` tools report each file they land (with its before/after) to it,
  and the `ChangeTracker` (`client/changeTracker.ts`) sums a turn's writes into
  the reply's "N files changed, +X -Y" line. All three are client seams: an
  engine never knows how approval, mirroring, or change tracking happened.

> **Deployment targets - design for all of them.** This separation is not
> cosmetic: the engine is meant to run in more than one place, and every change
> to `engine/`/`protocol/` must keep all of these viable:
>
> - **in-process** (the `LocalEngine`, the default),
> - a **sidecar process** behind a VS Code client (the `sidecar` engine, live -
>   see [The sidecar engine](#the-sidecar-engine-srcsidecar--clientsidecarengints)),
> - a **standalone remote backend** (Phase B), and
> - a **sidecar process** behind an **IntelliJ IDEA** (JVM/Kotlin) client.
>
> The sidecar matters because an IntelliJ plugin cannot import the TypeScript
> engine; the realistic way to share the brain across editors is to run the
> same engine as a child process and have each editor implement only the thin
> client half against the protocol. That only works if the engine never assumes
> it shares a process, a language, or a filesystem with its client - which is why
> the VS Code sidecar exists today, to keep that discipline honest. Concretely,
> any backend change must preserve four invariants: (1) **no `vscode` import in
> `engine/`** (verified - the layer is clean, and the sidecar bundle is built
> without `vscode`); (2) **everything crossing the boundary is wire-serializable**
> through `protocol/` (plain data, no functions/class instances/`Uri`s that only
> survive in-process); (3) **config and secrets are injected, never read
> in-process** - the engine reads user settings through `config/runtimeConfig.ts`
> and constants through `config/limits.ts` (never `config/settings.ts`), and
> cloud keys through the injectable `SecretSource` in `config/credentials.ts`
> (env-only by default; the host injects a SecretStorage source for the local
> engine, the child inherits env vars); and (4) **tools stay
> inverted** - the engine only ever *asks* for a side effect through the
> `ToolHost`. When in doubt, ask "would this still work if the engine were a
> separate process talking to a Kotlin client?" - if the answer is no, the change
> belongs on the client side of the protocol.

### Request flow

```
@devteam <prompt>
        │
        ▼
ui/chatParticipant.ts          resolve the workspace's instruction file
  createHandler                (AGENTS.md/CLAUDE.md, via client/instructions.ts),
        │                      the request's references into labelled
        │                      attachments (files/selections/symbols plus inline
        │                      #codebase/#changes markers, via
        │                      client/references.ts - which also strips the
        │                      markers from the prompt), and the session's prior
        │                      turns into capped history turns, build a protocol
        │                      RunRequest (version, prompt, instructions,
        │                      attachments, history, skills, MCP tool
        │                      definitions, environment facts, offered tools)
        │                      and
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
        │                      execution-event, usage, thinking, done/error), and maps
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
        │                         → { intent: "oneshot" | "planning",
        │                            complexity: "simple" | "moderate" | "complex",
        │                            reason }
        │                         (complexity sizes the *planner's* model - see
        │                         Complexity routing; model picked by the
        │                         capability router; a known slash command pins
        ▼                         intent + complexity without the model call)
      branch
        ├─▶ draft-plan         ── Planner.plan(fullPrompt, onPartial)  (intent = "planning")
        │                         project instructions + conversation + prompt
        │                         + full attachment text;
        │                         → { summary, steps[], complexity } (model sized
        │                         by triage's complexity);
        │                         pushes the triage decision and every partial
        │                         plan snapshot to the sink as the model streams.
        │                         Then the plan-approval gate: if the planApproval
        │                         setting + the plan's complexity ask for it, calls
        │                         the client's reviewPlan (approve | cancel |
        │                         revise-and-re-plan); cancel carries proceed=false
        └─▶ answer-directly    ── Answerer.answer(fullPrompt, onPartial)  (intent = "oneshot")
        │                         → markdown answer (capability-routed model);
        │                         pushes the triage decision and the growing
        │                         answer text to the sink as the model streams
        ▼
      branch
        ├─▶ execute-plan       ── Executor.execute(executionPrompt, onPartial)
        │                         (a plan was drafted, not /plan, and not cancelled
        │                         at the gate)
        │                         project instructions + conversation + prompt
        │                         + attachment text + the numbered plan;
        │                         Mastra runs the tool-calling loop over the five
        │                         workspace tools (run Approver-gated);
        │                         → { events[] } transcript (model sized by the
        │                         *planner's* complexity);
        │                         pushes every transcript snapshot to the sink
        └─▶ deliver-answer     ── pass-through for the oneshot and plan-only paths
        │                         (a /plan run, or a plan cancelled at the gate)
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
  (prompt, the user's `model` choice, project instructions, attachments,
  history, the workspace's skills (raw `SKILL.md` text), the client's OS/shell
  facts, and the names of the tools the client
  offers) plus a `RunClient` (an event sink and the ToolHost) and returns a
  `RunHandle` (`result` promise + `cancel()`). The `RunClient` also carries an
  optional **`reviewPlan(plan, complexity)`** seam: the engine calls it at the
  plan-approval gate and the client returns approve / cancel / revise (the same
  trust split as the ToolHost - the gate UI lives entirely on the client; absent
  the seam, the run never gates). **`Engine.listModels()`**
  returns the picker's catalogue (Auto first, then each registered model with
  its label and whether it can run now) - the one place the otherwise-hidden
  model registry is exposed, as user-facing choices.
- **Events, not callbacks**, carry the streaming reply: `triaged` (intent plus
  the request's `complexity`),
  `model-selected` (which model each step uses; emitted right after `triaged`),
  `plan-snapshot` (plans are small), `answer-delta`, `execution-event`
  (indexed, since only the transcript's last event ever changes), `usage`,
  `triage-shadow` (what triage would have decided on a pinned run, only when
  the request asked for it - a non-rendering metering signal), `thinking` (a
  condensed line of the model's reasoning), `plan-review` (a remote engine's
  wire form of the approval gate, answered with a `PlanDecision`; the LocalEngine
  calls the client's `reviewPlan` in-process instead, exactly as it calls the
  ToolHost directly rather than emitting `tool-call`), and
  `done`/`error`. The client folds them back into grow-only snapshots
  with `ReplyFolder`, so rendering from events is pixel-identical to the old
  direct wiring - the property that makes local and remote engines
  indistinguishable. `thinking` is a deliberate exception to that fold:
  like `usage` and `triage-shadow` it is a side-channel the engine emits
  directly (it never touches a reply snapshot), because thinking is ephemeral -
  the UI shows it as transient progress (VS Code's `stream.progress`) and drops
  it the moment real output streams in, and it is never preserved past the run
  or fed into a later request. The engine condenses a reasoning model's verbose
  `<think>` output to its latest line (`engine/core/thinking.ts`) before
  emitting, so what surfaces is the "important piece", not the raw chain of
  thought; `myDevTeam.thinking.showInChat` (on by default) gates the capture, so
  off does no extra work. `tool-call`/`ToolResultMessage` are defined for the
  Phase-B wire; the LocalEngine calls the ToolHost in-process instead.
- **Tools are inverted.** The engine's executor never touches the workspace:
  its Mastra tools are proxies that delegate to the client's **`ToolHost`**
  (`tools/toolHost.ts`), which validates the arguments against the
  protocol's input schemas and runs the implementations - including the
  run tool's approval gate. A compromised or buggy engine can request a
  command, but it cannot run one without the user's click, and it never learns
  how approval happened. (File writes are not gated; the path and symlink
  checks still keep them inside the workspace.) The tool contract (`protocol/toolContract.ts`) carries the
  client-facing half of each tool (input schema, `devteam__*` id, display
  name); the engine's configs keep the model-facing half (description,
  preview hints).
- **`usage` events are the billing seam.** Each workflow step reports its
  model call's token counts: the SDK's when it exposes any (input/output, plus
  reasoning, cached-input, and the provider total when present), otherwise a
  cheap length-based estimate over the prompt and reply, flagged `estimated` so
  measured and estimated counts stay separable (engine-side `usage.ts`). The
  estimate runs only on the miss path, so metering still never fails or slows
  the run. For the full-prompt steps (plan/answer/execute) the event also
  carries an `inputBreakdown`: an estimated split of the input tokens by prompt
  section (project instructions, conversation, the command preamble, the
  prompt, the attachments, the executor's available-skills catalogue, and its
  drafted plan), computed where the
  workflow assembles the prompt - the attribution that tells a user what to
  trim. A self-repair retry (triage or the planner re-asking after a
  schema-validation failure) reports its own usage event flagged `repaired`, so
  the extra spend is metered and the eval log can score how often structured
  output needs repair. The LocalEngine forwards the counts as events; the chat handler logs
  them, sums them into the per-reply **Tokens:** line and the status button's
  session total, and (when the eval log is on) stores them per run. Server-side, this
  same stream becomes the metering record. See
  [Token usage statistics](#token-usage-statistics-clientusagestatsts).
- **`AuthProvider`** (`client/auth.ts`) supplies credentials per run -
  anonymous today; a VS Code auth session or stored API key slots in for the
  remote engine without touching the protocol.
- **Errors are protocol-shaped.** A failed run rejects with `RunFailedError`
  carrying the protocol step (`triage | plan | answer | execute`) and an
  engine-supplied hint (the LocalEngine names the routed model and the
  configured Ollama endpoint); cancellation rejects with `RunCancelledError`.

The **`myDevTeam.engine`** setting (read live per request,
`client/engineFactory.ts`) selects the implementation: `local` runs the
in-process engine; `sidecar` runs the same engine in a child process (below);
`remote` warns once and falls back to local until the Phase-B RemoteEngine
exists.

#### The sidecar engine (`src/sidecar/` + `client/sidecarEngine.ts`)

The **sidecar** runs the exact same `LocalEngine` in a forked Node child
(`dist/sidecar.js`), while the client keeps the tools, the approval gate, and
the rendering. It is the proof that the engine is genuinely process-portable -
the groundwork for a remote backend and for sharing one engine with a non-VS
Code editor (a JVM/Kotlin client cannot import the TypeScript engine, but it can
drive this same message protocol). It exists because the protocol was built
wire-shaped from day one: the `tool-call` and `plan-review` events and the
`ToolResultMessage`/`PlanDecision` answers are exactly the inversions the
sidecar needs, so no protocol churn was required.

- **The wire** (`sidecar/transport.ts`) is a small set of parent<->child message
  types (config, start, cancel, tool-result, plan-decision, query one way;
  ready, event, tool-call, plan-review, result, query-result the other) behind a
  `SidecarChannel` seam. The VS Code client carries them as `child_process.fork`
  IPC messages with `serialization: 'advanced'` (a real structured clone, so an
  `undefined`-valued tool arg survives - the `fork` default `'json'` would drop
  it); they are all plain JSON data, so a non-Node client can frame them as
  newline-delimited JSON over a stream instead. That NDJSON variant exists today
  as `createStreamChannel` (next to `createForkedChannel`), proving the same
  `SidecarEngine`/`childRuntime` pair works over a socket or stdio, not just
  `fork` IPC - the transport a JVM/Kotlin client would target.
- **The child** (`sidecar/childRuntime.ts` + `sidecar/main.ts`) hosts the
  engine. Once it constructs the engine it posts a `ready` message carrying the
  `PROTOCOL_VERSION` it speaks and the engine `kind` (the readiness handshake).
  For each run it builds a `RunClient` whose `onEvent` posts an `event`
  message, whose `ToolHost` is a **proxy** that posts a `tool-call` and resolves
  on the matching `tool-result`, and whose `reviewPlan` posts a `plan-review`
  and resolves on the `plan-decision` (only offered when the real client offers
  the seam, via the start message's `canReviewPlan`). So an engine in the child
  can only ever *ask* the client to touch the workspace or gate a plan - the
  same inversion as in-process. The child imports no `vscode` (Part of why the
  config and credentials seams exist); esbuild bundles it as a second entry.
- **The client end** (`client/sidecarEngine.ts`) implements `Engine`: it forks
  the child (with `execArgv: []`, so the child does not inherit the host's
  `--inspect` flags under the debugger), sends the runtime-config snapshot up
  front (and again on a settings change), forwards each `event` to
  `client.onEvent`, services a `tool-call` through the real `client.toolHost` and
  a `plan-review` through the real `client.reviewPlan`, and settles the run's
  `result` from the terminal `result` message - rethrowing the same
  `RunFailedError`/`RunCancelledError` the in-process engine would. A cancel
  aborts the in-flight tool's signal and posts `cancel`.
- **Lifecycle resilience.** The parent **holds the first run** until the child's
  `ready` arrives, and rejects up front with a clear "bundle is out of date,
  reload" message on a **protocol-version mismatch** (a stale `dist/sidecar.js`)
  or with "did not start in time" if `ready` never comes - instead of
  mis-serialising or hanging mid-run. A mid-run crash still rejects that run (only
  *new* runs get the fresh child), but the **memoised instance is dropped on
  close** so the next request (`engineFactory`) forks a fresh child; after
  `settings.sidecar.maxRespawns` crashes inside `respawnWindowMs` the provider
  gives up, warns once, and falls back to local until the user switches the engine
  away and back. One-shot **queries** (`listModels`/`startupWarnings`) **time
  out** (`settings.sidecar.queryTimeoutMs`) rather than hanging the `/model`
  picker or the health check, and a failed/timed-out `startupWarnings` surfaces as
  a warning (so the health check still fires) rather than collapsing to "no
  warnings". With the telemetry flag on, the channel is wrapped to log a
  message/byte count when it closes (`traceChannel`).
- **Config and secrets.** The child has no `vscode`: it reads user settings from
  the injected `runtimeConfig` snapshot the client sends (see
  [Configuration vs. code](#configuration-vs-code-config)) and cloud keys from
  the environment variables it inherits from the parent - nothing secret crosses
  the wire. (The in-process local engine, by contrast, also accepts keys stored
  in SecretStorage via the host-injected source; the sidecar deliberately does
  not.) Because that difference is otherwise invisible, the client warns about it:
  when the sidecar engine is selected and a provider has a key set via "Set API
  Key" (SecretStorage) but no matching environment variable, `engineFactory`
  shows a one-time notice naming the provider and its env var
  (`providersWithStoredKeyButNoEnv` in `client/secrets.ts`), re-armed when the
  user switches engines, so a stored key does not silently stop working. MCP keeps
  working unchanged: the child's proxy `ToolHost` forwards an MCP tool call to the
  parent, where the real `McpHub` runs it.

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

**Project instructions (AGENTS.md / CLAUDE.md).** A workspace can carry
standing rules for the agents in a root-level instruction file. Reading it is
the client's job (the engine is stateless and has no workspace access):
`client/instructions.ts` probes the names in `myDevTeam.instructions.files`
(default `AGENTS.md` then `CLAUDE.md` - the cross-tool standard wins over the
Claude-specific fallback) in the first workspace folder on every request, and
ships the first non-blank match - truncated to
`settings.instructions.maxChars` - on `RunRequest.instructions` with the file
name as its `source`. Reading fresh per request means an edit takes effect on
the very next message. Engine-side, the workflow renders the text as a
`--- Project instructions (<source>) ---` section at the very top of the
planner, answerer, and executor prompts - **ahead of the conversation**,
because the instructions are the most stable content across turns and leading
with them keeps the longest prompt prefix unchanged turn over turn, which is
what prefix caches (Ollama's KV reuse today, explicit prompt caching on a
paid provider later) can reuse. Triage never sees the section: routing
oneshot-vs-planning needs no standing conventions, and on a small local model
they would crowd out the question. The field is optional on the wire, so an
engine that predates it ignores it and version skew degrades instead of
breaking. Nested per-directory AGENTS.md files and `@import`-style includes
are out of scope for now (see [Roadmap](#roadmap)).

**References (`client/references.ts`).** A request can point the agents at
context in two ways, and both resolve - client-side, because the engine has no
workspace access - into the same `{ label, text }` attachments the engine
already understands (triage sees the labels only; the planner/answerer/executor
get the text). That attached text - and file contents the executor reads at run
time - is untrusted: it can carry prompt-injection instructions. The
planner/answerer/executor system prompts (`engine/config/agents/*.md`)
explicitly frame attachments, tool results, and file contents as **data to act
on, not instructions to follow**, so injected text cannot redirect the run;
combined with the protected-path refusal and the `run` approval gate, an
injection cannot silently reach code execution.

- **Explicit references** (`request.references`) - what VS Code attaches when
  you use the paperclip or a `#file`/`#selection`/symbol pick. Each `value` is
  a Uri (whole file, size-guarded against `maxAttachmentReadBytes`), a Location
  (a selection or a symbol's definition range, labelled with its line or line
  range), or a plain string. A value that is location-shaped but not a
  `Location` instance (a symbol reference can arrive structurally) is still
  read; an unrecognised kind (e.g. image/binary data) becomes a short
  label-only "Unsupported reference" notice rather than being dropped silently,
  so the models know something was attached.
- **Inline markers** typed in the prompt, each resolved into an attachment and
  then **removed from the prompt** so the agents see the request, not a stray
  `#codebase`:
  - **`#codebase`** derives a few distinctive search terms from the prompt,
    greps the workspace for each (reusing the `search` tool's content search, so
    the same excludes/caps apply), and attaches the matching file list plus a
    head snippet of the first few - a quick relevance pass so the agents start
    with the repository's relevant code instead of discovering it from scratch.
  - **`#changes`** attaches the workspace's uncommitted git diff (staged +
    unstaged, read-only `git diff`), so `/review` and `/fix` can work against
    what you actually changed. A missing git, a clean tree, or no workspace all
    degrade to a short notice.

  Both are opt-in (you type the marker), so their cost is bounded by the
  `settings.references.*` caps and only paid when asked for. The `#changes`
  resolver is injected (it defaults to the real `git diff`) so tests need no
  repository. Real `#`-variable autocomplete (a contributed chat-variable or
  tool) is a later step; today the markers are recognised as literal prompt
  tokens.

### Configuration vs. code (`config/`)

Anything that's *configuration* - prose an author tunes, tunable limits, UI
copy, model selection - lives apart from the logic that consumes it, split
along the engine/client boundary: prompt material and the model registry in
`src/engine/config/` (a future backend's assets), limits and chat copy in
`src/config/` (the client's). The agents and tools import from there and
never carry literals inline.

**Two config folders, two audiences - the split is intentional, not an
inconsistency.** The root-level `config/` holds **operator/deployment config**:
the knobs you turn to customize an *install* (today only `backend.json` - which
provider/model to disable, which gateway to pin, how to route triage). It is
deliberately at the root, editable without touching `src/`, and is the file a
future remote backend carries server-side. Everything under `src/engine/config/`
and `src/config/`, by contrast, is **authored product source**: the system
prompts, the model registry, the tool/command/skill definitions, and the
typed loaders that validate and consume them. Those `.md` files *are* the
engine's behavior - they change through PRs and tests, not deployment-time
edits, and they must travel with the engine in the Phase B backend split, so
they stay co-located with their loaders rather than moving to the root. Put
another way: root `config/` is "what an operator configures"; `src/**/config/`
is "what the product is made of". Only the former belongs outside `src/`, which
is why `backend.json` is the sole data file there.

| File                            | Holds                                                          |
| ------------------------------- | ------------------------------------------------------------- |
| `engine/config/agents/*.md`     | One agent per file: frontmatter (id, name, description, capability weights, tools) + the system prompt |
| `engine/config/models/*.md`     | One registered model per file: frontmatter (id, user-facing label, provider `ollama`/`openai`/`anthropic`/`groq`, model name, `tier` weight class, capability scores) + a note on its strengths |
| `engine/config/tools/*.md`      | The model-facing half of one tool per file: frontmatter (name, sideEffecting, optional previewArg - the argument shown for a call in the execution transcript, optional snippetArg - the argument whose first lines render as a snippet under the call, e.g. write's contents) + the model-facing description. The client-facing half (input schema, `devteam__*` id, display name) lives in `protocol/toolContract.ts`; the engine-only `progress` and `skill` tools have no client half |
| `engine/config/commands/*.md`   | One slash command per file: frontmatter (name, description, the pinned `intent`, `execute: false` for plan-only, optional `complexity` sizing the executor since triage is skipped - `moderate` by default) + a preamble rendered ahead of the user's prompt for the downstream agents. The same name + description pairs must be declared in `package.json` (`contributes.chatParticipants[].commands`) for autocomplete; a unit test keeps the two lists in sync |
| `engine/config/skills/*.md`     | One built-in skill per file: frontmatter (name, description) + an instruction body. A skill is loaded on demand by the executor's `skill` tool when a task matches the description (see [Skills](#skills-engineconfigskills--clientskills)); dropping a file in registers it |
| `config/backend.json` (project root) | The universal backend config: operator-owned settings the engine enforces (distinct from the user's VS Code settings), inlined into the build by `engine/config/backend.ts`. Namespaced - a `models` section (`disabledProviders` + `disabledModels`), a `providers` section (per-provider deployment **defaults the user can override**, not enforced floors: the endpoint default - Ollama's `endpoint`, the cloud providers' `baseUrl` - and `requestsPerMinute`, the per-provider request rate; for each, the matching user setting wins when set and this supplies the default otherwise), and an `agents` section (today `triage.model`: a model id pins it, a provider name routes by capability, default the "ollama" provider); room for more sections later - with sensible defaults so a partial file is valid. `backend.ts` validates it into the typed `backendConfig`. See [the capability router](#capability-based-model-router-engineconfigmodelsts--enginecoremodelsts) |
| `engine/config/agents.ts`       | Loads the agent files, validates the frontmatter, exports typed `agents` |
| `engine/config/models.ts`       | Discovers the model files, exports the registry and the capability-based `selectModel` |
| `engine/config/tools.ts`        | Discovers the tool files, exports `toolConfigs`/`toolNames` and the prompt-section renderer |
| `engine/config/commands.ts`     | Discovers the command files, exports `commandConfigs`/`commandNames` and the pinned-route reason |
| `engine/config/skills.ts`       | Discovers the built-in skill files, exports `builtinSkills`, `resolveSkills` (merges them with a run's discovered skills - a user skill overrides a built-in, and the first of the client's precedence-ordered list wins a name clash), and `renderSkillsSection` (the executor's name + description catalogue) |
| `engine/config/frontmatter.ts`  | Minimal parser for the frontmatter subset the config files use |
| `config/environment.ts`         | Runtime environment facts (OS name, shell): substituted into `{{os}}`/`{{shell}}` tool-description placeholders and the agents' `{{environment}}` prompt section, sent to the engine in every run request, and the shell the `run` tool spawns (PowerShell on Windows, `/bin/sh` elsewhere) - one source so the prompts and the actual shell can never disagree |
| `config/providers.ts`           | The single provider descriptor registry: one `ProviderDescriptor` per provider (`id`, `label`, `keyless`, `envKey`, `baseUrlSetting`, and a `build(config)` factory that imports the provider's `@ai-sdk/*` package). Everything provider-specific derives from this one list - the model-frontmatter `provider` enum and `ProviderName`, `providerLabels`, the credentials env-var map, the base-URL settings, and the lazy provider wiring - so adding a provider is one descriptor (plus its npm import), not a five-file edit. Lives in `config/` (not `engine/`) so both the engine and the client config layer can import it without violating the engine import discipline; depends only on the AI SDK packages, never on settings/credentials/backend (those resolve a provider's config and pass it into `build`) |
| `config/settings.ts`            | The **client's** vscode-backed user settings, read live from the `myDevTeam.*` VS Code settings (see [User settings](#user-settings-contributesconfiguration)): the engine/model choice, endpoints/base URLs, disabled lists, approval/complexity toggles, the run/read/search caps, the instruction and skills lists, MCP servers, telemetry flags. Also builds `liveRuntimeConfig()`/`runtimeConfigSnapshot()` - the engine's runtime-config view/snapshot. Re-exposes the engine-read constants from `config/limits.ts` so client callers still read them via `settings`. The engine never imports this module |
| `config/limits.ts`              | vscode-free compile-time constants the **engine** reads (executor loop/preview caps, rate-limit retry constants, the skill-body cap, repair attempts, the startup-probe timeout, the built-in Ollama endpoint). Single source; `settings.ts` references them so the client-facing `settings` object still exposes them |
| `config/uiLimits.ts`            | Compile-time constants the **client** reads, not user-tunable and not engine-read: the plan-preview "big" thresholds (`isBigPlan`), the MCP-args approval-preview cap, the status-bar item priority. The client-side analog of `limits.ts`; lives in `config/` so any client layer (`ui/`, `tools/`, `client/`) can import it without coupling to another |
| `config/runtimeConfig.ts`       | vscode-free injected seam: the `RuntimeConfig` (the user settings the engine reads - endpoints, disabled lists, triage model, complexity toggle, request rate, snippet lines, approval, thinking/summary toggles) plus `runtimeConfig()`/`setRuntimeConfig()`. The host injects a live view (`liveRuntimeConfig()`); the sidecar child injects a pushed snapshot. Lives in `config/` (the shared layer, like `providers.ts`) so the engine can read it in any process |
| `config/credentials.ts`         | Cloud-provider API keys behind an injectable `SecretSource` (no `vscode` dependency, so the engine reads it anywhere). The default source - and the **only** source the sidecar child uses - reads the environment variables (`OPENAI_API_KEY`/`ANTHROPIC_API_KEY`/`GROQ_API_KEY`) it inherits. The host injects a SecretStorage-backed source (`client/secrets.ts`) for the local engine, so a key set via "Set API Key" wins, env as fallback. The cloud providers and their key names come from the provider registry. Exposes `credentials.apiKey(provider)`/`has(provider)`, read live by the provider wiring |
| `config/messages.ts`            | Error text, startup warnings, reply markdown templates, the engine-switch warning, the Ollama/cloud-key hint templates the LocalEngine fills in, the /clear confirmation, the model-selection copy (the "which model ran" line, the picker prompts), the token-usage copy (the **Tokens:** line and the usage report), the status button + menu copy, the run-mirror terminal's copy, and the editor entry points' action/lens titles and framed prompts. Knows nothing about agents and almost nothing about models - the one exception is the `model` copy, since model selection is a user-facing choice |
| `config/clientCommands.ts`      | The client-handled commands (`/clear` and `/model`, with their autocomplete descriptions) plus the `/compact` marker name the history collection watches for - client-side because conversation history and the model choice are client state. The commands unit test keeps these, the engine registry, and `package.json` in sync |

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
model selection, and the list of **tools** it works with. Prompts never
hardcode tool descriptions - the `{{tools}}` placeholder in the prompt body is
replaced with a section rendered from the tool configs, so adding a tool to an
agent is a one-line frontmatter change. The planner's tool list only grounds
its prompt (so it plans doable work); plan steps name no tool, the executor
chooses how to carry each one out at run time.

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
and read **live** by `config/settings.ts` on every access - no reload needed.
For the exhaustive parameter inventory across every source (user settings, the
operator floor, secrets, build-time constants, and the author `.md` configs),
see [CONFIG.md](CONFIG.md); the table below is the user-settings summary:

| Setting                              | Default                  | Controls                                  |
| ------------------------------------ | ------------------------ | ----------------------------------------- |
| `myDevTeam.engine`                   | `local`                  | Which engine handles `@devteam` runs: `local` (in-process), `sidecar` (same engine in a forked Node child; tools/approval/rendering stay in the editor), or `remote` (Phase B; warns and falls back to local until it exists) |
| `myDevTeam.model`                    | `auto`                   | What the planner/answerer/executor use: a model id, a `provider:<name>` to route within one provider, or `auto` to route by capability among the available models. Triage is configured separately by `myDevTeam.triage.model`. Set it with `/model` or the "My Dev Team" status button's menu |
| `myDevTeam.triage.model`             | `""`                     | What triage uses, separate from the model above so the cheap classifier need not ride on the executor's model. Empty defers to the backend `agents.triage.model` floor (the "ollama" provider by default); otherwise `auto`, a `provider:<name>` (or bare provider name), or a model id, resolved by `triageRouting`. User-controlled like `myDevTeam.model`, with the disable layers still applied, so it can never reach a disabled provider/model |
| `myDevTeam.disabledProviders`        | `[]`                     | Providers the router must never use (e.g. `["anthropic"]`): their models are skipped and shown disabled in the `/model` picker even with a key set, and never run even when pinned. The per-user layer on top of the backend floor (`config/backend.json`), which it cannot re-enable. Non-string/blank entries are ignored |
| `myDevTeam.disabledModels`           | `[]`                     | Individual model ids the router must never use (e.g. `["qwen3-coder"]`), same two-layer hard-block semantics as `disabledProviders`: a disabled model never runs even when pinned (the run falls back to Auto) |
| `myDevTeam.complexityRouting`        | `true`                   | Size models to how demanding the work is (the model registry's `tier`): triage's guess sizes the planner, the planner's judgement sizes the executor; simpler work routes to a cheaper/smaller model, harder work to a stronger one. Off routes by capability alone; a pinned model is never affected |
| `myDevTeam.planApproval`             | `auto`                   | When `@devteam` pauses to let you approve a drafted plan before it executes: `auto` only when the planner judged the work `complex`, `always` on every plan, `never` straight through. The gate offers Approve (execute), Cancel (keep the plan, run nothing), or Revise (comment, re-plan, ask again) |
| `myDevTeam.planApproval.preview`     | `auto`                   | When a paused plan also opens as a read-only markdown preview beside the chat: `auto` only for a big plan (complex, or carrying design decisions, many steps, or a long write-up), `always` on every paused plan, `never` keeps review in the chat. Client-only - a pure rendering choice the engine never sees, so it does not ride the runtime-config seam; the Approve/Cancel/Revise choices stay in the chat |
| `myDevTeam.approval.fileChanges`     | `false`                  | Require approval before the `write`/`edit` tools change a file. Off by default (changes apply directly, since the workspace is git-backed); on routes every write and edit through the same Approve/Decline gate as `run`. `run` stays gated regardless |
| `myDevTeam.ollama.endpoint`          | `""` (unset)             | Ollama server origin (no `/api` suffix). Unset uses the deployment default in `config/backend.json`, then the built-in `http://localhost:11434`; set, your value wins over the deployment default |
| `myDevTeam.openai.baseUrl`           | `""`                     | Optional custom base URL for OpenAI (Azure / OpenAI-compatible gateway); empty uses the default endpoint. The key comes from `OPENAI_API_KEY`, not here |
| `myDevTeam.anthropic.baseUrl`        | `""`                     | Optional custom base URL for Anthropic (a proxy/gateway); empty uses the default endpoint. The key comes from `ANTHROPIC_API_KEY`, not here |
| `myDevTeam.groq.baseUrl`             | `""`                     | Optional custom base URL for Groq (a proxy/gateway); empty uses the default endpoint. The key comes from `GROQ_API_KEY`, not here |
| `myDevTeam.provider.requestsPerMinute` | `null` (unset)         | Your override of the per-provider request rate: calls are spaced to stay under it, keeping a run within a provider's quota. Unset (the default) defers to the operator's per-provider floor in `config/backend.json`; a number overrides it in either direction, and `0` disables throttling. The user's value wins over the floor (it is the user's quota to manage). A 429 is always retried after the provider's suggested delay regardless of this |
| `myDevTeam.run.commandTimeoutMs`     | `60000`                  | `run` tool shell-command timeout (ms)     |
| `myDevTeam.read.maxLines`            | `200`                    | Max lines one `read` call returns; partial results name the range and total so the model continues |
| `myDevTeam.search.globMaxResults`    | `200`                    | Max files a glob search returns           |
| `myDevTeam.search.contentScanLimit`  | `500`                    | Max files a content search scans          |
| `myDevTeam.search.contentMaxMatches` | `50`                     | Max match lines before a content search stops |
| `myDevTeam.chat.toolSnippetLines`    | `5`                      | Leading lines of a written file (or an edit's replacement text) shown under a `write`/`edit` call in the transcript (`0` hides the snippet) |
| `myDevTeam.usage.showInChat`         | `true`                   | Append a **Tokens:** line under each reply summing the run's input/output tokens. The status button's session total and the "Show Token Usage" report are independent of this flag |
| `myDevTeam.changes.showInChat`       | `true`                   | Append a **Changes:** line ("N files changed, +X -Y") under a reply that wrote files; appears only when a turn changed files |
| `myDevTeam.summary.showInChat`       | `true`                   | After an executed plan that changed files, add a three-section **Summary** recap; off skips the extra summarizer model call entirely |
| `myDevTeam.thinking.showInChat`      | `true`                   | Show a reasoning model's thinking live as a transient progress line (condensed to its latest line), never kept past the run; off skips capturing reasoning entirely |
| `myDevTeam.instructions.files`       | `["AGENTS.md", "CLAUDE.md"]` | Root-relative file names probed for standing project instructions, in order; the first that exists is sent with every run. Plain names only (an entry with a path separator or `..` falls back to the default list); an empty list disables the feature |
| `myDevTeam.skills.directories`       | `[".devteam/skills", ".claude/skills"]` | Relative directories scanned for skills, each at `<dir>/<name>/SKILL.md`; the matches are sent with every run, alongside the built-in skills. Looked for under every workspace root **and** the user's home directory (so `~/.claude/skills` etc. are personal skills); a workspace skill wins a name clash with a home one. An entry that is absolute or contains `..` makes the whole list fall back to the default; an empty list turns user skills off (built-ins still ship) |
| `myDevTeam.mcp.servers`              | `{}`                     | MCP servers whose tools `@devteam` may call, as a name -> `{ command, args?, env? }` map. Each is launched over stdio; its tools are offered namespaced `mcp__<server>__<tool>` and every call is approved like `run`. Server names must be plain identifiers; invalid entries are ignored. Nothing is contacted in an untrusted workspace; new servers take effect on a window reload |
| `myDevTeam.write.protectedPaths`     | `[".vscode"]`            | Root-relative locations `write`/`edit` refuse to touch, on top of the always-protected `.git/` (auto-running locations that would sidestep the run gate). Matched per path segment; an entry with `..` falls back to the default list; an empty list keeps only `.git` protected |
| `myDevTeam.telemetry.evalLog`        | `false`                  | Opt-in local eval log: store per-run route/usage/outcome records and 👍/👎 feedback as JSON lines in extension storage (no prompt or reply text; nothing leaves the machine) |
| `myDevTeam.telemetry.shadowTriage`   | `false`                  | On a slash-command (pinned) run, also run triage in the background and record its prediction, so the usage report can score triage against the pinned route. Adds one local triage call per pinned run; only collects while the eval log is on |

Invalid values (wrong type, non-positive numbers, an endpoint that is not an
http(s) URL) silently fall back to the defaults, so the tools always see sane
limits. The endpoint is the **single source of truth**: the provider wiring
(`createOllama({ baseURL })` in `engine/core/models.ts`), the troubleshooting
hint in chat errors, and the activation health check all derive from one
resolved-endpoint accessor (`ollamaEndpoint()` in `engine/core/models.ts`), so
they can never disagree. That accessor is "**user setting else backend default
else built-in localhost**": when the user set `myDevTeam.ollama.endpoint` it
wins (a user points the extension at their own server), otherwise the
deployment's `config/backend.json` `providers.ollama.endpoint` default applies,
otherwise the built-in `http://localhost:11434` - the same precedence for the
cloud providers' `baseUrl`, resolved generically per provider from the
descriptor's `baseUrlSetting` (`settings.providerBaseUrl(key)` else the backend
default). The backend value is a **deployment default the user can override**,
not an enforced floor (the only enforced floor is the disabled-provider/model
list); an operator ships a sensible server, a user overrides it for their box.
Changing the endpoint mid-session rebuilds the provider and drops the memoised
model instances; the next request talks to the new server. Everything not listed above
(buffer/truncation caps, search excludes) stays a compile-time constant in
`config/settings.ts`.

On activation the extension asks the selected engine for startup warnings
(`Engine.startupWarnings`, surfaced by `ui/startupCheck.ts`, never blocks
activation): the LocalEngine pings `<endpoint>/api/tags` (3s timeout) and
reports an unreachable server or a router-selected model that is not
pulled - instead of letting the first chat request be the thing that fails.
When no agent routes to Ollama at all (e.g. triage pinned to a cloud provider
and the local provider disabled), the probe is skipped entirely and Ollama's
reachability is never mentioned - a fully cloud setup must not warn about a
server it does not use.

### Capability-based model router (`engine/config/models.ts` + `engine/core/models.ts`)

Agents never name a concrete model. Instead:

- **Registered models** (`engine/config/models/*.md`) carry an `id`, a
  user-facing `label`, a `provider` (one of the registry's ids - see
  [the provider registry](#the-provider-registry-configprovidersts)), the
  provider-specific `model` name, a `tier` (its weight class -
  `simple` | `moderate` | `complex`, default `moderate`; see Complexity routing
  below), and scores for how good the model is at a set of capabilities -
  `reasoning`, `coding`, `classification`, `planning`, `speed`,
  `structured-output` - each 0-1.
- **Agents** (`engine/config/agents/*.md`) declare the same capabilities as
  *weights*: how much each one matters to that agent.
- `selectModel` (`engine/config/models.ts`) is pure config logic: given a
  requirement profile, an optional pin, a candidate list, and an optional
  complexity, it returns the pinned model outright or - among the candidates,
  narrowed to the request's tier when a complexity is given - the highest
  weighted score (Σ weight × score). `engine/core/models.ts` adds the runtime:
  `availableModels()` (every Ollama model, assumed pulled, plus any cloud model
  whose API key is set), `localModels()` (the Ollama subset),
  `routeModel`/`resolveModel` (apply the pin + candidates + complexity and wire
  the winner onto an [AI SDK](https://sdk.vercel.ai) provider instance).

**Complexity routing.** Triage classifies not only the intent but how
demanding the request is (`simple` | `moderate` | `complex`; see
`TriageSchema`), and complexity routing **sizes a model to its tier**:
`selectModel` narrows the candidate pool to models whose `tier` matches the
request's complexity before scoring by capability, so simple work (a
self-contained script) routes to a cheaper/smaller model and complex work
(multi-file changes, subtle debugging) to the strongest one - within whatever
provider is in play, Ollama included. When the pool has no model at the exact
tier (a local-only box with no large model, or a provider missing a tier),
`tierPool` falls back to the **nearest available tier** by ordinal distance,
breaking a distance tie toward the cheaper tier, so a selection is always made.

Complexity routing is **two-stage** on the planning path. Triage's
pre-exploration guess sizes the **planner's** model (the planner is built per
run in the draft-plan step, like the executor). The planner then emits its own
`complexity` field - a better-informed read, made after it has seen the request
and drafted the steps - and that sizes the **executor's** model and is the value
surfaced to the user (the executor falls back to triage's tier only until the
plan exists; the streamed `model-selected` event uses triage's estimate and the
final reply's `selection` corrects the executor entry). The answerer routes by
capability alone. A **command-pinned** run skips triage, so the planner's tier
comes from the command's frontmatter (`moderate` by default; `/fix` is
`complex`). The gate is live: a **model pin** bypasses complexity (the user
chose), and `myDevTeam.complexityRouting` (default on) turns it off entirely,
read in `routeModel` so every caller and the engine's `model-selected` mirror
always agree. The chat renders the planner's `**Complexity:** …` line inside the
plan block (an append-only position that keeps streamed renders prefix-safe).

The planner's `complexity` also drives the **plan-approval gate** (see "The
plan-approval gate" below).

#### The plan-approval gate

After the planner drafts a plan, the draft-plan step can **pause for the user's
approval** before the workflow executes it. The gate engages only when three
things hold: the run will actually execute (not a `/plan` plan-only run), the
client offered the review seam, and `myDevTeam.planApproval` asks for it -
`always` on every plan, `auto` (the default) only when the planner judged the
plan `complex`, `never` not at all. With no seam (a test, or a client that
predates it) the run never gates, so the feature is purely additive.

The seam mirrors the tool seam. The client's `RunClient.reviewPlan(plan,
complexity)` is the in-process handle (the LocalEngine passes it to the step via
the `planReviewKey` request-context channel, the same way it passes the progress
and usage sinks); a remote engine instead emits the `plan-review` event and
reads back a `PlanDecision`. Either way the gate UI lives entirely on the client
- the `ChatPlanReviewer` (`ui/chatParticipant.ts`), which renders the plan with
inline Approve / Cancel / Revise links (a modal fallback when there is no chat
stream), exactly as the `ChatApprover` does for the `run` tool.

The decision is a `PlanDecision`: **approve** proceeds to execute; **cancel**
carries an engine-internal `proceed: false` so the execute branch is skipped and
the plan is delivered alone (reusing the `/plan` "nothing was executed" note);
**revise** carries a free-text comment back to the planner, which re-drafts (the
comment appended like a repair re-ask, re-streaming over the snapshots shown) and
the gate asks again. The complexity shown at the gate, and the one that sizes the
executor, is the planner's.

Beside the chat links, a **read-only editor preview** of the plan can open for
the duration of the review (`ui/planPreview.ts`, gated by
`myDevTeam.planApproval.preview`). It is a pure client rendering choice - the
engine never learns an editor opened, so nothing crosses the protocol. A
`TextDocumentContentProvider` serves the plan markdown (the goal, any **design
decisions**, the numbered steps, the complexity) from memory under a virtual
`devteam-plan` scheme, so nothing is written to the workspace; the reviewer opens
it per review (keyed by id) and disposes it when the verdict settles, which
closes the tab. Under `auto` it opens only for a "big" plan - `complex`, carrying
decisions, a long rendered document, or many steps - while `always`/`never`
force or suppress it. The Approve/Cancel/Revise choices stay in the chat; the
preview is only the richer reading surface, and the inline chat checklist is
unchanged. The optional `decisions` the planner emits for a complex change (a few
pivotal design choices, each with a rationale) are surfaced here so the user can
judge - and, via Revise, redirect - the approach, not just the steps.

#### The provider registry (`config/providers.ts`)

**One descriptor per provider.** Every provider - what it is called, whether it
needs a key, where its key and base URL come from, and how to build its model -
is described by a single `ProviderDescriptor` in `config/providers.ts`, and
everything provider-specific derives from that one list:

- `id` and `label` - the id is the model-frontmatter `provider` value, the
  `provider:<id>` pin, and the disable-list entry; `providerLabels` and the
  model-frontmatter `provider` enum (and `ProviderName`) are generated from the
  registry, so a model file naming an **unknown provider fails at load** with a
  clear message instead of registering a model the wiring cannot build.
- `keyless` - whether the provider needs an API key. The keyless provider
  (Ollama) is always available; the cloud providers are exactly the non-keyless
  descriptors, which is what `config/credentials.ts` iterates.
- `envKey` - the environment variable the API key is read from (cloud only),
  the default source and the only one the sidecar child uses (it inherits the
  parent's environment).
- `secretKey` - the SecretStorage key the "Set API Key" command stores under
  (cloud only). Only the in-process local engine reads SecretStorage, via the
  host-injected source in `client/secrets.ts`; the sidecar ignores it.
- `baseUrlSetting` - the `myDevTeam.<provider>` setting holding the base-URL /
  endpoint override; the generic `settings.providerBaseUrl(key)` reads it.
- `build(config)` - turns a resolved `{ apiKey, baseUrl }` into the provider's
  [AI SDK](https://sdk.vercel.ai) model factory, importing that provider's
  `@ai-sdk/*` package. This is the only per-provider code; **adding a provider
  is one descriptor plus its npm import**, not the old five-file edit.

The registry lives in `config/` (not `engine/`) so both the engine and the
client config layer can import it without breaking the engine import discipline,
and it depends only on the AI SDK packages - never on settings/credentials/
backend. `engine/core/models.ts` resolves each provider's config (the key from
`credentials`, the base URL as "user setting else backend default") and feeds
it to the descriptor's `build`.

**Today's providers.** Ollama is local and keyless, built from
`myDevTeam.ollama.endpoint`. OpenAI, Anthropic, and Groq need an API key (read
from their `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GROQ_API_KEY` environment
variables, or - for the local engine only - from a key stored via the "Set API
Key" command) and accept an optional custom base URL (`myDevTeam.openai.baseUrl` /
`anthropic.baseUrl` / `groq.baseUrl`) for Azure or an
OpenAI-compatible/Anthropic/Groq gateway. Every provider's endpoint can also be
given a **deployment default by the operator** in `config/backend.json`'s
`providers` section (Ollama's `endpoint`, the cloud providers' `baseUrl`) - so a
build ships pointing at a corporate gateway out of the box - but the user's own
setting **wins over** that default when set, so a user can always point the
extension at their own server. Each provider is built lazily and rebuilt when
its (resolved) endpoint, key, or base URL changes, dropping the memoised model
instances so the next request uses the new configuration.

**Disabling providers and models.** A provider or an individual model can be
taken out of play at **two layers**, unioned into one predicate
(`isModelEnabled`/`isProviderEnabled` in `core/models.ts`): a model is enabled
only when its provider is enabled and neither its provider nor its id is
disabled at either layer.

- **The backend floor** is the operator's `config/backend.json` (the
  universal backend config, validated by `backend.ts` into `backendConfig`): its
  `models.disabledProviders` / `models.disabledModels` are switched off for
  everyone and **cannot be re-enabled by a user setting**. Today the engine runs
  in-process, so the file ships in the build; a future remote backend would carry
  the same file server-side.
- **The user layer** is `myDevTeam.disabledProviders` /
  `myDevTeam.disabledModels` (read live in `config/settings.ts`): a per-user
  narrowing on top of the floor.

Disabling is **orthogonal to availability** (`isModelAvailable`, the API-key
check) and a **hard block**: `availableModels()`/`localModels()` drop disabled
models so Auto and triage never route to them, and `effectivePin` drops a pin
naming a disabled model/provider so even an explicit choice falls back to Auto
rather than running it (`routeModel` also hands `isModelEnabled` to `selectModel`
so a disabled member of an otherwise-enabled provider pin is excluded too). The
`/model` picker (`Engine.listModels`) reports a disabled entry with
`available: false` and a `disabled` flag, so it shows greyed out with a distinct
"Disabled by configuration" reason. If disabling empties a candidate pool (e.g.
every local model is disabled, leaving triage nothing), `selectModel` throws a
clear "every candidate may be disabled" error - a self-inflicted footgun the
operator/user undoes by re-enabling something.

**Rate limiting and 429 retries.** Every wired model is wrapped in an AI SDK
language-model middleware (`core/rateLimiter.ts`) that sits below Mastra, so it
sees the raw provider `APICallError`. It does two things, both per provider and
both reading their settings live:

- **Throttle.** Each provider's rate is resolved by `resolveRequestsPerMinute`:
  the operator's per-provider floor in `config/backend.json`
  (`providers.<id>.requestsPerMinute`) is the default, and the user's
  `myDevTeam.provider.requestsPerMinute` overrides it - in either direction and
  across every provider - when set, because a request rate is the user's own
  quota to manage rather than a policy to enforce (the inverse of the endpoint
  override's precedence). When the resolved rate is positive, calls are spaced
  `60_000 / rpm` apart so a provider never receives more than that many requests
  per rolling minute - keeping a run under a provider's quota (e.g. Groq's free
  tier) instead of firing until one is rejected. The budget is per provider, so
  a local Ollama call never spends a cloud provider's allowance. `0` (the
  shipped floor, and an explicit user `0`) disables it. A call whose throttle
  wait is **aborted** (the request is cancelled before it goes out) hands its
  reserved slot back (`releaseSlot`), so a cancelled call does not push the
  calls behind it further out for nothing; a slot is only spent once its request
  is actually issued.
- **Retry.** A 429 is caught and retried after the delay the provider suggests
  (its `retry-after`/`retry-after-ms` header, or the "try again in Ns" hint in
  the message), plus a small buffer, clamped to a 60s cap and capped at
  `provider.maxRateLimitRetries` attempts. The throttle slot is re-acquired
  before each attempt. A 429 that outlasts the retries surfaces with a
  rate-limit hint (`messages.rateLimitHint`) pointing at the throttle setting,
  rather than the API-key hint.

**User selection: Auto, a model, or a provider.** The user picks with `/model`
(or the "My Dev Team" status button's menu / "My Dev Team: Select Model" command); the choice is
stored in `myDevTeam.model` and travels on every `RunRequest.model`. Three
kinds of choice, all decided in `selectModel`:

- **Auto** (the default, or any id the engine does not know) routes each work
  agent to the best fit among the *available* models, so Auto never picks a
  cloud model whose key is not set, and a user who adds a key gets the stronger
  model automatically.
- A choice naming a **registered model** pins it: the planner, answerer, and
  executor all use that one model.
- A **`provider:<name>`** choice pins the *provider*: the work agents route by
  capability among that provider's models (the best per agent), not one fixed
  model. The catalogue offers one such choice per provider.

A model or provider pin bypasses the availability gate (the user asked for it),
so a pinned cloud model/provider with no key still runs and fails with a hint
to set the key, rather than being silently ignored. The user's `model` choice
never touches **triage**: triage has its own knob, `myDevTeam.triage.model`,
routed by `triageRouting` (core/models.ts) - **"auto" routes among the available
models, a registered model id pins that exact model, a `provider:<name>` (or
bare provider name) routes by capability within it, and empty defers to the
backend `agents.triage.model` floor, the "ollama" provider** (the local models).
Triage stays a cheap, invisible classification that should be fast and free, so
it defaults to a local model and ignores whatever the user
pinned for the work that follows; anyone who wants a sharper classifier - or who
has no Ollama server - can point it at a specific model or another provider via
`myDevTeam.triage.model`, with the operator's `agents.triage.model` as the
shipped default.

**Surfacing the choice.** The engine emits a `model-selected` event right after
`triaged` and attaches the same `selection` to the reply (mode
`pinned`/`provider`/`auto`, the provider label in provider mode, plus the model
each step used), and the chat renders a `**Model:** …` line under the triage
block - so the user always knows which model answered, especially when Auto or
a provider pin chose.

Retune an agent by editing its weights, and upgrade the whole system by
registering a stronger model - no agent code changes either way.

The "Auto selects" column below is the local-only default (no cloud key set);
with a key configured, Auto prefers the higher-scoring cloud models for the
planner/answerer/executor. Triage follows its own setting, `myDevTeam.triage.model`
(the executor's `myDevTeam.model` does not size it) - empty defers to the backend
`agents.triage.model` floor ("ollama" by default, so it stays local), and a user
can point it at a cloud provider when no Ollama server is available.

| Agent      | Weights (what it cares about)                                | Auto selects (local-only) |
| ---------- | ------------------------------------------------------------ | ----------------- |
| `triage`   | classification 1, speed 0.8, structured-output 0.5           | Ollama `qwen3:8b` |
| `planner`  | planning 1, reasoning 0.8, structured-output 0.6, speed 0.3  | Ollama `qwen3:14b`|
| `answerer` | reasoning 1, speed 0.9                                       | Ollama `qwen3:8b` |
| `executor` | coding 1, reasoning 0.7, speed 0.3                           | Ollama `qwen3-coder` |
| `summarizer` | reasoning 0.6, speed 0.9                                   | Ollama `qwen3:8b` |

```yaml
# engine/config/models/anthropic-opus.md - a registered model (scores):
id: anthropic-opus
label: Claude Opus 4.8 (Anthropic)
provider: anthropic
model: claude-opus-4-8
tier: complex            # the weight class complexity routing sizes to
capabilities:
  reasoning: 0.98
  coding: 0.97
  planning: 0.97
  # …

# engine/config/agents/planner.md - an agent's requirements (weights):
capabilities:
  planning: 1
  reasoning: 0.8
  structured-output: 0.6
  speed: 0.3
```

```ts
// engine/core/planner.ts - the per-run wiring, sized by triage's complexity:
model: resolveModel(agents.planner.capabilities, modelPin, undefined, complexity),
// engine/core/executor.ts - sized by the planner's complexity (the answerer
// passes none and routes by capability alone):
model: resolveModel(agents.executor.capabilities, modelPin, undefined, complexity),
// engine/core/triage.ts - triage routes per myDevTeam.triage.model (empty
// defers to the backend agents.triage.model floor), never the work-model pin:
model: resolveTriageModel(agents.triage.capabilities),
```

### Slash commands (`engine/config/commands/` + `engine/config/commands.ts`)

`@devteam` offers nine slash commands - seven **engine commands** and two
**client commands** (`/clear` and `/model`, see below). Each engine command is a `.md`
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
| `/model`   | client-side, no run    | Choose what the planner/answerer/executor use: a model, a provider (best model per task within it), or Auto. With an argument sets it directly (a model name or a bare provider name); with none opens a picker. Writes `myDevTeam.model`, starts no run |

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

### Editor entry points (`ui/editorEntryPoints.ts`)

Every interaction otherwise starts in the chat panel by typing `@devteam`.
Three shims surface the same agents from where the user already works, and each
is deliberately thin: it opens the chat with a pinned slash command and a framed
prompt (the relevant context attached inline), so routing, references, and
approvals all flow through the existing pipeline unchanged. Opening the chat
with a query string (`workbench.action.chat.open`) is identical to the user
typing it, so `@devteam /fix ...` pins the route exactly as a typed command
does, and an inline `#changes` marker resolves through `client/references.ts`
like any other.

- **"Fix with Dev Team"** - a quick fix (`vscode.CodeActionProvider`, kind
  `QuickFix`) offered only when the cursor sits on one or more diagnostics
  (VS Code passes them in the action context). It opens `/fix` with `#changes`
  and each problem described as `line N: message`, so the agent diagnoses
  against what actually changed.
- **"Explain with Dev Team"** - an `editor/context` menu action gated on a
  non-empty selection. It opens `/explain` with the selected code inlined
  (capped at `settings.maxAttachmentChars`) and its file + line range named.
- **Write/repair-tests CodeLens** - a `vscode.CodeLensProvider` puts one lens at
  the top of a test file (recognised by path: a `tests?/`/`__tests__/`
  directory, or a `*.test.*`/`*.spec.*`/`*_test.*`/`test_*` name across
  languages). It opens `/test`, framed to **repair** when the file currently
  carries an error-severity diagnostic and to **write/update** otherwise. A
  CodeLens cannot read another test runner's pass/fail results, so error
  diagnostics are the available "failing" signal.

The copy (action/lens titles and the framed prompts) lives in
`messages.editor`; the prompts carry only the slash command's argument, since
the shim prepends the `@devteam /<command>` itself. The explain action is
declared in `package.json` (`contributes.commands` + `menus.editor/context`);
the code action and CodeLens providers register at runtime in
`registerEditorEntryPoints`, called from `activate`.

### Skills (`engine/config/skills` + `client/skills`)

A **skill** is a named, described block of instructions the executor loads on
demand: reusable know-how (how to write a commit message, format a changelog
entry, follow a team convention) that would otherwise be repeated in prompt
after prompt. Skills are **model-invoked with progressive disclosure** - the
executor's prompt lists only each skill's `name: description`, and the model
pulls in a skill's full body only when a task matches, so a skill costs nothing
on a run that does not use it.

- **Two kinds of source, merged per run.** Built-in skills are `.md` files in
  `engine/config/skills/` (frontmatter `name` + `description`, instruction body),
  discovered by the glob import at build time like the commands and tools.
  User skills are `SKILL.md` files the client finds (`client/skills.ts`) under
  the configured directories (`myDevTeam.skills.directories`, default
  `.devteam/skills` and `.claude/skills`, each at `<dir>/<name>/SKILL.md`), looked
  for in **two base locations**: every workspace root (a skill committed to the
  project) and the user's **home directory** (a personal skill shared across
  projects, e.g. `~/.claude/skills/<name>/SKILL.md`). The client lists the
  directory entries with `vscode.workspace.fs.readDirectory` and ships each file
  as **raw text** on `RunRequest.skills` - reading fresh per request, so an edit
  takes effect on the next message (the same client-side, stateless-engine
  discipline as the instruction file). The engine's `resolveSkills` parses the
  shipped skills with the one frontmatter parser and drops a malformed one rather
  than failing the run.
- **Precedence is explicit: workspace > home > built-in.** A user skill
  overrides a built-in of the same name, and among user skills the client ships
  them **highest precedence first** (workspace roots before the home directory,
  directories in their listed order) while `resolveSkills` keeps the **first**
  occurrence of each name - so a project's skill beats a personal one, and a
  personal one beats a built-in. Each resolved body is capped to
  `settings.skills.maxChars`.
- **Executor-only.** Only the executor consumes skills - it is the one agent
  with a runtime tool-calling loop. `resolveSkills` yields a catalogue
  (`name` + `description`, rendered into the executor's prompt as an
  `--- Available skills ---` section and attributed in the usage breakdown's
  `skills` field) and a `name -> body` map. The oneshot/answerer path has no
  tool loop, so it gets no skills.
- **The `skill` tool is engine-only, like `progress`.** It is built in
  `buildAgentTools` (no client implementation, no approval gate); its
  `execute({ name })` returns the body from the per-run map (or a short "no such
  skill" notice), and Mastra feeds that straight back to the model - so the body
  enters the model's context only when a skill is actually loaded. The call
  flows through the normal transcript path, rendering as a `skill <name>` tool
  event (its `previewArg` is `name`), so the user sees which skill was loaded.
  No client tool contract exists for it (`protocol/toolContract.ts` carries only
  the workspace tools).

### MCP tools (`client/mcp.ts`)

The executor can also call tools from user-configured **MCP (Model Context
Protocol) servers**. The contract for the built-in tools is static and compile-
checked (one source of truth across `protocol/toolContract.ts`,
`tools/toolHost.ts`, and `engine/core/agentTools.ts`); MCP tools are *dynamic*
and *per-user*, so they ride the same `ToolHost` inversion as data rather than
extending the static contract.

- **Client-discovered, like skills.** `McpHub` (`client/mcp.ts`) reads
  `myDevTeam.mcp.servers` (a name -> `{ command, args?, env? }` map), launches
  each server over **stdio**, lists its tools, and namespaces them
  `mcp__<server>__<tool>` so they can never collide with a built-in tool. The
  client ships each tool's `{ name, description, inputSchema }` on
  `RunRequest.dynamicTools`; the engine builds a Mastra tool per definition
  (the JSON Schema converted to a model-facing zod schema by
  `zod-from-json-schema`, best-effort) and adds an `--- Additional tools ---`
  section to the executor's prompt. Servers are connected **once for the hub's
  lifetime** and reused (a server is a child process; reconnecting per turn
  would re-spawn it), so new or changed servers take effect on a window reload -
  unlike skills, which re-read per turn.
- **Same seam, same gate.** An MCP tool call dispatches back through the
  `WorkspaceToolHost` exactly like a built-in tool: the host gates **every** MCP
  call through the `Approver` (an MCP server is third-party code) and then calls
  `McpHub.execute`, which forwards to the server and flattens the result's
  content to text (capped at `settings.mcp.resultMaxChars`). The MCP server owns
  its tool's schema and validates the arguments, so the host forwards them as
  given rather than re-validating against a contract it does not have - the
  static five keep their strict contract validation untouched.
- **Trust-gated.** A server command comes from untrusted workspace
  configuration, so `McpHub` connects to nothing and offers no tools when
  `vscode.workspace.isTrusted` is false; a broken or slow server is skipped
  (bounded by `settings.mcp.connectTimeoutMs`), never failing the turn. The hub
  is disposed on deactivate, closing the server processes.
- **Scope.** stdio transport only; every MCP call is gated. Remote HTTP/SSE
  transport, MCP resources/prompts, and a per-tool trust allowlist are
  follow-ups (TODO.md chapter 26).

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
  followed by a `--- Drafted plan ---` section: the plan summary and the
  numbered steps as `title - detail` (`1. Find the file - locate it`). Steps
  name no tool; the executor decides how to carry each one out. The plan is
  guidance, not a script: the system prompt tells the model to follow it in
  order but skip steps already covered by earlier results.
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
  snippet ends in an `. . . (truncated)` line. Order is preserved because "searched,
  then wrote, then reported" *is* the answer. Previews are bounded
  (`settings.executor.*PreviewMaxChars`): the model saw the full values, the
  transcript only shows the user what happened. A run-level `error` chunk throws, failing the workflow step so
  the UI renders the executor error with the Ollama hint.
- **Progress checklists.** The executor also carries one engine-only tool,
  `progress` (`config/tools/progress.md`, no client implementation, no
  approval gate, and not in the planner's tool list so plans never mention it).
  The system
  prompt tells the model to call it from time to time - when it starts a step
  and as steps complete - passing the plan steps it wants to show by their
  1-based numbers with a status (`pending`/`in_progress`/`done`). The executor
  intercepts that `tool-call` chunk and, instead of a `tool` event, folds it
  into a `progress` event (a third `ExecutionEvent` kind) carrying just the
  reported step numbers and statuses; its result chunk is ignored. The model
  decides when to report, and the work continues in the same loop - the
  progress tool only prints a checklist, it never breaks the run between steps.
  A malformed or empty report is dropped (it fails to render, never the run).
  The client resolves each step number to its plan title at render time, so
  the event stays small and cannot drift from the drafted plan.
- **Streaming snapshots.** Like the planner's partial plans, the executor
  forwards grow-only snapshots to an optional `onPartial` callback: events
  are only appended, and only the last event still changes (a text event
  grows, a tool event gains its result). Each emission is a shallow copy, so
  a sink sees the state as of that moment, not a live view. Draining the
  stream is what drives the loop, so it runs even with no listener.
- **Thinking is a separate, ephemeral signal.** When the routed model is a
  reasoning model, its `<think>` monologue arrives on the same `fullStream` as
  `reasoning`/`reasoning-delta` chunks. The executor keeps these *out* of the
  transcript (they are not part of what the run produced) and instead condenses
  the buffer to its latest line (`condenseThinking`, `engine/core/thinking.ts`),
  forwarding it to an optional `onThinking` callback. That line travels as a
  `thinking` event the UI shows as transient progress and then drops - the
  "important pieces" of the model's reasoning, never the raw chain of thought,
  and never kept past the run. Capture is wired only when
  `myDevTeam.thinking.showInChat` is on, so off costs nothing.
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
  invokes the same `Approver` with the same command echo - and the engine
  never learns how the decision was made. A decline is not an error: the tool
  returns the "not approved" message and the system prompt tells the model to
  skip that action and note it in the report. `write` and `edit` are not
  gated, so they apply through the host without a prompt.

### Summarizer (`engine/core/summarizer.ts`)

The summarizer recaps an executed, file-changing run in three fixed sections so
the user can skim the change the way they would a pull request - the engine-side
counterpart to the mechanical **Changes:** line (`client/changeTracker.ts`),
which is the narrative to the latter's exact stat.

- **A structured-output agent, like the planner.** `Summarizer.summarize`
  streams a `{ whatShips, howItsBuilt, testsAndDocs }` object
  (`SummaryGenSchema`, whose `describe()` strings steer the model) through
  `parseWithRepair`, forwarding each partial snapshot and reporting usage under
  the `summarize` step - so a schema miss self-repairs and the extra call is
  metered, exactly as for triage and the planner. It carries no tools and routes
  to the fast tier (reasoning 0.6, speed 0.9): summarizing is cheap, low-stakes
  work.
- **Briefed from the transcript.** `summaryPrompt` (`engine/core/workflow.ts`)
  gives it the same request prefix the other agents saw, the drafted plan, and a
  rendered execution transcript (one line per tool call with its result, plus
  the model's commentary) - the transcript is the source of truth for what
  actually happened, so the agent describes only that.
- **Gated and best-effort.** The execute step runs it only when a summarizer is
  wired, `myDevTeam.summary.showInChat` is on (off skips the model call), and
  the transcript holds a successful `write`/`edit` (`executionChangedFiles`).
  The whole call is wrapped so a failure drops the summary and returns the
  executed reply unchanged - the work is already on disk; a recap is a nicety,
  never a reason to fail the run. The result rides the protocol as the reply's
  optional `summary` and a `summary-snapshot` event (`ProgressTranslator`),
  folded back by `ReplyFolder` and rendered by `formatSummary` beneath the
  transcript, prefix-extension-safe like the plan and answer.

### Tools (`tools/`)

Declared in `package.json` under `contributes.languageModelTools` and
registered with `vscode.lm.registerTool` in `registerTools.ts`. The
implementations in `workspaceTools.ts` are UI-agnostic, and every call -
from either surface - goes through the one `WorkspaceToolHost`
(`tools/toolHost.ts`), which validates the arguments against the protocol's
input schemas and dispatches. Dispatch is derived from the contract, not
written per tool: a handler map keyed by the `clientTools` names (typed
against each tool's schema, so it cannot drift from the contract) replaces a
hand-written switch, and `execute` is "look the tool up, parse with its
schema, call its handler". `registerTools.ts` registers each tool with
the Language Model Tools API delegating to the host (so any tool-calling
chat model in the editor can invoke them), and the engine's executor loop
reaches the same host through its tool proxies (`engine/core/agentTools.ts`).
Either way the same Approver gates the one gated tool, `run`.

| Tool                   | Effect                          | Approval        |
| ---------------------- | ------------------------------- | --------------- |
| `devteam__read`        | Read a file's text, whole or a line range | none (read-only)|
| `devteam__search`      | Glob file names or grep content | none (read-only)|
| `devteam__run`         | Run a shell command (configurable timeout, 60s default) | **Approver** (always) |
| `devteam__write`       | Create/overwrite a file         | **Approver** when `myDevTeam.approval.fileChanges` is on (off by default) |
| `devteam__edit`        | Replace text in an existing file | **Approver** when `myDevTeam.approval.fileChanges` is on (off by default) |

**Why `write`/`edit` are ungated by default.** The extension targets a
git-backed workspace, so a file the agent overwrites or edits is recoverable
from version control, and writing files is the executor's core job - prompting
on every file would make a routine multi-file change unusable. So out of the
box `write`/`edit` apply directly. Git is not a complete safety net (it does not
cover uncommitted edits, untracked files, or `.gitignore`d paths), and some
users want a confirmation step regardless, so the gate is **available as an
opt-in**: with `myDevTeam.approval.fileChanges` on, every write and edit goes
through the same `Approver` as `run` (Approve/Decline, the file untouched on a
decline). The write gate is asked after the path is validated and the
protected-path check passes; the edit gate is asked only once the edit is known
to apply (file exists, `oldText` matched uniquely), so the user is never
prompted for a change that would be refused or fail anyway. Whether or not the
gate is on, the protection that always remains is the path/symlink rejection (a
write can never escape the workspace) and run-cancellation (a stopped request
lands nothing). `run` is gated **unconditionally** because a shell command can
reach outside the workspace and is not git-recoverable. A richer alternative to
a per-write prompt - routing writes through VS Code's workspace-edit/undo API,
or a batched diff-review panel - remains the natural next step (see the roadmap);
the opt-in prompt is the lightweight option in the meantime.

**Protected in-workspace locations.** The git-backed rationale breaks for paths
that are *inside* the workspace yet not git-tracked and that the system executes
on its own - chiefly `.git/hooks/*` (runs on the next git command) and
`.vscode/tasks.json` (can run on folder open). An ungated write there would be
code execution that never passes the `run` approval gate. So `write`/`edit`
refuse a **protected path** outright (returning a reason the model relays, like
a declined action): `.git/` is always protected and not user-removable, plus
`myDevTeam.write.protectedPaths` (default `.vscode`) for the other auto-running
locations. The match is per path segment (so `.git` never catches `.gitignore`)
and case-insensitive (so a case-insensitive filesystem cannot bypass it with
`.GIT`). This is containment hardening of the same kind as the traversal/symlink
rejection, not a reinstated per-write prompt.

The tools treat their inputs as untrusted (they are callable by any
tool-calling chat model in the editor, not just `@devteam`):

- `read`/`write`/`edit` resolve paths against the workspace root and **reject
  anything that escapes it** (absolute paths, `..` traversal, and **symbolic
  links anywhere in the resolved path** - the target itself or any ancestor
  directory - since a link inside the workspace can point outside it). The
  symlink check is **check-then-use, not atomic**: the fs API offers no
  open-without-following-links, so each tool re-validates containment right
  against the operation (`revalidateContainment`) - `read` re-checks *after*
  reading and discards the bytes if a component became a link, `write`/`edit`
  re-check *immediately before* writing - which narrows the swap-in-a-link race
  to as small as the API allows rather than fully closing it. In a **multi-root
  workspace** `resolveFolder` first maps a path to its folder: a path whose
  first segment names an open folder (the `folderName/relative/path` form
  `asRelativePath` produces, and the form the search tool lists) resolves
  against that folder, a bare path against the first folder, and the
  containment/symlink checks then run per folder. Because the head segment is
  ambiguous (it can name a root *or* a real top-level directory in the first
  folder that shares that name), an **existing path in the first folder wins** -
  the head resolves to the named folder only when nothing exists at that path in
  the first folder - so a real file is never silently shadowed by a same-named
  root. The search tool scans all roots, so a path it returns is one
  read/write/edit can open - the two surfaces no longer disagree. A single-folder
  workspace behaves exactly as before. `write`/`edit` additionally refuse
  **protected in-workspace paths** (`.git/` always, plus
  `myDevTeam.write.protectedPaths`, default `.vscode`) - see the
  protected-locations note above.
- `read` returns at most **`myDevTeam.read.maxLines` lines per call** (plus a
  character backstop against enormous lines), so one read of a large file
  cannot flood a small model's context. It also **stats the file first and
  refuses anything over `read.maxFileSizeBytes` (10 MB)** with a notice, so a
  multi-GB or giant minified file is never pulled whole into the extension host
  just to be capped - the same size guard the attachment reader and the content
  scan apply. An optional `startLine`/`endLine` pair selects a 1-based inclusive
  range; a partial result is prefixed with the range shown, the file's total
  line count (counted `wc -l` style), and the `startLine` to continue with, and
  the tool description tells the model it can count a file's lines with a `run`
  command first.
- `edit` replaces an **exact, unique match**: the given old text must match
  exactly one place in the file (a model that misremembers the file gets a
  recovery instruction - re-read, or add surrounding lines - instead of a
  corrupted file), it never creates files (that stays `write`'s job), and an
  LF/CRLF mismatch between the model's snippet and the file is bridged by
  adapting the snippet, never by rewriting the file's line endings. The
  replacement is literal: `$&`-style substitution patterns in code are not
  interpreted. The file is read, the match located, and the replacement
  written back-to-back with no pause in between (only a containment re-check,
  which stats path components without re-reading), so the snapshot the match
  was computed against is the one the write lands on.
- `search` never scans `node_modules`, `.git`, `dist`, `out`, or `coverage`,
  and content mode skips binary and oversized files (see
  `config/settings.ts` for the limits; the result/scan caps are user-tunable
  via the `myDevTeam.search.*` settings). Content mode returns **one
  `path:line: <trimmed preview>` line per matching line** (not just the file
  path), so the model learns *where* a file matches and can follow up with a
  ranged `read` around that line instead of re-reading from the start. A
  per-file match cap (`search.contentMaxMatchesPerFile`) keeps one busy file
  from eating the overall `contentMaxMatches` budget, and each preview is
  trimmed and capped (`search.contentPreviewMaxChars`). Content search has
  **two engines behind one entry point** (`tools/contentSearch.ts`,
  `searchContent`): the **bundled ripgrep binary** is the fast path - VS Code
  ships `rg`, so when it can be located (the known `@vscode/ripgrep` paths under
  `vscode.env.appRoot`, asar-packed or unpacked) the search runs `rg --json
  --fixed-strings` per workspace folder and scans the whole workspace natively,
  with no per-file read into the extension host. It is bounded by match count
  (the per-file `--max-count` and the overall `contentMaxMatches` cap), not by a
  files-examined budget, so it never needs to flag truncation. When the binary
  cannot be found - a stripped build, a virtual (non-`file`) workspace ripgrep
  cannot reach, or a spawn failure - the search **falls back to a JavaScript
  scan** (`searchContentScan`) that reads each candidate through
  `vscode.workspace.fs` and substring-scans it on the host. The scan bounds the
  candidate file set only by a **generous `scanCandidateLimit` ceiling** (so the
  Uri array `findFiles` materialises cannot grow without bound on a very large
  repo), far above the files-examined budget so it never drops a file the budget
  would have reached - it does **not** cap at the budget itself (that silently
  dropped an arbitrary subset, so matches in them vanished). It examines files
  until the `contentMaxMatches` result cap or the `contentScanLimit`
  files-examined budget is reached, so a query whose matches fit the result cap
  is scanned to completion. When the files-examined budget (or the candidate
  ceiling) is hit with files still unscanned the scan result is **flagged
  truncated** and the tool appends a notice (`messages.search.contentTruncated`)
  so a short or empty result on a very large repo is not read as authoritative. Both engines
  return the same `{ path, line, preview }` shape (paths mapped to the same
  workspace-relative label the read tool resolves, multi-root prefix included),
  so callers never learn which one ran. The client's `#codebase` resolver reuses
  `searchContent` and folds the per-line matches back down to distinct files.
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
  the platform default `/bin/sh` elsewhere. The command's cwd is the first
  workspace folder; in a multi-root workspace the approval prompt names that
  folder so the user knows where it lands.
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

**Workspace trust and virtual workspaces.** The extension declares
`capabilities.untrustedWorkspaces: "limited"` and
`virtualWorkspaces: "limited"` (package.json), so VS Code keeps it active in
Restricted Mode and in virtual workspaces instead of disabling it wholesale.
The safe surface - triage, oneshot answers, `/explain`, and the read/search
tools - works everywhere. The side-effecting tools narrow themselves at the
implementation: `run`/`write`/`edit` check `vscode.workspace.isTrusted` and
refuse in an untrusted folder, and `run` also refuses in a virtual workspace
(it spawns a child process against a real cwd, which read/write/edit do not
need - they go through `vscode.workspace.fs`). A refusal returns a short reason
the model relays; no approval prompt is shown for an action that cannot run.

The only gated tool, `run`, calls `approver.confirm(title, detail)` with the
command echo, so a shell command - which can reach outside the workspace and
is not git-recoverable - never runs silently. The Phase-1 `ChatApprover`
renders the proposed command into the chat panel followed by inline **Approve /
Decline command links** (a single trusted-markdown block whose `isTrusted` is
scoped to just the `myDevTeam.approval` command, so the two choices sit on one
line rather than stacking as `stream.button` parts do) and blocks
the tool until one is clicked. Each request opens its own **approval session**
for its stream, keyed by the run id; a finished or cancelled request closes its
session, declining only its own still-pending approvals - so a run can never
hang on an unanswered question, and concurrent chat turns cannot settle (or
write into the stream of) one another's approvals. The handler binds the run's
tool calls to that session by tagging each `ToolHost.execute` with the run's
correlation id (the engine never sees it), so `confirm` renders the prompt in
the turn that owns the call rather than the most recently opened one - the
attribution is no longer best-effort. When the tool is invoked outside a
`@devteam` turn (the tools are registered editor-wide, so any chat model can
call them) the call carries no id and there is no session to ask in, so the
approver falls back to the most recent session and then to a modal dialog; a
prompt carrying an id whose session has already closed drops straight to the
modal rather than leak into a concurrent turn. A declined `run` returns "not approved" to the model, which is
told to skip the command. `write` and `edit` apply without a prompt by default,
but go through the same gate (and the same "not approved" decline) when
`myDevTeam.approval.fileChanges` is on (see [Tools](#tools-tools) for the
rationale).

### Token usage statistics (`client/usageStats.ts`)

The `usage` events (the billing seam above) feed three surfaces, all built on
one pure aggregation module so the same code runs over a single run's live
usage and over the whole stored log:

- **Where the counts come from.** Each agent reports the SDK's token counts
  when its model call exposes any, and otherwise a length-based estimate over
  the prompt and reply (`resolveTokenCounts` in `engine/core/usage.ts`), flagged
  `estimated`. So every model call contributes a record - statistics have no
  holes - while a `~` marks any total that includes an estimate, keeping
  measured and estimated counts honest. Reasoning, cached-input, and
  provider-total counts ride along on the event and into the records whenever
  the SDK reports them.
- **`usageStats.ts` is pure aggregation** (no vscode, no I/O): `sumUsage` folds
  one run's per-step entries into a `TokenSummary` (input, output, total,
  reasoning, cached-input, calls, and how many of those calls were estimated);
  `rollupUsage` folds the stored eval records into an overall total plus
  breakdowns by **step, model, route, and day**, an **input-by-source** sum
  (estimated input tokens per prompt section, from the events' `inputBreakdown`),
  a **feedback join** that charges each 👍/👎 click the tokens its run spent
  (paired by run id), and three run-level analyses: **speed** (from the run
  durations the handler records), **triage agreement** (pinned runs whose
  `triagePredicted` shadow matched the pinned route, with the misroute token
  cost), and **context growth** (input tokens of the first vs last run of each
  multi-run conversation, grouped by `conversationId`);
  `cacheHitRate`/`estimatedShare` derive the prefix-cache and estimate ratios,
  and `formatTokenCount` renders a count compactly (`1234` -> `1.2k`). Being
  I/O-free is what makes it trivially testable.
- **Three surfaces.** The chat handler appends a **Tokens:** line under each
  reply (`myDevTeam.usage.showInChat`, on by default); the single "My Dev Team"
  status button (`ui/statusBar.ts`) accumulates a running session total it shows
  in its menu, fed every finished run's usage by the handler independent of the
  eval-log setting; and
  the **"My Dev Team: Show Token Usage"** command (`ui/usageView.ts`) reads the
  eval log back (`EvalLog.readRecords`), rolls it up, and opens a markdown
  report. The report leads with a **Highlights** section scoring the things the
  design cares about - the input/output ratio (prompt weight), the prefix-cache
  hit rate (the "lead with the stable prefix" bet), the reasoning-token share,
  the estimated-vs-measured share (how soft the figures are), value per token
  (the tokens behind 👍 vs 👎), and - when the records carry them - run speed,
  triage agreement (with shadow triage on), and conversation context growth -
  then an **Input by source** table (estimated input tokens per prompt section,
  so you can see whether instructions, history, or attachments dominate the
  prompt) and the by-step/model/route/day tables.
  The report is the only surface that needs the opt-in eval log
  (`myDevTeam.telemetry.evalLog`); with no recorded runs it points the user at
  that setting.

### Change summary (`client/changeTracker.ts`)

A reply that wrote files ends with a **Changes:** line - e.g. "4 files changed,
+120 -30" - so the user sees the size of the batch at a glance, the way they
would the header of a PR. This is the first slice of the diff-review surface
(the rest - per-file diffs with Accept/Reject - stays a proposal, TODO chapter
17). It is built on the same client-seam pattern as the approver and the run
mirror:

- **The seam.** `write`/`edit` (`tools/workspaceTools.ts`) report each file they
  actually land to a `ChangeReporter` *after* the write succeeds, so a refused
  (protected/untrusted), declined, identical, or cancelled write contributes
  nothing. They report raw `{ path, before, after }`; the diff math lives in the
  client. A `write` reads the prior contents first so a brand-new file's
  `before` is empty (a pure create).
- **Per-turn sessions.** The `ChangeTracker` is one shared object handed to the
  `WorkspaceToolHost`, but each turn opens a session (the handler does this
  around the run, like `ChatApprover.openSession`). A reported write lands in the
  newest open session; unlike the approver - which the handler now binds to a
  run by correlation id - the tracker has no per-call seam, so under concurrent
  turns its attribution stays best-effort (a future fix could thread the same id
  to `report`). The session keeps the **first** `before` and the **latest**
  `after` per path, so a file written then edited in one turn nets out to a
  single entry rather than being double-counted.
- **The diff.** `tools/diff.ts` is a small LCS line-diff returning git-style
  added/removed counts (CRLF normalised, so a line-ending-only change counts as
  nothing); a net-zero file is dropped from the count. It is pure and I/O-free,
  like `usageStats.ts`.
- **Rendering.** The handler reads its session's summary after the reply and
  appends the **Changes:** line (`myDevTeam.changes.showInChat`, on by default;
  the line only appears when a turn changed files), just above the token line.
  It renders on a mid-run failure too (files may already have landed) but not on
  a cancelled turn, which renders nothing.

Because writes land client-side through the ToolHost whichever engine runs, the
tracker stays client-side and keeps working unchanged when the Phase B remote
engine is added.

## Current behavior

The extension activates at startup (`onStartupFinished` in package.json, in
addition to the implicit chat-participant event), so its UI is present before
the first `@devteam` request rather than appearing only after it. On activation,
the extension injects the engine's runtime config and the local engine's
SecretStorage secret source (loading any stored cloud keys), then asks the
selected engine for startup warnings; the local
engine pings the configured Ollama endpoint and warns (once, non-blocking) if
the server is down or an Auto-routed local model is not pulled - unless no
agent routes to Ollama, in which case it skips the probe and stays silent. A
single
"My Dev Team" status-bar button surfaces both: hovering it shows a rich popup (a
trusted markdown tooltip with command links, the same approach as Copilot's
status item) and clicking it opens a quick-pick menu, either way letting you
change the model or open the token-usage report. The hover and the menu rows
show the active model and the session token total.

You choose the model with `/model` (or the status button's menu): a registry id
pins the planner, answerer, and executor to that model, while `Auto` (the
default) routes each by capability among the available models - Ollama plus any
cloud provider (OpenAI, Anthropic) whose API key you have exported as an
environment variable. Triage is not affected by this choice - it has its
own `myDevTeam.triage.model` setting (empty defers to the backend
`agents.triage.model` default, a local Ollama model). Every
run renders a `**Model:**` line under the triage block naming what ran, so you
always know which model answered - especially in Auto mode.

Out of the box, `@devteam <prompt>`:

1. Resolves the workspace's instruction file (the first match in
   `myDevTeam.instructions.files`, `AGENTS.md` then `CLAUDE.md` by default),
   the request's references into labelled attachments - attached
   files/selections/symbols (an attached file beyond
   `settings.maxAttachmentReadBytes` becomes a too-large notice instead of
   being read), plus the inline `#codebase` (a quick workspace search) and
   `#changes` (the uncommitted git diff) markers, which are also stripped from
   the prompt - and the chat session's prior turns (your
   prompts and the participant's replies, capped per `settings.history`) into
   conversation history, and starts a
   protocol run on the selected engine (`myDevTeam.engine`, the in-process
   local engine by default) with all three alongside the prompt. The
   instructions reach the planner, answerer, and executor as a
   `--- Project instructions ---` section leading their prompts, so the
   repository's standing rules hold on every request. Follow-ups work:
   "now rename it too" reaches every agent with the turns that say what "it"
   is. A prior `/clear` cuts the history off at its marker, and a successful
   `/compact` replaces everything before it with its summary turn. While
   agents work, the chat shows VS Code's standard "Thinking"
   indicator - no custom progress labels are streamed. (`/clear` itself
   skips all of this: the handler confirms it in chat and starts no run.)
2. Triages the prompt as `oneshot` or `planning` via the capability-routed
   local Ollama model (currently `qwen3:8b`) - this stays a buffered
   structured-output call, since its whole product is a small validated
   object. If that object fails schema validation, the step self-repairs
   (`engine/core/repair.ts`): it re-asks the same model once with the original
   prompt plus the zod issues ("emit only the corrected JSON"), up to
   `settings.structuredOutput.repairAttempts` extra times, before the run fails
   for real - small local models routinely need that nudge. The repair is a
   real second model call, so it reports usage too (flagged `repaired` on the
   usage event and the eval-log record, so how often output needs repair stays
   measurable). A slash command (`/explain`, `/review`, `/plan`, `/do`, `/fix`,
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
   plan itself** - an ordered checklist (`summary` + at most 8 numbered steps,
   each a title and a one-sentence detail) appears
   incrementally while the planner's routed model (currently `qwen3:14b`, sized
   by triage's complexity) writes it. The planner also judges the plan's own
   `complexity`, shown as a `**Complexity:** …` line with the plan. Plan steps
   describe the work and its requirements in plain
   prose; they never carry code of any kind (no file contents, no snippets) -
   authoring the code is the executor's job (it is the routed coding
   specialist). The partial-JSON snapshots are rendered conservatively so the
   already-emitted markdown is never revised, and the validated final result
   completes the reply. Like triage, the planner self-repairs a plan that fails
   validation (`engine/core/repair.ts`): a repair re-streams a fresh plan that
   overwrites the partial snapshots already shown, and its usage is reported
   flagged `repaired`.
6. **Approves the plan, if asked to.** With `myDevTeam.planApproval` on `auto`
   (the default) a `complex` plan, or on `always` any plan, pauses before
   executing: the `ChatPlanReviewer` renders the plan into the chat followed by
   inline Approve / Cancel / Revise links. Approve executes; Cancel keeps the
   plan and runs nothing (the "nothing was executed" note, like `/plan`); Revise
   opens an input box for a comment, re-plans with it appended, and asks again.
   `never` (or a `/plan` run, which is plan-only anyway) skips the gate.
7. Then **executes the plan**: the
   executor's routed model (currently `qwen3-coder`, now sized by the planner's
   complexity) is briefed with the full
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
   default 5; `0` hides it); longer content ends in an `. . . (truncated)` line.
   From time to time the executor also calls its engine-only `progress` tool,
   which renders inline as a "**Progress:**" checklist of the plan steps with
   each one's status (done steps checked, the in-progress step noted); it only
   prints, so the loop keeps working without pausing between steps.
8. A `run` call still asks first: when the loop reaches one the `ChatApprover`
   renders the command into the chat, followed by inline Approve and Decline
   command links, and waits for the click. A cancelled request declines pending approvals
   automatically, and a `run` invoked outside a `@devteam` turn falls back to a
   modal dialog. Declining does not abort the run - the tool returns "not
   approved" to the model, which is instructed to skip that command and carry
   on, noting the skip in its report. `write` and `edit` apply directly by
   default (the workspace is git-backed - see [Tools](#tools-tools)), so the
   loop never pauses on a file change unless `myDevTeam.approval.fileChanges` is
   on, in which case each write/edit asks at the same gate as `run`.
9. When the executed run **changed files**, a **summarizer** then recaps it:
   its fast-tier routed model (currently `qwen3:8b`) is briefed with the
   request, the plan, and the execution transcript, and emits a three-section
   **Summary** (what ships / how it's built / tests and docs) as structured
   output, streamed in behind a "**Summary:**" header beneath the transcript
   (and self-repaired like the planner on a schema miss). It is gated three
   ways: a summarizer must be wired, `myDevTeam.summary.showInChat` must be on
   (default true; turning it off skips the extra model call entirely), and the
   transcript must contain a successful `write`/`edit` - a read/analyse-only run
   has nothing to recap. It is **best-effort**: the work is already on disk, so
   a summarizer failure drops the summary rather than failing the run. The
   executor's own closing note is now just a short line, since the structured
   Summary is the real recap.
10. Every approved command's real output also streams into the **"Dev Team"
   terminal** in the terminal panel: open the tab to watch commands run live,
   or later to read the session log of everything the agent executed
   (replayed in full when the terminal is opened). The chat transcript keeps
   showing only the truncated previews.

The five workspace tools also stay registered with `vscode.lm`, callable by
any VS Code chat model that supports tool calling - every call goes through
the same `WorkspaceToolHost` validation (and, for `run`, the approval gate)
the engine uses.

Each step's model call also emits a protocol `usage` event (model + token
counts - the SDK's, or a length-based estimate flagged `estimated` when the
SDK reports none); the chat handler logs them, sums them into the per-reply
**Tokens:** line (`myDevTeam.usage.showInChat`, on by default; a `~` marks a
total that includes an estimate), feeds them to the status button's session total,
and collects them per run - the data the future backend's billing meters. The
**"My Dev Team: Show Token Usage"** command rolls the recorded runs up into a
markdown report (`client/usageStats.ts` + `ui/usageView.ts`). With
`myDevTeam.telemetry.evalLog` enabled (it is off by default), every finished run
lands as one JSON line in an `eval-log.jsonl` under the extension's global
storage - run id, conversation id, slash command, triage route, outcome,
duration, the collected per-step usage (model + token counts), and (with
`myDevTeam.telemetry.shadowTriage` on) what triage would have decided on a
pinned run - and every 👍/👎 click on a reply is recorded next to it, paired
with its run through the turn's chat result metadata, so routing and prompt
changes can be measured against real feedback per token spent. The conversation
id (threaded through the turn metadata) groups a thread's runs to track context
growth; the shadow prediction scores triage against the command the user chose;
the duration drives the speed stat. The report reads this log, so it is
populated only when the setting is on. The records carry no prompt text, file
contents, or reply text, and the log never leaves your machine.

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
  ollama pull qwen3:8b         # currently selected for triage, the answerer, and the summarizer
  ollama pull qwen3:14b        # currently selected for the planner
  ollama pull qwen3-coder      # currently selected for the executor
  ollama pull gemma3:4b        # registered fast fallback
  ```

  If your server listens elsewhere, set `myDevTeam.ollama.endpoint`; the
  activation health check will tell you if the endpoint or a routed model is
  missing.
- **Cloud models (optional).** To use OpenAI, Anthropic, or Groq models, export
  the key as the `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GROQ_API_KEY`
  environment variable in the environment VS Code launches from (or, when using
  the local engine, store it with the "My Dev Team: Set API Key" command). For
  Azure or another gateway, point `myDevTeam.openai.baseUrl` /
  `myDevTeam.anthropic.baseUrl` / `myDevTeam.groq.baseUrl` at it. Then pick the
  model with `/model`; with no key set, those models show as unavailable and
  `Auto` stays on Ollama.

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
`/fix`, `/test`, `/compact`, `/clear`, `/model`): a command pins the route without a
triage call and frames the request for the agents, the context commands
manage what history later requests carry, and `/model` chooses the model - see
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
| [`editing.md`](examples/editing.md) | `planning` | The `edit` tool: read first, exact-match replacement (applied directly, not gated) |

After touching a routing-relevant surface, run a few prompts from each file
in the Extension Development Host and check that triage picks the expected
route, the plan reads sensibly, and the execution lands. With
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
- **Fuller project-instruction support.** Today one root-level file
  (AGENTS.md/CLAUDE.md) is read whole; the agents.md spec's nested
  per-directory files (with merge rules) and CLAUDE.md-style `@import`
  includes are candidates once the executor is directory-aware, as is a
  one-line "instructions loaded from AGENTS.md" note in the reply.
- **Add a Webview front end.**
  1. Add a `WebviewApprover implements Approver` with a diff/confirm UI.
  2. Pass it instead of `ChatApprover` in `extension.ts`.
  3. Optionally add a Webview panel as a second front-end calling the same core.

  The engine and tools require **no changes**.
