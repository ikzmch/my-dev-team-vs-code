# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.48.0] - 2026-06-15

### Added

- **Sidecar lifecycle resilience.** The sidecar engine now recovers from a
  crashed child: the dead instance is dropped and the next request forks a fresh
  one, and after repeated crashes in a short window it gives up, warns once, and
  falls back to the local engine until you switch engines - instead of a single
  transient crash bricking `@devteam` for the rest of the session.
- **Sidecar readiness and version handshake.** The child now announces itself
  before any run; the editor holds the first run until it is up and rejects a
  stale `dist/sidecar.js` with a clear "bundle out of date, reload" message
  rather than mis-serialising mid-run, and a child that fails to start fails the
  run with a timeout instead of hanging it.
- **NDJSON stream transport for the sidecar.** Alongside the forked-process
  channel, the same engine/client pair can now talk over a newline-delimited-JSON
  stream (`createStreamChannel`), proving the protocol works over a socket or
  stdio - the transport a future remote backend or non-VS-Code (JVM/Kotlin)
  client would target.

### Fixed

- **Sidecar queries no longer hang the editor.** `listModels` and
  `startupWarnings` time out instead of waiting forever on a wedged child, so the
  `/model` picker and the activation health check cannot stall. A failed or
  timed-out health probe now surfaces as a warning rather than silently reporting
  "no warnings".
- **Sidecar child no longer breaks under the debugger.** The forked child is
  launched without inheriting the extension host's `--inspect` flags (which made
  it fail to bind an already-used inspector port), and uses structured-clone IPC
  so `undefined`-valued tool arguments survive the trip across the process
  boundary.

## [0.47.1] - 2026-06-15

### Added

- **Sidecar warns when a stored API key would be ignored.** Selecting the
  `sidecar` engine while a provider's key is set only via "Set API Key"
  (SecretStorage), with no matching environment variable, now shows a one-time
  notice naming the provider and its env var - so a key does not silently stop
  working when you switch engines.

## [0.47.0] - 2026-06-15

### Added

- **Sidecar engine option.** `myDevTeam.engine` gains a `sidecar` choice that
  runs the same agent pipeline in a separate Node process while the tools,
  approval, and rendering stay in the editor - isolating the engine and proving
  out the wire protocol for a future remote backend or non-VS Code client. The
  default stays `local`.
- **Per-provider request rate in the deployment config.** A deployment can now
  set a request-per-minute rate for each provider in `config/backend.json`
  (`providers.<id>.requestsPerMinute`), so it can size each gateway's quota
  independently instead of sharing one global number. The shipped default is `0`
  (no throttle) everywhere, so behaviour is unchanged until a rate is set.

### Changed

- **Cloud API keys: env vars everywhere, SecretStorage for the local engine.**
  Keys are resolved per engine: the in-process `local` engine still accepts keys
  stored in the editor via the "Set API Key" command (SecretStorage), falling
  back to `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GROQ_API_KEY`; the `sidecar`
  engine (and a future remote) read **only** those environment variables, which
  the child inherits, so no secret crosses the process boundary.

- **`myDevTeam.provider.requestsPerMinute` is now an override of that default.**
  Left unset (its new default), it uses the deployment's per-provider rate; set
  to a number, the user's value wins outright in either direction (raise or
  lower), since a request rate is the user's own quota to manage.
- **Your endpoint/base-URL settings win over the bundled config.** The
  `config/backend.json` provider `endpoint`/`baseUrl` values are now deployment
  *defaults* rather than enforced overrides: when you set
  `myDevTeam.ollama.endpoint` or a provider `*.baseUrl`, your value wins, so you
  can always point the extension at your own server. (`myDevTeam.ollama.endpoint`
  now defaults to blank, meaning "use the deployment default, then localhost".)
  The disabled-provider/model lists remain the one enforced floor.

## [0.46.1] - 2026-06-15

### Fixed

- **No Ollama warning on a fully cloud setup.** The startup health check no
  longer pings the Ollama server or warns that it is unreachable when no agent
  routes to Ollama (e.g. triage pinned to a cloud provider and the local
  provider disabled). It now warns only when a model the run actually needs
  lives on Ollama.

## [0.46.0] - 2026-06-15

### Added

