# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
