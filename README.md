# My Dev Team — VS Code agent

An agentic chat participant for VS Code. It lives in the **native chat panel**
(invoke with `@devteam`), gets 👍/👎 **feedback for free**, and can **read,
search, run, and write** files in your workspace via the Language Model Tools
API.

The agent routes each request through a **local intent classifier** (Ollama via
the Vercel AI SDK + Mastra) before deciding how to respond. Side-effecting
actions (run command, write file) are gated by an **approval seam**, so the chat
confirmation can later be swapped for a rich Webview diff dialog **without
touching the agent core**.

> **Status:** the routing layer (intent classification) and the **planner** are
> live; the **executor is not wired up yet**. Today the backend classifies your
> request and, for `planning` requests, drafts a step-by-step plan — but it does
> not yet execute that plan with tools. See
> [Current behavior](#current-behavior) and [Roadmap](#roadmap).

## Architecture

```
src/
  extension.ts            entry point — wires core + tools + UI together
  core/
    types.ts              ChatTurn, Approver, OutputSink, AgentReply
    backend.ts            Backend interface + StubBackend (swap this)
    models.ts             semantic model router (role -> AI SDK model)
    intentClassifier.ts   Mastra agent: classify request as oneshot | planning
    planner.ts            Mastra agent: draft an ordered, tool-aware plan
  tools/
    workspaceTools.ts     read / search / run / write (UI-agnostic)
    registerTools.ts      registers tools with vscode.lm
  ui/
    chatParticipant.ts    chat handler + Phase-1 ChatApprover + followups
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
ui/chatParticipant.ts          reconstruct ChatTurn[] history from chat context,
  createHandler                bridge OutputSink onto the chat stream
        │
        ▼
core/backend.ts                Backend.reply(history, sink)
  StubBackend                  ── sink.progress("Understanding your request…")
        │
        ▼
core/intentClassifier.ts       Mastra Agent + zod structured output
  IntentClassifier.classify    → { intent: "oneshot" | "planning", reason }
        │                        (uses models.intent — local Ollama)
        ▼
core/planner.ts                Planner.plan(prompt)  (only for "planning")
  Planner                       → { summary, steps[] }  (uses models.plan)
        │                        oneshot answers directly; planning drafts a plan.
        ▼
  (stub) renders the intent + reason, and for planning the drafted plan,
  back to the chat panel. An executor would walk the plan's steps here.
```

### Semantic model router (`core/models.ts`)

Each *role* maps to an [AI SDK](https://sdk.vercel.ai) model, so cheap/local
models handle routing and capable (paid) models can later handle execution.
Swap providers per role here without touching agent code.

| Role     | Purpose                                   | Current model            |
| -------- | ----------------------------------------- | ------------------------ |
| `intent` | Classify the request (cheap, local)       | Ollama `qwen3:8b`        |
| `plan`   | Draft a step-by-step plan                 | Ollama `qwen3:8b`        |

```ts
// core/models.ts — to add a paid provider for execution later:
import { createAnthropic } from '@ai-sdk/anthropic';
const anthropic = createAnthropic({ apiKey: /* … */ });
export const models = {
  intent: ollama('qwen3:8b'),
  plan: anthropic('claude-haiku-4-5'),
} as const;
```

### Tools (`tools/`)

Declared in `package.json` under `contributes.languageModelTools` and
registered with `vscode.lm.registerTool` in `registerTools.ts`. The
implementations in `workspaceTools.ts` are UI-agnostic.

| Tool                   | Effect                          | Approval        |
| ---------------------- | ------------------------------- | --------------- |
| `devteam__read`        | Read a file's text              | none (read-only)|
| `devteam__search`      | Glob file names or grep content | none (read-only)|
| `devteam__run`         | Run a shell command (60s cap)   | **Approver**    |
| `devteam__write`       | Create/overwrite a file         | **Approver**    |

Side-effecting tools call `approver.confirm(title, detail)`. The Phase-1
`ChatApprover` streams the proposed action into the chat panel and gates it
behind a modal confirmation. The `writeFile` tool builds a current/proposed
preview so the approval prompt shows what will change.

## Current behavior

Out of the box, `@devteam <prompt>`:

1. Reconstructs the conversation history.
2. Streams "Understanding your request…".
3. Classifies the prompt as `oneshot` or `planning` via the local Ollama model.
4. Echoes your prompt plus the **detected intent and reason** back to the panel.
5. For `planning` requests, streams "Drafting a plan…" and renders an ordered,
   tool-aware **plan** (`summary` + numbered steps) via `models.plan`.

The four workspace tools are registered and callable by any VS Code chat model
that supports tool calling; the stub backend itself does not yet drive a
tool-calling loop.

If Ollama is not reachable, the stub reports the classifier error and reminds
you to start Ollama with `qwen3:8b` pulled.

## Prerequisites

- **VS Code** ^1.95.0
- **Node.js** 20.x
- **[Ollama](https://ollama.com)** running locally for intent classification:

  ```bash
  ollama serve                 # listens on http://localhost:11434
  ollama pull qwen3:8b         # the model used by core/models.ts
  ```

## Run it

```bash
npm install
npm run build      # esbuild bundle -> dist/extension.js
# then press F5 in VS Code to launch the Extension Development Host
```

In the dev window, open the Chat view (Ctrl+Alt+I) and type `@devteam hello`.
Use the `/explain` command to explain a file or selection.

Scripts:

| Script            | What it does                                            |
| ----------------- | ------------------------------------------------------- |
| `npm run compile` | Type-check / emit with `tsc`                            |
| `npm run watch`   | `tsc` in watch mode                                     |
| `npm run build`   | Bundle to `dist/extension.js` with esbuild (alias of `package`) |

## Tech stack

- **[Mastra](https://mastra.ai)** (`@mastra/core`) — agent abstraction for the classifier
- **[Vercel AI SDK](https://sdk.vercel.ai)** (`ai`) — model interface
- **`ollama-ai-provider-v2`** — AI SDK provider for local Ollama models
- **`zod`** — structured-output schema for the intent classifier
- **VS Code Chat + Language Model Tools APIs** — the front end and tool surface

## Roadmap

- **Wire the executor.** The planner is live: `StubBackend` branches on intent
  and, for `planning`, drafts a plan with `models.plan` (`core/planner.ts`).
  What's left is an executor that walks the plan's steps and runs a tool-calling
  loop over the registered tools (with `Approver`-gated side effects).
- **Swap the backend** for a real model client. The `Backend` interface only
  needs `reply(history, sink)`; candidates:
  - **vscode.lm** — `vscode.lm.selectChatModels()` + `sendRequest()` to reuse
    the model the user already has.
  - **Anthropic API** — POST to `/v1/messages` with `tools[]`, loop while
    `stop_reason === "tool_use"`.
- **Add a Webview front end.**
  1. Add a `WebviewApprover implements Approver` with a diff/confirm UI.
  2. Pass it instead of `ChatApprover` in `extension.ts`.
  3. Optionally add a Webview panel as a second front-end calling the same core.

  The agent core and tools require **no changes**.
- **Feedback telemetry.** `participant.onDidReceiveFeedback` currently logs
  👍/👎; forward it to telemetry/eval storage.

## License

Apache License 2.0 — see [LICENSE](LICENSE).