- **Triage model is now a user setting.** The new `myDevTeam.triage.model`
  setting chooses what the quick triage step uses (`provider:openai`, `auto`, a
  model id, ...), so a user with no Ollama server can run entirely on a cloud
  provider without repackaging the extension. Empty (the default) keeps the
  build's `agents.triage.model` floor, and the disable layers still apply.

## [0.45.0] - 2026-06-15

### Changed

- **OpenAI model upgraded from GPT-4o to GPT-4.1.** The registered OpenAI model
  is now `gpt-4.1` (id `openai-gpt41`), bringing stronger coding and instruction
  following so the router can pick a more capable cloud model for the same tier.

## [0.44.0] - 2026-06-14

### Added

- **MCP (Model Context Protocol) tool support.** Configure stdio MCP servers in
  the new `myDevTeam.mcp.servers` setting and `@devteam`'s executor can call
  their tools alongside the built-in ones. The client discovers each server's
  tools (namespaced `mcp__<server>__<tool>`) and ships them on the run request;
  every MCP call is approved through the same prompt the `run` tool uses, and no
  server is contacted in an untrusted workspace. This is the first half of the
  workspace-extensibility roadmap (TODO.md chapter 26).

## [0.43.1] - 2026-06-14

### Fixed

- **`read` tool now refuses oversized files by their size.** A `read` checks the
  file's size first and refuses anything over a 10 MB cap with a notice, instead
  of loading the whole file into memory before the line/char caps apply - so a
  multi-GB or giant minified file can no longer exhaust the extension host's
  memory. The `#codebase` snippet reader inherits the guard.
- **Run approvals are attributed to the turn that owns them.** Each chat turn now
  binds its tool calls to its own approval session by run id, so under concurrent
  `@devteam` turns a `run` (or gated write/edit) approval renders in the turn
  that triggered it rather than the most recently opened one; when the owning
  session is gone it falls back to a modal.

### Changed

- **Eval log appends no longer re-read the whole file.** The opt-in eval log
  keeps its contents in memory and appends to that, so a long telemetry session
  no longer re-reads and re-decodes the growing file on every record. The
  content scan's no-ripgrep fallback also bounds its candidate file list so it
  cannot grow without bound on a very large repository.

## [0.43.0] - 2026-06-14

### Added

- **Optional approval for file changes.** A new `myDevTeam.approval.fileChanges`
  setting (off by default) gates the `write` and `edit` tools behind the same
  Approve/Decline prompt the `run` tool uses, so you can confirm every file
  change before it lands. Off by default keeps the current behaviour - changes
  apply straight away, since a git-backed workspace makes them recoverable - and
  the `run` tool stays gated regardless.

## [0.42.0] - 2026-06-14

### Added

- **Plan approval gate.** The planner now judges each plan's complexity, and a
  new `myDevTeam.planApproval` setting decides when `@devteam` pauses for your
  sign-off before executing: `auto` (the default) pauses only on a `complex`
  plan, `always` on every plan, `never` runs straight through as before. At the
  gate you can Approve (execute), Cancel (keep the plan, run nothing), or Revise
  (type a comment and have the plan redrafted, then asked again).

### Changed

- **Complexity routing is now two-stage.** The planner's model is sized by
  triage's quick complexity guess, and the executor's by the planner's own,
  better-informed judgement made after it has seen the request. The complexity
  shown in the reply is the planner's, rendered with the plan.

## [0.41.1] - 2026-06-14

### Changed

- **A single provider descriptor.** Each model provider is now described once,
  in a single registry (`config/providers.ts`): its id, label, key requirement,
  secret/env key names, base-URL setting, and how to build it. The model
  `provider` enum, the provider labels, the API-key maps, the base-URL settings,
  and the provider wiring all derive from that one list, and a model file naming
  an unknown provider now fails at load with a clear message. Adding a provider
  is one descriptor plus its npm import instead of a five-file edit. No
  user-facing behavior change.

## [0.41.0] - 2026-06-14

### Changed

- **Content search runs on ripgrep.** The `search` tool's content mode (and the
  `#codebase` reference) now use VS Code's bundled `ripgrep` binary to scan the
  whole workspace natively instead of reading every candidate file into the
  extension host - much faster on a large repo, and bounded by match count
  rather than a files-examined budget. The previous in-process scan stays as an
  automatic fallback for when the binary is unavailable (a stripped build, a
  virtual workspace, or a spawn failure), so results are identical either way.

