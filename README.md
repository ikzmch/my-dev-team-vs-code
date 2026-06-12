# My Dev Team - VS Code agent

An agentic AI dev team inside VS Code's **native chat panel**. Invoke it with
`@devteam`: it answers questions, drafts step-by-step plans, and carries them
out - reading, searching, creating, and editing files in your workspace and
running shell commands - while **every side effect asks you first**. It runs
entirely on **local models** via [Ollama](https://ollama.com); nothing leaves
your machine.

## Highlights

- **Native chat experience.** No custom UI to learn: attachments,
  conversation follow-ups, slash commands (`/explain`, `/review`, `/plan`,
  `/do`, `/fix`, `/test`, `/compact`, `/clear`), and 👍/👎 feedback all work
  the way the rest of VS Code chat does. Your project's `AGENTS.md` or
  `CLAUDE.md` is respected as standing instructions on every request.
- **A real multi-agent pipeline on local models.** A triage agent routes each
  request, a planner drafts a tool-aware checklist, an executor walks it in a
  tool-calling loop over five workspace tools, and an answerer handles plain
  questions - each on the model best suited to its job.
- **Capability-based model routing.** Agents never name models: they declare
  weighted capability requirements, and a router picks the best match from a
  registry of scored models. Agents, models, tools, and commands are plain
  `.md` config files - drop a file in to register one, no code change.
- **You stay in control.** Running a command, writing a file, or editing one
  always asks first - with the command echo, a content preview, or a
  diff-style before/after - and approved commands stream live into a
  read-only "Dev Team" terminal.
- **Built to split.** The whole pipeline sits behind a wire-shaped engine
  protocol: today an in-process engine, later a remote backend speaking the
  same contract - without touching the UI or the tools.

## Documentation

- **[QUICKSTART.md](QUICKSTART.md)** - the end-user guide: setup, first
  steps, slash commands, approvals, settings, and troubleshooting.
- **[DESIGN.md](DESIGN.md)** - the developer documentation: architecture,
  the request flow, the engine protocol, the configuration system, the model
  router, the tools, development setup, and the roadmap.
- **[CONTRIBUTING.md](CONTRIBUTING.md)** - how to contribute.
- **[CHANGELOG.md](CHANGELOG.md)** - what changed, release by release.

## Getting started

You need VS Code ^1.95, Node.js 20.x, and a local Ollama server with the
registered models pulled (see [QUICKSTART.md](QUICKSTART.md) for the full
walkthrough):

```bash
npm install
npm run build
# then press F5 in VS Code to launch the Extension Development Host
```

In the dev window, open the Chat view (Ctrl+Alt+I) and type `@devteam hello`.

## Tech stack

- **[Mastra](https://mastra.ai)** - agents and the orchestrating workflow
- **[Vercel AI SDK](https://sdk.vercel.ai)** + `ollama-ai-provider-v2` -
  model interface to local Ollama models
- **`zod`** - structured-output, protocol, and config validation
- **VS Code Chat + Language Model Tools APIs** - the front end and tool
  surface

## License

Apache License 2.0 - see [LICENSE](LICENSE).
