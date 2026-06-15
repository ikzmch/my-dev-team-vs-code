# Configuration reference

The complete inventory of every configuration parameter the extension reads:
where it lives, who owns it, when it is read, and what it does. This is the
detailed companion to the configuration sections of
[DESIGN.md](DESIGN.md#configuration-vs-code-config) - DESIGN.md explains how
configuration fits the architecture; this file enumerates the parameters.

> **Keep this file in sync.** Whenever you add, rename, remove, or change the
> default of a setting, a `backend.json` field, a secret key, or a notable
> build-time constant, update the matching row here in the same change. The
> source of truth is the code: user settings in
> [src/config/settings.ts](src/config/settings.ts) (mirrored in
> `package.json` `contributes.configuration`), the operator floor in
> [config/backend.json](config/backend.json) (validated by
> [backend.ts](src/engine/config/backend.ts)), and secrets in
> [src/config/credentials.ts](src/config/credentials.ts) (key names from
> [providers.ts](src/config/providers.ts)).

## Configuration sources

Configuration lives in five places, each with a different owner, scope, and
read cadence:

| Source | File(s) | Owner / scope | When read |
| ------ | ------- | ------------- | --------- |
| Operator floor | [config/backend.json](config/backend.json) via [backend.ts](src/engine/config/backend.ts) | Operator / distributor; build-wide | Load time (bundled into the build) |
| User settings | `myDevTeam.*` in `package.json` via [settings.ts](src/config/settings.ts) | End user; per VS Code instance | **Live, on every access** (no reload) |
| Secrets | SecretStorage + env vars via [credentials.ts](src/config/credentials.ts) | End user; OS secret store | Cached at activation, refreshed on "Set API Key" |
| Build-time constants | non-getter fields of [settings.ts](src/config/settings.ts) | Developer; compile-time | Baked into the bundle |
| Author config | `src/engine/config/{agents,models,tools,commands,skills}/*.md` | Developer / author; bundled | Load time |

**Why config lives in two folders.** The root-level `config/` holds
**operator/deployment config** - the knobs you turn to customize an *install*
(today only `backend.json`), editable without touching `src/` and carried
server-side by a future remote backend. Everything under `src/engine/config/`
(and `src/config/`) is **authored product source** - the system prompts, the
model registry, the tool/command/skill definitions, and the typed loaders that
consume them. Those assets *are* the engine's behavior and travel with the
engine, so they stay co-located with their loaders rather than moving to the
root. That is why `backend.json` is the only data file outside `src/`: it is the
one file with operator, rather than author, semantics. See
[DESIGN.md](DESIGN.md#configuration-vs-code-config).

Two layered relationships matter and are not the same rule (see
[Precedence and merge semantics](#precedence-and-merge-semantics)):

- **Disable lists** are a **monotonic union** - the operator floor and the user
  setting are unioned, so the user can only ever disable *more*, never
  re-enable what the floor disabled.
- **Endpoint overrides** are an **override** - the operator floor wins when set,
  otherwise the user setting applies.

## 1. User settings (`myDevTeam.*`)

The runtime knobs an end user may turn, declared in `package.json`
(`contributes.configuration`) and read **live** by
[settings.ts](src/config/settings.ts) on every access - a change takes effect on
the next request with no reload. Invalid values (wrong type, non-positive
number, non-http(s) URL, path-escaping entry) silently fall back to the default,
so consumers can always trust what they read.

| Setting | Default | Usage | Floor / layer interaction |
| ------- | ------- | ----- | ------------------------- |
| `engine` | `local` | Which engine handles runs: `local` (in-process) or `remote` (Phase B; warns and falls back to local) | - |
| `model` | `auto` | Planner/answerer/executor model: a model id, `provider:<name>`, or `auto`. Set via `/model` or the status-bar menu | - |
| `triage.model` | `""` | Triage classifier model, separate from `model`. Empty defers to the floor | empty -> `agents.triage.model` floor |
| `complexityRouting` | `true` | Size the model to the task's complexity tier; off routes by capability alone | a model pin bypasses regardless |
| `planApproval` | `auto` | When a drafted plan must be approved: `auto` (only when complex), `always`, `never` | - |
| `approval.fileChanges` | `false` | Gate `write`/`edit` behind approval like `run`; off applies changes directly | `run` stays gated regardless |
| `disabledProviders` | `[]` | Providers the router must never use | **union** with floor; cannot re-enable a floor-disabled provider |
| `disabledModels` | `[]` | Model ids the router must never use | **union** with floor |
| `ollama.endpoint` | `http://localhost:11434` | Ollama server origin (no `/api` suffix) | **override**; backend `providers.ollama.endpoint` wins |
| `openai.baseUrl` | `""` | OpenAI / Azure / compatible gateway base URL | **override**; backend `providers.openai.baseUrl` wins |
| `anthropic.baseUrl` | `""` | Anthropic proxy/gateway base URL | **override**; backend wins |
| `groq.baseUrl` | `""` | Groq proxy/gateway base URL | **override**; backend wins |
| `provider.requestsPerMinute` | `0` | Per-provider request throttle; `0` disables | - |
| `run.commandTimeoutMs` | `60000` | `run` tool shell-command timeout (ms) | - |
| `read.maxLines` | `200` | Max lines one `read` call returns | - |
| `search.globMaxResults` | `200` | Max files a glob search returns | - |
| `search.contentScanLimit` | `500` | Max files a content search scans | - |
| `search.contentMaxMatches` | `50` | Max match lines before a content search stops | - |
| `chat.toolSnippetLines` | `5` | Leading lines of a write/edit shown in the transcript (`0` hides) | - |
| `write.protectedPaths` | `[".vscode"]` | Root-relative paths `write`/`edit` refuse to touch | `.git/` is always protected and not removable; `..` entries -> default |
| `usage.showInChat` | `true` | Append a `Tokens:` line under each reply | status-bar total and report are independent |
| `changes.showInChat` | `true` | Append a `Changes:` line when a turn wrote files | - |
| `summary.showInChat` | `true` | Three-section summary after a file-changing run | off skips the summarizer model call entirely |
| `thinking.showInChat` | `true` | Show a reasoning model's thinking as transient progress | off skips capturing reasoning entirely |
| `instructions.files` | `["AGENTS.md", "CLAUDE.md"]` | Root-relative instruction file names probed in order | plain names only; a `/` or `..` entry -> default list |
| `skills.directories` | `[".devteam/skills", ".claude/skills"]` | Dirs scanned for `<dir>/<name>/SKILL.md` (workspace roots + home) | absolute or `..` entry -> default list |
| `mcp.servers` | `{}` | stdio MCP servers: name -> `{ command, args?, env? }` | ignored in an untrusted workspace; invalid entries dropped |
| `telemetry.evalLog` | `false` | Opt-in local eval log of run/feedback records | nothing leaves the machine |
| `telemetry.shadowTriage` | `false` | Also run triage on pinned runs to score it | only collects while `evalLog` is on |

## 2. Operator floor (`backend.json`)

Operator-owned settings the engine enforces, distinct from user settings,
bundled into the build and validated by Zod at load
([backend.ts](src/engine/config/backend.ts)) - an invalid file fails the build
loudly. A future remote backend would carry the same file server-side. Every
field defaults to empty, so a partial or empty file is valid.

| Key | Default | Usage | Semantics vs user |
| --- | ------- | ----- | ----------------- |
| `models.disabledProviders` | `[]` | Providers no one may use | **union** floor; a user cannot re-enable |
| `models.disabledModels` | `[]` | Model ids no one may use | **union** floor |
| `providers.ollama.endpoint` | `""` | Ollama origin override | **wins over** `myDevTeam.ollama.endpoint` |
| `providers.openai.baseUrl` | `""` | OpenAI base URL override | **wins over** `myDevTeam.openai.baseUrl` |
| `providers.anthropic.baseUrl` | `""` | Anthropic base URL override | **wins over** `myDevTeam.anthropic.baseUrl` |
| `providers.groq.baseUrl` | `""` | Groq base URL override | **wins over** `myDevTeam.groq.baseUrl` |
| `agents.triage.model` | `"ollama"` | Triage routing default: a model id pins it, a provider name routes by capability | user `triage.model` overrides when set |

## 3. Secrets (API keys)

Cloud-provider API keys, kept out of `settings.json` on purpose (it syncs to
disk and Settings Sync). Stored in the editor's SecretStorage, with an
environment variable as a fallback; cached in memory at activation and refreshed
by the "My Dev Team: Set API Key" command. Read live by the provider wiring.
The set of cloud providers and these key names derive from the provider registry
([providers.ts](src/config/providers.ts)) - a cloud provider is any non-keyless
descriptor. Phase C moves keys server-side behind the `AuthProvider` seam.

| Provider | SecretStorage key | Env-var fallback |
| -------- | ----------------- | ---------------- |
| `openai` | `myDevTeam.openai.apiKey` | `OPENAI_API_KEY` |
| `anthropic` | `myDevTeam.anthropic.apiKey` | `ANTHROPIC_API_KEY` |
| `groq` | `myDevTeam.groq.apiKey` | `GROQ_API_KEY` |
| `ollama` | - (keyless, local) | - |

Note: the SecretStorage keys share the `myDevTeam.` prefix but are **not**
`settings.json` entries - they never appear in the Settings UI.

## 4. Build-time constants

Not user-tunable: change them in [settings.ts](src/config/settings.ts) and
rebuild. They bound how much work the tools and UI do.

| Group | Constant | Default |
| ----- | -------- | ------- |
| Rate-limit retry | `provider.maxRateLimitRetries` | `5` |
| | `provider.maxRetryWaitMs` | `60000` |
| | `provider.retryBufferMs` | `250` |
| `run` tool | `runCommandMaxBufferBytes` | `10 MB` |
| | `runResultMaxChars` | `200000` |
| | `runMirrorBacklogMaxChars` | `200000` |
| `read` tool | `read.maxChars` | `200000` |
| | `read.maxFileSizeBytes` | `10 MB` |
| `search` tool | `search.contentMaxMatchesPerFile` | `5` |
| | `search.contentPreviewMaxChars` | `200` |
| | `search.excludeGlob` | node_modules, .git, dist, out, coverage |
| | `search.maxFileSizeBytes` | `1 MB` |
| | `search.scanCandidateLimit` | `25000` |
| Structured output | `structuredOutput.repairAttempts` | `1` |
| Executor | `executor.maxSteps` | `12` |
| | `executor.inputPreviewMaxChars` | `200` |
| | `executor.resultPreviewMaxChars` | `400` |
| Thinking | `thinking.lineMaxChars` | `200` |
| Telemetry | `telemetry.evalLogMaxChars` | `1000000` |
| Instructions | `instructions.maxChars` | `8000` |
| Skills | `skills.maxSkills` | `24` |
| | `skills.maxChars` | `8000` |
| MCP | `mcp.maxTools` | `64` |
| | `mcp.connectTimeoutMs` | `10000` |
| | `mcp.callTimeoutMs` | `60000` |
| | `mcp.resultMaxChars` | `50000` |
| References | `references.codebaseMaxTerms` | `4` |
| | `references.codebaseMaxFiles` | `8` |
| | `references.codebaseSnippetFiles` | `3` |
| | `references.codebaseSnippetLines` | `20` |
| | `references.codebaseMaxChars` | `8000` |
| | `references.changesMaxChars` | `12000` |
| Attachments | `maxAttachmentChars` | `20000` |
| | `maxAttachmentReadBytes` | `10 MB` |
| History | `history.maxTurns` | `10` |
| | `history.maxTurnChars` | `2000` |
| Startup | `startupProbeTimeoutMs` | `3000` |

## 5. Author config (the `.md` files)

Prompt material and the model registry, bundled at build time (esbuild inlines
each file as a string). These are configuration an author tunes, not runtime
settings; see [DESIGN.md](DESIGN.md#configuration-vs-code-config) for how they
are discovered and rendered.

| Folder | Per-file frontmatter |
| ------ | -------------------- |
| `agents/*.md` | `id`, `name`, `description`, capability weights, `tools` |
| `models/*.md` | `id`, `label`, `provider`, `model`, `tier`, capability scores |
| `tools/*.md` | `name`, `sideEffecting`, optional `previewArg`/`snippetArg` + description |
| `commands/*.md` | `name`, `description`, `intent`, `execute`, optional `complexity` + preamble |
| `skills/*.md` | `name`, `description` + instruction body |

**Discovered content files** (read per request, not bundled - workspace roots
and the user's home dir): the standing-instruction file (`AGENTS.md` /
`CLAUDE.md`, names from `instructions.files`) and skill packages
(`<dir>/<name>/SKILL.md`, dirs from `skills.directories`). These carry prose, not
parameters, but the client ships them on each run request.

## Precedence and merge semantics

When the same concept is set in more than one source, resolution follows one of
two rules, decided per field (not a single deep merge):

1. **Override fields** (endpoints, base URLs, triage model): resolved as
   **backend floor override else user setting**. The operator's `backend.json`
   value wins when non-empty; otherwise the user setting applies; otherwise the
   compiled default. Implemented in
   [engine/core/models.ts](src/engine/core/models.ts) (`ollamaEndpoint`,
   `resolveProviderConfig`, `triageRouting`).

2. **Monotonic / narrowing fields** (disable lists): resolved as the **union**
   of the backend floor and the user setting. A provider/model is enabled only
   when neither layer disabled it, so the user layer can narrow further but can
   never re-enable what the floor disabled. Implemented as `isProviderEnabled` /
   `isModelEnabled` in [engine/core/models.ts](src/engine/core/models.ts).

Secrets are never part of this merge: they live only in SecretStorage / env and
reach the provider wiring directly, never through a config file.