## [0.40.1] - 2026-06-14

### Changed

- **Tool dispatch derives from the contract.** The tool host's hand-written
  per-tool switch is gone; it now dispatches through a handler map keyed by the
  protocol's tool-contract names and typed against each tool's schema, so the
  name set can no longer drift between the contract, the host, and the editor
  registrations. No behavior change - same validation, approval gate, and
  results.

## [0.40.0] - 2026-06-14

### Added

- **Disable providers and models.** You can now take a provider or an individual
  model out of play, at two layers. As a user, the new
  `myDevTeam.disabledProviders` and `myDevTeam.disabledModels` settings switch
  them off: the router never routes to them and the `/model` picker shows them as
  disabled, even if an API key is set. The build also carries an operator floor
  (`engine/config/backend.json`) for providers/models disabled for everyone,
  which a user setting cannot re-enable. Disabling is a hard block - a disabled
  choice never runs even when pinned; the run falls back to Auto among the
  enabled models.
- **Operator endpoint overrides.** The same `engine/config/backend.json` can pin
  each provider's endpoint for everyone - Ollama's `endpoint` and the cloud
  providers' `baseUrl` - and the override wins over the matching user setting, so
  a build can point all four providers at a corporate gateway.
- **Configurable triage model.** `backend.json`'s `agents.triage.model` now
  controls how the internal triage classifier is routed: a model id pins that
  exact model, a provider name routes by capability within it, and the default is
  the "ollama" provider (the local models, as before). Lets an operator give
  triage a sharper model without touching the model the user picked for the work.

## [0.39.1] - 2026-06-14

### Changed

- **Inline approval choices.** The Approve / Decline prompt for a `run` command
  now renders as two links on a single line instead of stacked buttons, so the
  approval takes one row in the chat rather than three. Clicking either still
  works exactly as before.

## [0.39.0] - 2026-06-14

### Added

- **Skills.** `@devteam` can now load named, described instruction packages on
  demand: when a task matches a skill's description, the executor pulls in its
  full instructions and follows them, so reusable know-how (how to write a
  commit message, format a changelog entry, follow a team convention) lives in
  one place instead of being repeated in every prompt. A few skills ship
  built-in, and you can add your own by dropping a `SKILL.md` under
  `.devteam/skills/<name>/` (or `.claude/skills/<name>/`) - either in your
  workspace (a project skill) or in your home directory (a personal skill shared
  across projects), with the project one winning a name clash. The directories
  are configurable with the new `myDevTeam.skills.directories` setting. Skills
  are loaded only when relevant, so they cost nothing on a task that does not use
  them.

## [0.38.0] - 2026-06-14

### Added

- **Live thinking.** When a reasoning model is in use, `@devteam` now shows a
  dimmed **Thinking** line while it works - a one-line glimpse of what it is
  currently reasoning about, replaced as it goes and dropped once the real
  answer or transcript arrives. It is never kept past the run. Turn it off with
  the new `myDevTeam.thinking.showInChat` setting, which also skips capturing
  the model's reasoning entirely.

## [0.37.0] - 2026-06-14

### Added

- **End-of-run summary.** After a task that changes files, the reply ends with
  a **Summary** recap in three sections - What ships, How it's built, and Tests
  and docs - so you get a pull-request-style overview without rereading the
  whole transcript. It runs only when files changed and can be turned off with
  the new `myDevTeam.summary.showInChat` setting (which also skips the extra
  model call).

## [0.36.0] - 2026-06-14

### Added

- **Change summary line.** A reply that writes files now ends with a
  **Changes** line - "N files changed, +X -Y" - so you can see the size of an
  edit at a glance, the way you would skim a pull request. It appears only when
  a turn actually changed files and can be turned off with the new
  `myDevTeam.changes.showInChat` setting.

## [0.35.1] - 2026-06-13

### Security

- **Symlink containment re-validation.** The path-safety check that rejects
  symbolic links is now re-run right against each file operation (`read`
  re-checks after reading and discards the bytes; `write`/`edit` re-check just
  before writing), narrowing the small window in which a path component could be
  swapped for a link pointing outside the workspace.

### Fixed

- **Multi-root paths no longer shadow real directories.** In a multi-root
  workspace, a path like `backend/x` used to always route to a `backend` root
  even when the first folder had a real `backend/` directory, so a search result
  could open a different file than expected. An existing path in the first folder
  now wins, and the folder-name routing applies only when nothing exists there.
