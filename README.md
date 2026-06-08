# My Dev Team — VS Code agent (boilerplate)

An agentic chat participant for VS Code. It lives in the **native chat panel**
(invoke with `@devteam`), gets 👍/👎 **feedback for free**, and can **read,
search, run, and write** files in your workspace via the Language Model Tools
API. Side-effecting actions (run command, write file) are gated by an
**approval seam** so you can later swap the chat confirmation for a rich
Webview diff dialog **without touching the agent core**.

## Architecture (the important part)

```
src/
  extension.ts            entry point — wires core + tools + UI together
  core/
    types.ts              ChatTurn, Approver, OutputSink, AgentReply
    backend.ts            Backend interface + StubBackend (swap this)
  tools/
    workspaceTools.ts     read / search / run / write (UI-agnostic)
    registerTools.ts      registers tools with vscode.lm
  ui/
    chatParticipant.ts    chat handler + Phase-1 ChatApprover
```

- **Agent core** (`core/`, `tools/workspaceTools.ts`) knows nothing about the UI.
- **UI layer** (`ui/`) is swappable: Chat Participant today, add a Webview later.
- **`Approver`** is the seam. `ChatApprover` is Phase 1; a `WebviewApprover`
  implementing the same interface is Phase 2 — the tools never change.

## Run it

```bash
npm install
npm run build      # bundles to dist/extension.js
# then press F5 in VS Code to launch the Extension Development Host
```

In the dev window, open the Chat view (Ctrl+Alt+I), type `@devteam hello`.

## Swap the stub backend

Replace `StubBackend` in `src/core/backend.ts` with a real client:

- **Anthropic API** — POST to `/v1/messages` with `tools[]`, loop while
  `stop_reason === "tool_use"`.
- **M365 Copilot Chat API** — Graph `/beta` copilot conversations endpoint
  (preview; requires a Copilot add-on license).
- **vscode.lm** — `vscode.lm.selectChatModels()` + `sendRequest()` to reuse
  the model the user already has.

## Add a Webview later

1. Add a `WebviewApprover implements Approver` with a diff/confirm UI.
2. Pass it instead of `ChatApprover` in `extension.ts`.
3. Optionally add a Webview panel as a second front-end calling the same core.

The agent core and tools require **no changes**.
