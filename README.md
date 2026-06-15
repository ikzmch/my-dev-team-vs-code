# My Dev Team - VS Code agent

An agentic AI dev team inside VS Code's **native chat panel**. Invoke it with
`@devteam`: it answers questions, drafts step-by-step plans, and carries them
out - reading, searching, creating, and editing files in your workspace and
running shell commands - while **shell commands ask you first** (file changes
apply directly to your Git-backed workspace). It runs on **local models** via
[Ollama](https://ollama.com) by default - nothing leaves your machine - and can
optionally use **cloud models** (OpenAI, Anthropic, Groq) when you add an API key.

It is built to **work alongside GitHub Copilot, not just replace it** (though
replacing it is one supported scenario). Sitting in the same chat panel, it
gives you a free local fallback: send the "dummy" or exploratory questions to a
local model so you do not spend your Copilot budget on them, and when that
budget runs out and Copilot chat is disabled, `@devteam` is still there to
answer.

## Highlights

- **Complements Copilot, on your budget.** Live in the same VS Code chat next
  to GitHub Copilot rather than instead of it. Route the cheap, throwaway, and
  exploratory questions to a free local model to preserve your Copilot
  allowance, and keep getting answers when that allowance is spent and Copilot
  chat goes dark. Replacing Copilot outright is still a supported path - it is
  just not the only one.
- **Native chat experience.** No custom UI to learn: attachments,
  conversation follow-ups, slash commands (`/explain`, `/review`, `/plan`,
  `/do`, `/fix`, `/test`, `/compact`, `/clear`, `/model`), and 👍/👎 feedback all
  work the way the rest of VS Code chat does. Your project's `AGENTS.md` or
  `CLAUDE.md` is respected as standing instructions on every request. You can
  also start from the editor: a **Fix with Dev Team** Quick Fix on a diagnostic,
  an **Explain** action on a selection, and a write/repair-tests CodeLens on
  test files.
- **Pick a model, or let Auto choose.** Run on local Ollama models or cloud
  models (OpenAI, Anthropic, Groq) - choose one with `/model`, or leave it on **Auto**
  to route by capability among the models available to you. Every reply shows
  which model answered. Cloud keys are stored securely, never in settings.
- **A real multi-agent pipeline on local models.** A triage agent routes each
  request, a planner drafts a tool-aware checklist, an executor walks it in a
  tool-calling loop over five workspace tools, and an answerer handles plain
  questions - each on the model best suited to its job.
- **Skills the agent loads on demand.** Package reusable know-how (how to write
  a commit message, format a changelog entry, follow a team convention) as a
  named, described skill; the agent pulls in its full instructions only when a
  task matches. A few ship built-in, and you add your own by dropping a
  `SKILL.md` into `.devteam/skills/` in your workspace.
- **Capability-based model routing.** Agents never name models: they declare
  weighted capability requirements, and a router picks the best match from a
  registry of scored models. Agents, models, tools, commands, and skills are
  plain `.md` config files - drop a file in to register one, no code change.
- **You stay in control.** Demanding work pauses to let you approve the plan
  first - Approve, Cancel, or Revise it with a comment - and running a shell
  command always asks before it runs, streaming approved commands live into a
  read-only "Dev Team" terminal. File writes and edits apply directly (your
  Git-backed workspace makes them easy to review and revert), and the agent can
  only touch files inside your workspace.
- **Built to split.** The whole pipeline sits behind a wire-shaped engine
  protocol: today an in-process engine, later a remote backend speaking the
  same contract - without touching the UI or the tools.

## Documentation

- **[QUICKSTART.md](QUICKSTART.md)** - the shortest path for a new user: what
  to do right after installing the `.vsix` to get a working chat.
- **[HOWTO.md](HOWTO.md)** - the full end-user guide: setup, first steps,
  slash commands, approvals, settings, and troubleshooting.
- **[DESIGN.md](DESIGN.md)** - the developer documentation: architecture,
  the request flow, the engine protocol, the configuration system, the model
  router, the tools, development setup, and the roadmap.
- **[CONTRIBUTING.md](CONTRIBUTING.md)** - how to contribute.
- **[CHANGELOG.md](CHANGELOG.md)** - what changed, release by release.

## Tech stack

- **[Mastra](https://mastra.ai)** - agents and the orchestrating workflow
- **[Vercel AI SDK](https://sdk.vercel.ai)** + `ollama-ai-provider-v2`,
  `@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/groq` - model interface to
  local Ollama and cloud (OpenAI, Anthropic, Groq) models
- **`zod`** - structured-output, protocol, and config validation
- **VS Code Chat + Language Model Tools APIs** - the front end and tool
  surface

## License

Apache License 2.0 - see [LICENSE](LICENSE).