- **`read` no longer overstates a truncated range.** When a requested line range
  was larger than the 200k-character backstop, the "lines X-Y" header still
  claimed the full range while the tail was dropped, so the model could act on
  lines it never received. The result is now capped at a line boundary and the
  header reports only the lines actually returned.

## [0.35.0] - 2026-06-13

### Added

- **Editor entry points.** You no longer have to start in the chat panel: a
  **Fix with Dev Team** Quick Fix appears on a diagnostic (sends `/fix` with the
  problem and your uncommitted changes), an **Explain with Dev Team** action sits
  in the editor right-click menu for a selection (sends `/explain`), and a
  **Write/update tests** CodeLens (it reads **Repair tests** when the file has
  errors) tops a test file (sends `/test`). Each is a thin shim that opens the
  chat with the command prefilled, so routing, attachments, and approvals are
  unchanged.

## [0.34.0] - 2026-06-13

### Security

- **Protected in-workspace locations for write/edit.** The ungated `write`/
  `edit` tools now refuse paths that, although inside the workspace, can run
  code on their own and so would sidestep the `run` approval gate: `.git/`
  (always, e.g. `.git/hooks/*`) plus the configurable
  `myDevTeam.write.protectedPaths` (default `.vscode`). The match is per path
  segment (so `.git` never catches `.gitignore`) and case-insensitive.
- **Prompt-injection hardening.** The planner, answerer, and executor prompts
  now frame attached files, tool results, and file contents as untrusted data
  to act on, not instructions to follow, so text embedded in workspace content
  cannot redirect a run.

### Fixed

- **Content search no longer silently misses matches.** The search tool used to
  cap the candidate files before scanning them, so on a large repo matches in
  the dropped files vanished and `#codebase` was non-deterministic. It now scans
  to completion for any query whose matches fit the result cap, and when a very
  large repo exceeds the files-examined budget it says so instead of presenting a
  partial result as complete.
- **Rate limiter no longer wastes a slot on a cancelled request.** When a
  throttled request is cancelled while waiting for its send slot, the slot is
  now handed back, so the calls behind it are not pushed needlessly further out
  and the provider's quota is not under-used after a cancellation.

## [0.33.0] - 2026-06-13

### Added

- **Complexity-based executor model routing.** Triage now also judges how
  demanding a request is (simple, moderate, or complex) and the executor's
  model is sized to it: trivial work (e.g. a command-line calculator) routes to
  a cheaper/smaller model and hard work (multi-file changes, subtle debugging)
  to the strongest one, within whatever provider applies (Ollama included).
  Each registered model carries a `tier`, and the router narrows the executor's
  candidates to the request's tier before picking by capability, falling back
  to the nearest available tier when a provider lacks one. A pinned model is
  never affected, and the new `myDevTeam.complexityRouting` setting (on by
  default) turns the whole behaviour off. The detected complexity is shown
  under the planning reply.

## [0.32.0] - 2026-06-13

### Added

- **Multi-root workspace support.** The file tools now resolve a
  `folderName/relative/path` (the form the search tool lists across all open
  folders) against the named folder, so a path the search tool returns is one
  the read/write/edit tools can actually open - previously files outside the
  first folder were unreachable and search could hand back paths the other
  tools rejected. Bare paths and single-folder workspaces behave exactly as
  before; in a multi-root workspace the `run` approval prompt also names the
  folder the command runs in.

- **Runs in Restricted Mode and virtual workspaces.** The extension now stays
  active in an untrusted folder and in a virtual workspace instead of being
  disabled wholesale. Triage, answers, `/explain`, and the read/search tools
  keep working; the side-effecting tools narrow themselves - `run`, `write`,
  and `edit` refuse in an untrusted folder, and `run` refuses in a virtual
  workspace (it needs a real local filesystem) - each with a reason the agent
  relays rather than an opaque failure.

- **Content search returns line numbers and a match preview.** A content
  search now returns one `path:line: <trimmed line preview>` result per
  matching line instead of just the file path, so the model can jump straight
  to a ranged read around the match rather than re-reading the whole file -
  fewer round trips and less wasted context, which matters most for small
  local models. A per-file match cap keeps one busy file from eating the
  result budget, and the previous scan, size, and binary guards are unchanged.

