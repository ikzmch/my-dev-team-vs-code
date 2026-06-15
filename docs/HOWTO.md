# My Dev Team - How-to guide

This is the full end-user guide. If you have just installed the extension and
only want the shortest path to a working chat, start with
[QUICKSTART.md](QUICKSTART.md) and come back here for the details.

My Dev Team is an AI chat participant for VS Code. You talk to it as
`@devteam` in the normal chat panel, and it can answer questions, draft
step-by-step plans, and carry them out: reading, searching, creating, and
editing files in your workspace and running shell commands - asking you first
before it runs a command (file changes apply directly to your Git-backed
workspace, where they are easy to review and revert). Out of the box everything
runs locally against your own [Ollama](https://ollama.com) server and nothing
leaves your machine; if you prefer, you can also point it at a cloud model
(OpenAI, Anthropic, or Groq) by adding an API key - see
[Choosing a model](#4-choosing-a-model).

It is meant to work alongside GitHub Copilot, not just replace it (though you
can use it as a replacement if you want). Because it sits in the same chat
panel and can run on a free local model, it is a handy companion: send the
quick, throwaway, or exploratory questions to `@devteam` so you do not burn
through your Copilot budget on them, and when that budget is used up and
Copilot chat stops responding, `@devteam` keeps answering.

## 1. What you need

- **VS Code** 1.95 or newer
- **Node.js** 20.x - only if you want to build the extension yourself; not
  needed to install a `.vsix` someone gave you
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

  Cloud models (OpenAI, Anthropic, Groq) are optional and need only an API key,
  no Ollama pull - see [Choosing a model](#4-choosing-a-model).

## 2. Install

The extension is not on the marketplace yet. You install it from a packaged
`.vsix` file - either one you were given, or one you build yourself.

### Install a `.vsix` you were given

If you received a file like `my-dev-team-vs-code-0.39.1.vsix`, install it one
of two ways:

- **In VS Code:** open the Extensions view (**Ctrl+Shift+X**), click the
  **...** menu at the top of the view, choose **Install from VSIX...**, and
  pick the file.
- **From a terminal:**

  ```bash
  code --install-extension my-dev-team-vs-code-0.39.1.vsix
  ```

To update later, install the newer `.vsix` the same way - it replaces the old
version. Reload VS Code if it asks you to.

### Build the `.vsix` yourself

If you have the source instead, build the package (needs Node.js 20.x):

```bash
npm install
npm run build
npx @vscode/vsce package
```

That writes a `my-dev-team-vs-code-<version>.vsix` into the project folder;
install it with either method above.

After installing, open a workspace folder and you are ready to use `@devteam`.
On startup the extension checks your Ollama server and warns you if it is
unreachable or one of the models above is missing - if you see no warning,
you are good to go. If you have set everything up to run on a cloud provider
instead (no local models in use), it skips this check and stays quiet about
Ollama.

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

- **Add a skill** - a skill is a named set of instructions for a specific kind
  of task (how to write a commit message, how your team formats a migration)
  that the agent loads only when a task matches. A few ship built-in. To add
  your own, create a folder under `.devteam/skills/` (or `.claude/skills/`) in
  your workspace with a `SKILL.md` file in it:

  ```
  .devteam/skills/migration/SKILL.md
  ```

  Start the file with a short header naming the skill and when it applies, then
  write the instructions:

  ```
  ---
  name: migration
  description: How to write a database migration in this project - use when adding or changing a migration.
  ---

  Put migrations in db/migrate, name them with a timestamp prefix, and always
  write a matching down migration...
  ```

  The same folders are also checked in your **home directory**
  (`~/.devteam/skills/` and `~/.claude/skills/`), so a skill you want in every
  project lives there instead of in one workspace. If a project skill and a
  personal skill share a name, the project one wins.

  The agent sees the name and description of every skill, and pulls in the full
  instructions only when a task matches the description - so unrelated requests
  are unaffected. Edits take effect on your next message. Change where skills
  are looked for with `myDevTeam.skills.directories` (see [Settings](#7-settings)).

- **Connect an MCP server** - an MCP (Model Context Protocol) server gives the
  agent extra tools beyond reading, searching, and editing your files - for
  example a database, a browser, or an issue tracker. List the servers you want
  in the `myDevTeam.mcp.servers` setting, as a name to definition map. For
  example, to let the agent work with files through the standard filesystem
  server:

  ```json
  "myDevTeam.mcp.servers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    }
  }
  ```

  Each server is started in the background; its tools appear to the agent named
  `mcp__<server>__<tool>` (e.g. `mcp__filesystem__read_file`). **Every MCP tool
  call asks for your approval first** - the same Approve/Decline prompt the run
  command uses - because an MCP server is third-party code. Servers are launched
  once when you start using the chat, so after adding or changing one, reload the
  window (the "Developer: Reload Window" command). MCP servers are not contacted
  at all in a workspace you have not trusted.

The agent decides on its own whether your request is a question (it answers
directly) or work on files (it plans, then executes). You watch the plan and
an execution transcript stream into the chat as it happens. On a longer task it
also prints a **Progress** checklist from time to time - the plan steps with
each one ticked off as it goes - so you can see where it stands without reading
every tool call.

If the model you are using is a "thinking" model, you also see a dimmed
**Thinking** line while it works - a one-line glimpse of what it is currently
reasoning about, replaced as it goes. It is just a live status, so it disappears
once the real answer or transcript arrives and is never kept afterwards. Don't
want it? Turn off `myDevTeam.thinking.showInChat` (see [Settings](#7-settings)).

## 4. Choosing a model

By default the model is **Auto**: My Dev Team picks the best available model
for each part of your request, and shows you what it chose on a **Model:** line
under each reply. To change it, type **`/model`** in the chat (or use the
**My Dev Team** button in the status bar at the bottom of the window: hover it
for a popup with a **Select model** link, or click it and choose **Select
model**) and pick from the list - or type the name directly, e.g.
`/model Claude Sonnet 4.6`.

The list offers three kinds of choice:

- **Auto** - the best available model for each task, across every provider.
- **A specific model** - always use that one model.
- **A provider** (e.g. "Anthropic (best available)") - stick to that provider
  but let it pick the best model for each task. Type `/model anthropic` (or
  `openai`, `ollama`) as a shortcut.

Out of the box the list is your local Ollama models. To use a cloud model, give
it an API key one of two ways:

1. **Run the "My Dev Team: Set API Key" command** (Ctrl+Shift+P) and paste your
   OpenAI, Anthropic, or Groq key. It is stored securely and never written to
   your settings file. This works with the default (local) engine.
   **Or** set the `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `GROQ_API_KEY`
   environment variable before launching VS Code - the only option if you run
   the `sidecar` engine, which reads keys from the environment. If you switch to
   the `sidecar` engine while a key is set only via "Set API Key", a warning
   reminds you to set the matching environment variable (or switch back to the
   local engine), so the key does not silently stop working.
2. Pick the model with `/model` - cloud models you have a key for become
   selectable; the rest show as unavailable.

Notes:

- Picking a model uses it for the planning and the actual work. The quick
  internal "is this a question or a task?" step is not affected by your choice -
  by default it stays on a fast local Ollama model, so it costs you nothing. If
  you have no Ollama server, point it at a cloud provider with the
  `myDevTeam.triage.model` setting (e.g. `provider:openai`); see
  [Settings](#7-settings).
- **Auto sizes the model to the job.** When the model is Auto (or you picked a
  provider rather than one fixed model), My Dev Team also judges how demanding a
  task is and uses a cheaper/smaller model for simple work (e.g. "write a
  command-line calculator") and a stronger one for hard work (multi-file
  changes, tricky debugging). The reply shows a **Complexity:** line with the
  plan so you can see what it decided (it refines its first guess once it has
  looked at the work). Pinning one specific model turns this off for that model;
  the `myDevTeam.complexityRouting` setting turns it off entirely.
- **Auto** only uses a cloud model once you have set its key; until then it
  stays on your local models. Add a key and Auto will start preferring the
  stronger cloud model on its own.
- Using a cloud model sends your request to that provider. Local Ollama models
  keep everything on your machine.
- **Turning a provider or model off.** If you never want a particular provider
  or model used, add it to `myDevTeam.disabledProviders` (e.g. `["anthropic"]`)
  or `myDevTeam.disabledModels` (e.g. `["qwen3-coder"]`). A disabled choice shows
  as disabled in the `/model` list and never runs - even if you had it pinned,
  the request quietly falls back to Auto among what is left. (Some builds also
  turn providers or models off for everyone; those you cannot switch back on from
  settings.)
- For Azure or another gateway, set `myDevTeam.openai.baseUrl`,
  `myDevTeam.anthropic.baseUrl`, or `myDevTeam.groq.baseUrl` to its URL (see
  [Settings](#7-settings)). (Some builds pin a provider's endpoint - including
  the Ollama server - for everyone; that takes precedence over these settings.)

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

**From the editor, without typing `@devteam`.** Three shortcuts open the chat
for you with the right command already filled in, so you can start from the
code you are looking at:

- **Fix with Dev Team** - hover a squiggle (a warning or error) and open the
  lightbulb / Quick Fix menu (`Ctrl+.`); pick **Fix with Dev Team** to send
  `/fix` with the problem and your uncommitted changes attached.
- **Explain with Dev Team** - select some code, right-click, and choose
  **Explain with Dev Team** to send `/explain` with that selection.
- **Write/repair tests** - open a test file (one named like `*.test.ts`,
  `*_test.go`, `test_*.py`, or under a `tests/` folder) and click the
  **Write/update tests** lens at the top; if the file currently shows errors it
  reads **Repair tests** instead. Either way it sends `/test`.

Each one opens the chat and runs that command for you; everything from there
(approvals, the streamed reply, follow-ups) works exactly as if you had typed
it yourself.

## 6. Approvals: you stay in control

**Approving the plan.** For demanding work, My Dev Team shows you the plan and
waits for your go-ahead before it changes anything. By default this happens only
when it judges a task **complex** (multi-file changes, tricky debugging); you get
three buttons:

- **Approve** - carry the plan out.
- **Cancel** - keep the plan but run nothing; say "go ahead" later to run it.
- **Revise** - type a comment ("split this into smaller steps", "don't touch the
  config") and the plan is redrafted and shown again.

You can change when this happens with the `myDevTeam.planApproval` setting:
`auto` (the default, complex plans only), `always` (every plan), or `never` (run
plans straight through). The `/plan` command always stops at the plan regardless.

**Approving a command.** Running a shell command stops and asks you first, right in the chat: a
**Run Command** prompt shows the exact command, and you click **Approve** to
let it run or **Decline** to skip it. Declining does not abort the run: the
agent is told the command was not approved, carries on with the rest of the
plan, and notes the skip in its report. If you have more than one folder open
(a multi-root workspace), the prompt also names the folder the command will
run in.

Reading, searching, writing, and editing files do not ask by default - they
apply directly. Writing and editing are safe to run unprompted because your
workspace is backed by Git: if the agent changes a file you did not want
changed, you can see it in your source-control view and revert it like any
other edit. (Commit or stash work you want to be sure of first; Git cannot
restore changes that were never committed.) The agent only touches files
inside your workspace folders - it cannot reach outside them, and it will not
write to or edit a few protected locations that can run code on their own:
`.git/` (always) and, by default, `.vscode/`. You can change the protected
list with the `myDevTeam.write.protectedPaths` setting.

If you would rather confirm every file change, turn on
**`myDevTeam.approval.fileChanges`**: each write and edit then shows the same
**Approve** / **Decline** prompt as a command, naming the file, and the change
lands only when you approve. The run-command gate is always on regardless of
this setting.

Cancelling the chat request (the stop button) cancels everything, including a
command already running and any file change still in flight.

If you open a folder you have **not trusted** (VS Code's Restricted Mode), the
agent can still answer questions and read and search your files, but running
commands, writing, and editing are turned off until you trust the workspace.
In a **virtual workspace** (for example a repository opened in the browser),
everything works except running shell commands, which needs a real local
filesystem. In both cases the agent simply tells you why it could not do the
action.

Every approved command's full live output also appears in a read-only
**"Dev Team" terminal** in the terminal panel - open that tab to watch
commands run or to read the session log afterwards; the chat itself only
shows short previews.

## 7. Settings

Open Settings and search for "My Dev Team" (or edit `settings.json`).
Changes take effect immediately - no reload needed. This is also how you point
the extension at different servers or gateways: the endpoint settings below
(`myDevTeam.ollama.endpoint` and the cloud `*.baseUrl` settings) are plain VS
Code settings, so even if you installed from a packaged `.vsix` you just edit
them here - there is nothing to rebuild or reinstall. The ones you are most
likely to touch:

| Setting                          | Default                  | What it controls                                  |
| -------------------------------- | ------------------------ | ------------------------------------------------- |
| `myDevTeam.model`                | `auto`                   | Which model, provider (`provider:<name>`), or `auto` to use; easier to set with `/model` or the **My Dev Team** status button |
| `myDevTeam.triage.model`         | `""`                     | What the quick triage step uses, kept separate from the model above. Empty uses the build's default (a local Ollama model); set `provider:openai` (or `anthropic`/`groq`), `auto`, or a model id when you have no Ollama server. A provider/model the build disabled cannot be chosen |
| `myDevTeam.complexityRouting`    | `true`                   | Let Auto size the model to how hard the task is (cheaper for simple work, stronger for complex). Turn off to ignore difficulty; a pinned model is never affected |
| `myDevTeam.planApproval`         | `auto`                   | When to pause for you to approve a plan before it runs: `auto` (complex plans only), `always` (every plan), or `never`. At the prompt you can Approve, Cancel, or Revise (comment and redraft) |
| `myDevTeam.disabledProviders`    | `[]`                     | Providers to never use (e.g. `["anthropic"]`); shown disabled in `/model` and never run, even if pinned or keyed |
| `myDevTeam.disabledModels`       | `[]`                     | Individual models to never use (e.g. `["qwen3-coder"]`); same as above but per model |
| `myDevTeam.ollama.endpoint`      | unset (uses `http://localhost:11434`) | Where your Ollama server listens. Leave blank for the default your install ships with (localhost if none); set it to point at your own server |
| `myDevTeam.openai.baseUrl`       | `""`                     | Custom OpenAI endpoint (Azure / compatible gateway); empty uses OpenAI's default |
| `myDevTeam.anthropic.baseUrl`    | `""`                     | Custom Anthropic endpoint (a proxy/gateway); empty uses Anthropic's default |
| `myDevTeam.groq.baseUrl`         | `""`                     | Custom Groq endpoint (a proxy/gateway); empty uses Groq's default |
| `myDevTeam.provider.requestsPerMinute` | unset              | Your cap on requests per minute sent to each provider, to stay under its rate limit (e.g. a free-tier quota). Leave unset to use whatever rate your deployment ships with; set a number to override it, or `0` for no cap |
| `myDevTeam.run.commandTimeoutMs` | `60000`                  | How long a shell command may run before it is killed |
| `myDevTeam.chat.toolSnippetLines`| `5`                      | Lines of a written file previewed in the chat transcript (`0` hides the preview) |
| `myDevTeam.usage.showInChat`     | `true`                   | Show the **Tokens** line under each reply; the status button's session total and the usage report stay regardless |
| `myDevTeam.changes.showInChat`   | `true`                   | Show the **Changes** line ("N files changed, +X -Y") under a reply that wrote files; it only appears when a turn changed files |
| `myDevTeam.summary.showInChat`   | `true`                   | After a task that changed files, show a **Summary** recap in three sections (What ships, How it's built, Tests and docs). Turning it off skips the extra summarizing step |
| `myDevTeam.thinking.showInChat`  | `true`                   | Show a dimmed **Thinking** line while a reasoning model works - its latest thought, replaced as it goes and dropped once the answer arrives. Turning it off skips capturing the model's reasoning |
| `myDevTeam.instructions.files`   | `["AGENTS.md", "CLAUDE.md"]` | Which project files in your workspace root hold standing rules for the agent; the first one found is used. An empty list turns the feature off |
| `myDevTeam.skills.directories`   | `[".devteam/skills", ".claude/skills"]` | Where to look for your skills, each at `<folder>/<name>/SKILL.md` - checked in your workspace and your home directory. An empty list turns off your own skills (the built-in ones still work) |
| `myDevTeam.mcp.servers`          | `{}`                     | MCP servers whose tools the agent may call, as a name -> `{ command, args, env }` map. Launched over stdio; every call asks for your approval. Not contacted in an untrusted workspace; reload the window after changing it |
| `myDevTeam.write.protectedPaths` | `[".vscode"]`            | Folders the agent will not write to or edit, on top of the always-protected `.git` (these can run code on their own). Add your own; an empty list keeps only `.git` protected |
| `myDevTeam.approval.fileChanges` | `false`                  | Ask you to approve every file write and edit (same Approve/Decline prompt as a command). Off by default - changes apply directly since your workspace is Git-backed. Running commands is always gated regardless |
| `myDevTeam.telemetry.evalLog`    | `false`                  | Opt-in local log of runs and 👍/👎 feedback - stays on your machine, records no prompts or file contents |
| `myDevTeam.telemetry.shadowTriage` | `false`                | While the log is on, also check on each `/command` run how the router would have classified it, so the usage report can show how often it agrees. Adds a small background step per command run |
| `myDevTeam.engine`               | `local`                  | Where the agent runs: `local` (inside the extension) or `sidecar` (a separate process); see [Local vs sidecar engine](#local-vs-sidecar-engine). Takes effect on your next request |

There are further knobs for read/search limits (`myDevTeam.read.*`,
`myDevTeam.search.*`).

### Local vs sidecar engine

Most people never touch this. The `myDevTeam.engine` setting picks **where** the
agent's "brain" runs - it does not change what `@devteam` does or which models
it uses:

- **`local`** (the default) - the agent runs inside the extension itself. This
  is what you want unless you have a reason not to.
- **`sidecar`** - the same agent runs in a separate background process. The
  parts you interact with (approval prompts, the chat transcript, file edits)
  stay in the editor; only the agent's reasoning is moved out into its own
  process, so a hiccup there cannot disturb the rest of VS Code.

To switch, open Settings, search for "My Dev Team", and set **Engine** to
`local` or `sidecar` (or edit `"myDevTeam.engine"` in `settings.json`). The
change takes effect on your **next message** - no reload needed.

One thing to know if you use a cloud model on the **sidecar** engine: it reads
API keys **only from environment variables** (`OPENAI_API_KEY`,
`ANTHROPIC_API_KEY`, `GROQ_API_KEY`), set before you launch VS Code - the
"My Dev Team: Set API Key" command does not reach it. If you switch to
`sidecar` while a key is stored only via that command, a one-time notice
reminds you to set the matching environment variable (or switch back to
`local`), so a cloud model does not quietly stop working. If the sidecar
process keeps crashing, the extension warns you once and falls back to the
local engine on its own until you switch engines or reload.

(A third value, `remote`, is reserved for running the agent on a remote server
and is not available yet - selecting it just falls back to `local` with a
warning.)

## 8. Token usage

Every reply ends with a **Tokens** line - how many tokens that request spent
(input and output). The **My Dev Team** button in the status bar keeps a running
**total for the session** (hover the button to see it, or read it on the
**Token usage** menu row); click the button and choose **Token usage**, or click
the **Token usage report** link in the hover, to open a **token usage report**: a
Highlights section (how much went to prompts vs answers, how often the prompt
cache helped, how many tokens sat behind your 👍/👎 votes, how fast runs were,
and - as you keep chatting - how much your prompts grow as the conversation
builds up), an **Input by source** table showing whether project instructions,
conversation history, or attachments are taking up your prompts, and breakdowns
by step, model, command, and day. Turn on `myDevTeam.telemetry.shadowTriage` and
it also reports how often the router agrees with the route your slash commands
pin. A `~` in front of a number means it includes an estimate, because the model
did not report exact counts.

- Don't want the per-reply line? Turn off `myDevTeam.usage.showInChat`. The
  status button's session total and the report stay.
- The report is built from the local log, so it only has data once you turn on
  `myDevTeam.telemetry.evalLog` (see below). Until then it tells you so.

When a request changes files, the reply also ends with a **Changes** line - for
example "4 files changed, +120 -30" - so you can see the size of the edit at a
glance, the way you would skim a pull request before reading it. It appears only
when files were actually written; turn it off with `myDevTeam.changes.showInChat`.

Right above that, a task that changed files gets a **Summary** recap in three
short sections - **What ships** (what the change delivers), **How it's built**
(the approach), and **Tests and docs** - so you get a pull-request-style
overview without rereading the whole transcript. It is written by a quick extra
step after the work is done, only when files changed; if you would rather skip
that step, turn off `myDevTeam.summary.showInChat`.

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
  missing or invalid - set it with "My Dev Team: Set API Key" or the provider's
  environment variable (see [Choosing a model](#4-choosing-a-model)).
- **A cloud model shows as unavailable in `/model`** - you have not set its API
  key yet; run "My Dev Team: Set API Key" (or set the provider's environment
  variable and restart VS Code).
- **A cloud request fails saying it was rate limited** - the extension already
  retries automatically after the wait the provider asks for, so brief limits
  recover on their own. If it still fails (a tight free-tier quota), set
  `myDevTeam.provider.requestsPerMinute` to slow the request rate, or upgrade
  your provider plan.
- **A command seems stuck** - long commands are killed after
  `myDevTeam.run.commandTimeoutMs` (60s by default); raise it for slow
  builds or test suites.
- **Replies feel slow** - the agents run on local models; speed depends on
  your hardware and the model sizes. Smaller models respond faster.
