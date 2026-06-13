# My Dev Team - Quick start

My Dev Team is an AI chat participant for VS Code. You talk to it as
`@devteam` in the normal chat panel, and it can answer questions, draft
step-by-step plans, and carry them out: reading, searching, creating, and
editing files in your workspace and running shell commands - asking you first
before it runs a command (file changes apply directly to your Git-backed
workspace, where they are easy to review and revert). Out of the box everything
runs locally against your own [Ollama](https://ollama.com) server and nothing
leaves your machine; if you prefer, you can also point it at a cloud model
(OpenAI or Anthropic) by adding an API key - see
[Choosing a model](#4-choosing-a-model).

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
  `myDevTeam.ollama.endpoint` setting (see [Settings](#7-settings)).

  Cloud models (OpenAI, Anthropic) are optional and need only an API key, no
  Ollama pull - see [Choosing a model](#4-choosing-a-model).

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

- **Attach context** - use the paperclip (or `#`-references) to attach files,
  a selection, or a symbol; the agent receives their full text. A really huge
  file (tens of megabytes) is skipped with a note - attach a selection from it
  instead.

- **Point at your code inline** - type these markers anywhere in your message
  and the agent pulls in the matching context for you:

  - `#codebase` - searches your workspace for code relevant to your message and
    attaches the matching files (with a peek at the top ones), so you do not
    have to find and attach them yourself.
  - `#changes` - attaches your uncommitted git changes, handy for "review what
    I changed" or "fix the bug I just introduced".

  ```
  @devteam where is the retry logic? #codebase
  @devteam review my work so far #changes
  ```

- **Follow up** - the conversation carries over, so "now rename it too" or
  "add a test for that" resolves against what was just done.

- **Set standing rules** - put an `AGENTS.md` (or `CLAUDE.md`) file in your
  project root with your conventions ("always run the tests", "use tabs",
  "never touch the generated folder") and the agent follows them on every
  request - no need to repeat them in chat. Edits to the file take effect on
  your very next message. If both files exist, `AGENTS.md` wins.

The agent decides on its own whether your request is a question (it answers
directly) or work on files (it plans, then executes). You watch the plan and
an execution transcript stream into the chat as it happens. On a longer task it
also prints a **Progress** checklist from time to time - the plan steps with
each one ticked off as it goes - so you can see where it stands without reading
every tool call.

## 4. Choosing a model

By default the model is **Auto**: My Dev Team picks the best available model
for each part of your request, and shows you what it chose on a **Model:** line
under each reply. To change it, type **`/model`** in the chat (or click the
model name in the status bar at the bottom of the window) and pick from the
list - or type the name directly, e.g. `/model Claude Sonnet 4.6`.

The list offers three kinds of choice:

- **Auto** - the best available model for each task, across every provider.
- **A specific model** - always use that one model.
- **A provider** (e.g. "Anthropic (best available)") - stick to that provider
  but let it pick the best model for each task. Type `/model anthropic` (or
  `openai`, `ollama`) as a shortcut.

Out of the box the list is your local Ollama models. To use a cloud model:

1. Run the **"My Dev Team: Set API Key"** command (Ctrl+Shift+P) and paste your
   OpenAI or Anthropic key. It is stored securely and never written to your
   settings file. (Alternatively, set the `OPENAI_API_KEY` or
   `ANTHROPIC_API_KEY` environment variable before launching VS Code.)
2. Pick the model with `/model` - cloud models you have a key for become
   selectable; the rest show as unavailable.

Notes:

- Picking a model uses it for the planning and the actual work. The quick
  internal "is this a question or a task?" step always stays on a fast local
  model, so it costs you nothing.
- **Auto** only uses a cloud model once you have set its key; until then it
  stays on your local models. Add a key and Auto will start preferring the
  stronger cloud model on its own.
- Using a cloud model sends your request to that provider. Local Ollama models
  keep everything on your machine.
- For Azure or another gateway, set `myDevTeam.openai.baseUrl` or
  `myDevTeam.anthropic.baseUrl` to its URL (see [Settings](#7-settings)).

## 5. Slash commands

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
| `/model`   | Choose the model (or Auto); see [Choosing a model](#4-choosing-a-model) |

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

## 6. Approvals: you stay in control

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

## 7. Settings

Open Settings and search for "My Dev Team" (or edit `settings.json`).
Changes take effect immediately - no reload needed. The ones you are most
likely to touch:

| Setting                          | Default                  | What it controls                                  |
| -------------------------------- | ------------------------ | ------------------------------------------------- |
| `myDevTeam.model`                | `auto`                   | Which model, provider (`provider:<name>`), or `auto` to use; easier to set with `/model` or the status bar |
| `myDevTeam.ollama.endpoint`      | `http://localhost:11434` | Where your Ollama server listens                  |
| `myDevTeam.openai.baseUrl`       | `""`                     | Custom OpenAI endpoint (Azure / compatible gateway); empty uses OpenAI's default |
| `myDevTeam.anthropic.baseUrl`    | `""`                     | Custom Anthropic endpoint (a proxy/gateway); empty uses Anthropic's default |
| `myDevTeam.run.commandTimeoutMs` | `60000`                  | How long a shell command may run before it is killed |
| `myDevTeam.chat.toolSnippetLines`| `5`                      | Lines of a written file previewed in the chat transcript (`0` hides the preview) |
| `myDevTeam.usage.showInChat`     | `true`                   | Show the **Tokens** line under each reply; the status-bar counter and the usage report stay regardless |
| `myDevTeam.instructions.files`   | `["AGENTS.md", "CLAUDE.md"]` | Which project files in your workspace root hold standing rules for the agent; the first one found is used. An empty list turns the feature off |
| `myDevTeam.telemetry.evalLog`    | `false`                  | Opt-in local log of runs and 👍/👎 feedback - stays on your machine, records no prompts or file contents |

There are further knobs for read/search limits (`myDevTeam.read.*`,
`myDevTeam.search.*`) and the engine choice (`myDevTeam.engine`, leave it on
`local` for now).

## 8. Token usage

Every reply ends with a **Tokens** line - how many tokens that request spent
(input and output). The status bar (next to the model name) keeps a running
**total for the session**; click it to open a **token usage report**: a
Highlights section (how much went to prompts vs answers, how often the prompt
cache helped, and how many tokens sat behind your 👍/👎 votes), an **Input by
source** table showing whether project instructions, conversation history, or
attachments are taking up your prompts, and breakdowns by step, model, command,
and day. A `~` in front of a number means it includes an estimate, because the
model did not report exact counts.

- Don't want the per-reply line? Turn off `myDevTeam.usage.showInChat`. The
  status-bar counter and the report stay.
- The report is built from the local log, so it only has data once you turn on
  `myDevTeam.telemetry.evalLog` (see below). Until then it tells you so.

## 9. Feedback

Use the **👍 / 👎** buttons on any reply. With
`myDevTeam.telemetry.evalLog` enabled, your votes are stored locally next to
the run's routing and usage data, which helps tune the agents - nothing is
ever sent anywhere.

## 10. Troubleshooting

- **"Ollama is unreachable" or a request fails on the first step** - make
  sure `ollama serve` is running and that `myDevTeam.ollama.endpoint`
  matches where it listens.
- **A request fails naming a model** - for a local model, pull it
  (`ollama pull <model>`); for a cloud model, the failure means its API key is
  missing or invalid - set it with "My Dev Team: Set API Key" (see
  [Choosing a model](#4-choosing-a-model)).
- **A cloud model shows as unavailable in `/model`** - you have not set its API
  key yet; run "My Dev Team: Set API Key".
- **A command seems stuck** - long commands are killed after
  `myDevTeam.run.commandTimeoutMs` (60s by default); raise it for slow
  builds or test suites.
- **Replies feel slow** - the agents run on local models; speed depends on
  your hardware and the model sizes. Smaller models respond faster.