- **Self-repair for malformed structured output.** When triage or the planner
  emits JSON that fails schema validation - a common failure on small local
  models - the step now re-asks the same model once with the validation error
  appended ("emit only the corrected JSON") before failing the run, instead of
  dying on a single bad generation and making the user retype the request. The
  repair is a real second model call, so its tokens are still metered and the
  eval log marks the run `repaired`, keeping routing quality measurable. The
  retry budget is the compile-time `structuredOutput.repairAttempts` (one, by
  default).

## [0.31.0] - 2026-06-13

### Changed

- **One "My Dev Team" status-bar button.** The separate model-picker and
  token-counter status-bar items are now a single **My Dev Team** button whose
  menu offers **Select model** (with the active model) and **Token usage** (with
  the running session total), so the two surfaces read as one and take less room
  in the status bar.
- **Activate at startup.** The extension now activates when VS Code finishes
  starting up, so the status-bar button is there from launch instead of
  appearing only after the first `@devteam` request.

### Added

- **Rich hover on the status button.** Hovering the **My Dev Team** status-bar
  button now shows a popup with the active model and session token total plus
  clickable **Select model**, **Token usage report**, and **Set API key** links
  - the same hover-with-actions approach as Copilot's status item.

## [0.30.0] - 2026-06-13

### Added

- **Request rate limiting.** A new `myDevTeam.provider.requestsPerMinute`
  setting caps how many model requests per minute are sent to each provider,
  spacing calls so a run stays under a provider's quota (e.g. a Groq free-tier
  limit) instead of firing until one is rejected. Applied per provider, so a
  local Ollama call never spends a cloud provider's budget; `0` (the default)
  disables it.

### Fixed

- **Graceful rate-limit handling.** A provider rate-limit response (HTTP 429) is
  now caught and retried automatically after the delay the provider suggests
  (its `retry-after` header or "try again in Ns" hint), so transient limits
  recover on their own instead of failing the run. A limit that outlasts the
  retries now fails with a hint pointing at the throttle setting rather than the
  API-key hint.

## [0.29.0] - 2026-06-13

### Added

- **Groq provider.** Added Groq (groq.com) as a fourth model provider alongside
  Ollama, OpenAI, and Anthropic, with two registered models served on Groq's
  fast inference: GPT-OSS 120B (`openai/gpt-oss-120b`) and Qwen3 32B
  (`qwen/qwen3-32b`). Set the key with the "My Dev Team: Set API Key" command or
  the `GROQ_API_KEY` environment variable, then pick a model (or the "Groq (best
  available)" provider choice) with `/model`. An optional `myDevTeam.groq.baseUrl`
  points the provider at a proxy or gateway.

## [0.28.0] - 2026-06-13

### Added

- **Token usage statistics.** Every reply now ends with a **Tokens:** line
  summing the run's input and output tokens (turn it off with
  `myDevTeam.usage.showInChat`), a status-bar counter tracks the running session
  total, and a new "My Dev Team: Show Token Usage" command opens a report: a
  Highlights section (input/output ratio, prompt-cache hit rate, reasoning
  share, estimate share, and the tokens behind 👍 vs 👎), an Input-by-source
  table that shows whether project instructions, conversation history, or
  attachments dominate your prompts, and breakdowns by step, model, route, and
  day. When a provider reports no counts, a
  length-based estimate stands in and is marked with a `~`, so the statistics
  have no holes. The report reads the opt-in eval log
  (`myDevTeam.telemetry.evalLog`), which now also stores reasoning, cached-input,
  and total token counts when a model exposes them.
- **Deeper usage analysis.** The Show Token Usage report gained run-level
  insight: how long runs take (and tokens/second), how input tokens grow as a
  conversation accumulates history, and - with the new opt-in
  `myDevTeam.telemetry.shadowTriage` - how often triage agrees with the route a
  slash command pins (and what the disagreements cost). The eval log now records
  a conversation id, the run duration, and the shadow triage prediction.

## [0.27.0] - 2026-06-13

### Added

- **Choose a model, a provider, or let Auto pick.** A new `/model` command (and
  a status-bar item) lets you select what @devteam uses: a specific model, a
  whole provider (it then picks the best model per task within it, e.g.
  `/model anthropic`), or **Auto** (the default) which routes each part of your
  request to the best available model. Every reply shows which model ran on a
  **Model:** line.
