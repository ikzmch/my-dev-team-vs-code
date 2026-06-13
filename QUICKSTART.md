# My Dev Team - Quick start

My Dev Team is an AI chat participant for VS Code. You talk to it as
`@devteam` in the normal chat panel, and it can answer questions, draft
step-by-step plans, and carry them out: reading, searching, creating, and
editing files in your workspace and running shell commands - asking you first
before it runs a command (file changes apply directly to your Git-backed
workspace, where they are easy to review and revert). Everything runs locally
against your own [Ollama](https://ollama.com) server; nothing leaves your
machine.

## 1. What you need

- **VS Code** 1.95 or newer
- **Node.js** 20.x (to build the extension)
- **Ollama** installed and running locally, with these models pulled:

  ```bash
  ollama serve                 # listens on http://localhost:11434
  ollama pull qwen3:8b
  ollama pull qwen3:14b
  ollama pull qwen3-coder
  ollama pull gemma3:4b
  ```

  If your Ollama server listens somewhere else, set the
  `myDevTeam.ollama.endpoint` setting (see [Settings](#5-settings)).

## 2. Build and launch

The extension is not on the marketplace yet; you run it from source:

```bash
npm install
npm run build
```

Then open this folder in VS Code and press **F5** to launch the Extension
Development Host (if VS Code asks for a debugger, pick "VS Code Extension
Development"). A second VS Code window opens with the extension loaded -
open a workspace folder in it and work there.

On startup the extension checks your Ollama server and warns you if it is
unreachable or one of the models above is missing - if you see no warning,
you are good to go.

## 3. First steps

Open the Chat view (**Ctrl+Alt+I**) and address the participant:

```
@devteam hello
```

Then try a real request:

- **Ask a question** - the reply streams straight into the chat:

  ```
  @devteam what does a .gitignore file do?
  ```

- **Have it build something** - it drafts a numbered plan, then executes it
  step by step:

  ```
  @devteam create a console calculator in calculator.py with add, subtract, multiply and divide
  ```

- **Attach context** - use the paperclip (or `#`-references) to attach files
  or a selection; the agent receives their full text. A really huge file
  (tens of megabytes) is skipped with a note - attach a selection from it
  instead.

- **Follow up** - the conversation carries over, so "now rename it too" or
  "add a test for that" resolves against what was just done.

- **Set standing rules** - put an `AGENTS.md` (or `CLAUDE.md`) file in your
  project root with your conventions ("always run the tests", "use tabs",
  "never touch the generated folder") and the agent follows them on every
  request - no need to repeat them in chat. Edits to the file take effect on
  your very next message. If both files exist, `AGENTS.md` wins.

The agent decides on its own whether your request is a question (it answers
directly) or work on files (it plans, then executes). You watch the plan and
an execution transcript stream into the chat as it happens.

## 4. Slash commands

Type `/` after `@devteam` to pick a command. A command skips the automatic
question-vs-work decision and tells the agent exactly what kind of help you
want:

| Command    | What it does                                                        |
| ---------- | ------------------------------------------------------------------- |
| `/explain` | Explain a file, selection, or concept in the chat - no changes made |
| `/review`  | Review the attached code or selection - findings in chat, no edits  |
| `/plan`    | Draft the step-by-step plan but do not execute it; say "go ahead" in a follow-up to run it |
| `/do`      | Plan and execute workspace changes - skip straight to doing         |
| `/fix`     | Diagnose a bug, fix its root cause, and verify the fix              |
| `/test`    | Write or update tests for the target code, then run them            |
| `/compact` | Summarize the conversation so far; the summary then stands in for it in future turns |
| `/clear`   | Start fresh: drop the conversation so far from future requests      |

Commands work in follow-ups too: `/explain what you just did` refers back to
the earlier turns.

`/compact` and `/clear` manage the conversation context. Long sessions are
capped (only the most recent turns travel with each request), so on a long
task old decisions silently fall away - `/compact` condenses them into one
summary the agent keeps seeing, while `/clear` is for changing topic without
opening a new chat. The chat panel still shows everything; the commands only
change what the models receive. If a `/compact` fails (e.g. Ollama is down),
your history is untouched - the summary only takes over once it actually
succeeded.

## 5. Approvals: you stay in control

Running a shell command stops and asks you first, right in the chat: a
**Run Command** prompt shows the exact command, and you click **Approve** to
let it run or **Decline** to skip it. Declining does not abort the run: the
agent is told the command was not approved, carries on with the rest of the
plan, and notes the skip in its report.

Reading, searching, writing, and editing files do not ask - they apply
directly. Writing and editing are safe to run unprompted because your
workspace is backed by Git: if the agent changes a file you did not want
changed, you can see it in your source-control view and revert it like any
other edit. (Commit or stash work you want to be sure of first; Git cannot
restore changes that were never committed.) The agent only edits files inside
your workspace folder - it cannot reach outside it.

Cancelling the chat request (the stop button) cancels everything, including a
command already running and any file change still in flight.

Every approved command's full live output also appears in a read-only
**"Dev Team" terminal** in the terminal panel - open that tab to watch
commands run or to read the session log afterwards; the chat itself only
shows short previews.

## 6. Settings

Open Settings and search for "My Dev Team" (or edit `settings.json`).
Changes take effect immediately - no reload needed. The ones you are most
likely to touch:

| Setting                          | Default                  | What it controls                                  |
| -------------------------------- | ------------------------ | ------------------------------------------------- |
| `myDevTeam.ollama.endpoint`      | `http://localhost:11434` | Where your Ollama server listens                  |
| `myDevTeam.run.commandTimeoutMs` | `60000`                  | How long a shell command may run before it is killed |
| `myDevTeam.chat.toolSnippetLines`| `5`                      | Lines of a written file previewed in the chat transcript (`0` hides the preview) |
| `myDevTeam.instructions.files`   | `["AGENTS.md", "CLAUDE.md"]` | Which project files in your workspace root hold standing rules for the agent; the first one found is used. An empty list turns the feature off |
| `myDevTeam.telemetry.evalLog`    | `false`                  | Opt-in local log of runs and 👍/👎 feedback - stays on your machine, records no prompts or file contents |

There are further knobs for read/search limits (`myDevTeam.read.*`,
`myDevTeam.search.*`) and the engine choice (`myDevTeam.engine`, leave it on
`local` for now).

## 7. Feedback

Use the **👍 / 👎** buttons on any reply. With
`myDevTeam.telemetry.evalLog` enabled, your votes are stored locally next to
the run's routing and usage data, which helps tune the agents - nothing is
ever sent anywhere.

## 8. Troubleshooting

- **"Ollama is unreachable" or a request fails on the first step** - make
  sure `ollama serve` is running and that `myDevTeam.ollama.endpoint`
  matches where it listens.
- **A request fails naming a model** - pull the named model
  (`ollama pull <model>`); the agent only routes to models listed in
  [section 1](#1-what-you-need).
- **A command seems stuck** - long commands are killed after
  `myDevTeam.run.commandTimeoutMs` (60s by default); raise it for slow
  builds or test suites.
- **Replies feel slow** - the agents run on local models; speed depends on
  your hardware and the model sizes. Smaller models respond faster.