- **Cloud models alongside local Ollama.** OpenAI (GPT-4o) and Anthropic
  (Claude Opus 4.8, Sonnet 4.6, Haiku 4.5) join the model registry. Add a key
  with the new "My Dev Team: Set API Key" command (stored securely in
  SecretStorage, never in settings.json) or via `OPENAI_API_KEY` /
  `ANTHROPIC_API_KEY`. For Azure or another gateway, set
  `myDevTeam.openai.baseUrl` / `myDevTeam.anthropic.baseUrl`. Triage always
  stays on a fast local model.

## [0.26.0] - 2026-06-13

### Added

- **`#codebase` and `#changes` references.** Type `#codebase` in your message
  and the agent searches your workspace for relevant code and attaches the
  matching files (with a peek at the top ones); type `#changes` and it attaches
  your uncommitted git changes - handy for "review what I changed" or "fix the
  bug I just introduced". The markers are resolved into context and removed from
  the prompt, so you no longer have to find and attach the right files yourself.

### Changed

- **Symbol and other references are no longer dropped.** A symbol you attach is
  now inlined with its definition's line range, and any reference the agent
  cannot read (e.g. an image) leaves a short "Unsupported reference" note
  instead of vanishing, so the models always know what you pointed at.

## [0.25.0] - 2026-06-13

### Changed

- **Plans no longer label each step with a tool.** A drafted plan step is now
  just a title and a one-sentence detail; which tool (if any) a step needs is
  the executor's decision when it carries the step out, not something the plan
  commits to up front. The per-step tool badge is gone from the plan display
  and the executor briefing. The planner still knows what the executor can do,
  so it keeps planning only doable work. The protocol version is bumped to 2
  because the plan step shape changed.

## [0.24.0] - 2026-06-13

### Added

- **Progress checklists during execution.** As it carries out a plan, the agent
  now prints a "Progress" checklist from time to time - the plan steps with each
  one's status (done, in progress, or pending) - so you can see where things
  stand on a long multi-step task. The agent decides when to show it; it never
  pauses the work or adds steps, it only reports.

## [0.23.1] - 2026-06-13

### Changed

- **Planner drafts coarser steps.** The planner is now instructed not to split
  one deliverable across steps - creating a file and writing its contents is a
  single `write`, and several changes to one file for one purpose are a single
  `edit` - so plans stop padding out with tiny "create the file" then "fill in
  its contents" steps.

## [0.23.0] - 2026-06-13

### Changed

- **Writing and editing files no longer asks for approval.** The `write` and
  `edit` tools now apply directly instead of prompting Approve/Decline; only
  `run` (shell commands) still asks first. The workspace is git-backed, so a
  file the agent changes is reviewable and revertible in source control, and
  prompting on every file made routine multi-file changes tedious. The
  workspace path and symlink checks still apply (a write can never escape the
  workspace), a cancelled request still lands nothing, and the chat transcript
  still shows the first lines of each change (`myDevTeam.chat.toolSnippetLines`,
  default 5).

## [0.22.0] - 2026-06-12

### Added

- **Project instruction files (AGENTS.md / CLAUDE.md)**. A workspace's
  `AGENTS.md` (or `CLAUDE.md`) is now read on every request and given to the
  agents as standing instructions, so project conventions hold without
  repeating them in chat; edits to the file take effect on the next message.
  The probed file names are configurable via `myDevTeam.instructions.files`
  (an empty list turns the feature off).

## [0.21.1] - 2026-06-12

### Security

- **Symbolic links are rejected anywhere in a tool path**. The read, write,
  and edit tools now check every component of a path, not just its last one,
  so a symlinked directory inside the workspace can no longer be used to
  read or overwrite files outside it.
- **The run tool's output to the model is capped**. A chatty command used to
  hand the model up to the full 10 MiB capture; the result is now truncated
  (head and tail kept) so one command cannot flood the model's context.

### Fixed

- **Concurrent chat turns no longer disturb each other's approvals**. Each
  request now opens its own approval session, so a turn that finishes or is
  cancelled declines only its own pending Approve/Decline questions instead
  of everyone's.
- **Edits are re-verified after approval**. If a file changed while the
  approval prompt was open, the edit now applies to the current contents (or
  reports the match gone) instead of silently writing back the pre-approval
  snapshot and reverting the concurrent change.
- **Cancelling an editor-wide tool call now works**. Tool invocations from
  other chat models forward their cancellation to the tools, so a cancelled
  command is killed instead of running to its timeout.
- **Cancelled or timed-out commands are fully killed on macOS/Linux**. The
  whole process group is signalled, so grandchild processes no longer
  survive; previously only Windows took down the full tree.
- **Oversized attachments no longer spike memory**. A file beyond the read
  cap is answered with a short too-large notice instead of being read whole
  just to keep its first lines.
- **The write tool now announces its approval requirement** to other chat
  models in its editor-wide description, matching run and edit.
- **One giant eval-log record can no longer wipe the log**. The size-cap
  trim keeps such a record alone instead of emptying the file.

## [0.21.0] - 2026-06-12

### Added

- **/compact and /clear context commands**. `/compact` summarizes the
  conversation so far, and the summary then stands in for all earlier turns
  in future requests - so a long session's decisions survive the history cap
  instead of silently falling away; a failed or cancelled compact leaves the
  history untouched. `/clear` starts fresh without opening a new chat: it is
  answered by the client (no engine run) and later requests drop everything
  before it. The chat panel still shows the full conversation; the commands
  only change what the models receive.

## [0.20.0] - 2026-06-12

### Changed

- **Read tool reads in line ranges**. `devteam__read` now returns at most a
  configurable number of lines per call (`myDevTeam.read.maxLines`, default
  200) and accepts an optional 1-based `startLine`/`endLine` range. A partial
  result is prefixed with the range shown, the file's total line count, and
  the line to continue from, so one read of a large file no longer floods a
  small model's context window.

## [0.19.0] - 2026-06-12

### Added

- **Slash commands**. `@devteam` now offers `/explain`, `/review`, `/plan`,
  `/do`, `/fix`, and `/test`. A command pins the route directly - no triage
  model call, no chance to misroute - and frames the request for the agents
  (e.g. `/fix` briefs them to diagnose the root cause before editing);
  `/plan` stops after the plan is drafted so the steps can be inspected
  before anything runs. Commands are discovered `.md` config files like the
  models and tools, and travel on the protocol by name only.

## [0.18.0] - 2026-06-12

### Added

- **Edit tool for targeted file changes**. A fifth workspace tool,
  `devteam__edit`, replaces an exact, unique text match in an existing file,
  so the executor no longer has to rewrite a whole file for a small change.
  A zero or ambiguous match returns a recovery instruction instead of
  touching the file, line-ending mismatches are bridged without rewriting
  the file's endings, and the approval prompt shows a diff-style old/new
  preview. The write tool stays the way to create files or fully rewrite
  them.

## [0.17.0] - 2026-06-12

### Added

- **Local eval log for feedback and usage**. The opt-in
  `myDevTeam.telemetry.evalLog` setting stores each run's route, per-step
  model and token usage, and outcome, plus the 👍/👎 feedback paired to its
  run, as JSON lines in the extension's global storage - so routing and
  prompt changes can be measured against real feedback. No prompt or reply
  text is recorded and nothing leaves the machine.

## [0.16.0] - 2026-06-12

### Changed

- **Write tool asks for approval again**. `devteam__write` is gated by the
  Approver once more: the user confirms the target path above a capped
  preview of the new contents before anything lands on disk, and a declined
  or cancelled write leaves the file untouched.

## [0.15.0] - 2026-06-12

### Changed

- **Split UI and engine**. The agent pipeline moved behind a typed
  engine protocol (`src/protocol/`) with an in-process `LocalEngine`, streamed
  run events, and inverted tools that delegate to the client's `ToolHost`,
  preparing a future remote backend. Also added the `myDevTeam.engine`
  setting, an `AuthProvider` seam, and per-step `usage` (token count) events.

## [0.14.1] - 2026-06-12

### Security

- **Security hardening of the workspace tools**. Symlink paths are
  rejected, content search stats files before reading them, and cancellation
  now reaches the executor's tool loop via an `AbortSignal` (in-flight `run`
  killed, pending `write` dropped).

## [0.14.0] - 2026-06-12

### Added

- **Conversation history**. Prior chat turns are passed (capped) to
  every agent prompt as a "Conversation so far" section, so follow-ups like
  "now rename it too" resolve against the earlier exchanges.

## [0.13.0] - 2026-06-12

### Added

- **Live terminal mirror for run commands + environment-aware prompts**.
  Approved `run` commands stream their real output into a
  read-only "Dev Team" terminal via the new `RunMirror` seam. A new
  `config/environment.ts` feeds the host OS/shell into the prompts and
  supplies the shell the `run` tool spawns, so they can never disagree.

## [0.12.1] - 2026-06-12

### Changed

- **Write tool no longer asks for approval**. `devteam__write`
  writes files directly without the Approver confirmation, leaving `run` as
  the only approval-gated tool.

## [0.12.0] - 2026-06-12

### Added

- **Tool approvals in chat**. Side-effecting tool calls render
  Approve/Decline buttons in the chat panel and block until clicked, with a
  modal fallback outside `@devteam` turns; a decline returns "not approved"
  to the model instead of failing the run.

## [0.11.0] - 2026-06-12

### Added

- **Executor agent**. Plans are now executed: a capability-routed
  coding model runs a Mastra tool-calling loop over the four workspace tools
  and streams an ordered transcript of commentary and tool calls into the
  chat behind an "Execution:" header.

## [0.10.0] - 2026-06-12

### Added

- **Oneshot answerer agent**. Requests triaged as `oneshot` get a
  real streamed answer from a dedicated no-tools agent instead of only a
  plan; the workflow branches after triage.

## [0.9.0] - 2026-06-12

### Added

- **Streaming model output**. The planner's output streams into the
  chat as partial snapshots rendered conservatively, so already-emitted
  markdown is never revised.

## [0.8.0] - 2026-06-12

### Added

- **Configuration via VS Code settings + startup health check**.
  Runtime knobs became live-read `myDevTeam.*` settings (Ollama endpoint, run
  timeout, search caps), and activation now pings the Ollama endpoint and
  warns about an unreachable server or unpulled routed models.

## [0.7.1] - 2026-06-12

### Security

- **Untrusted-input hardening and cancellation**. Tool inputs are
  treated as untrusted: paths escaping the workspace are rejected, search
  excludes build output and binaries, and `run` kills the whole process tree
  on timeout. Cancelling the chat request now cancels the workflow run.

## [0.7.0] - 2026-06-11

### Added

- **Capability-based model router**. Agents declare weighted
  capability requirements and a router picks the best match from a registry
  of per-capability-scored models, defined in `.md` files discovered at build
  time by a custom `md-glob` esbuild plugin.

## [0.6.0] - 2026-06-11

### Changed

- **Frontmatter-driven `.md` configuration**. Agent prompts and
  tool descriptions moved into per-file Markdown with frontmatter, with a
  `{{tools}}` placeholder rendered from the tool configs so prompts and
  schemas cannot drift.

## [0.5.2] - 2026-06-11

### Changed

- **Standard Mastra workflow**. The hand-rolled orchestration was
  replaced by a real Mastra workflow (`createWorkflow` + `createStep`) with
  zod-validated step I/O.

## [0.5.1] - 2026-06-08

### Changed

- **Configuration extraction + unit test suite**. Prompts, limits,
  and message copy moved into `src/config/`, and a Vitest suite was added
  that runs in plain Node with an in-memory `vscode` fake and stubbed agents.

## [0.5.0] - 2026-06-08

### Added

- **Planning step**. A planner agent drafts an ordered, tool-aware
  step-by-step plan for requests classified as planning work.

## [0.4.0] - 2026-06-08

### Added

- **File attachments**. Files and selections attached to the chat
  request are resolved into labelled attachments passed along with the
  prompt.

## [0.3.0] - 2026-06-08

### Changed

- **Switch to Vercel AI SDK + Mastra**. The hand-rolled Ollama HTTP
  client was replaced with the Vercel AI SDK and the Mastra agent framework.

## [0.2.1] - 2026-06-08

### Added

- **Apache 2.0 license**. Added LICENSE and CONTRIBUTING.md.

## [0.2.0] - 2026-06-08

### Added

- **Local LLM intent classification**. Each request is first
  classified into an intent by a local Ollama qwen model with structured
  output.

## [0.1.0] - 2026-06-08

### Added

- **Initial scaffold**. An agentic `@devteam` chat participant with
  four workspace tools (read, search, run, write) registered through the
  Language Model Tools API, side effects gated by the `Approver` seam.
