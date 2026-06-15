# My Dev Team - Quick start

You downloaded the `.vsix` file. This page is the shortest path from that file
to a working chat. Follow the steps in order. For everything else - slash
commands, approvals, the full settings list, troubleshooting - see
[HOWTO.md](HOWTO.md).

You will need **VS Code 1.95 or newer**. Nothing here requires Node.js or
building anything.

The extension does not include the AI itself - it connects to one. In a
corporate setting you normally cannot run the AI on your own machine, so before
it can do anything you have to point it at an AI service your organization
already provides. That is Step 2, and it is the part most people miss. You will
use one of two:

- **An Ollama server** that someone has installed for you (on a shared server,
  not your laptop), or
- **An Azure OpenAI deployment** (through Microsoft Foundry).

## Step 1 - Install the `.vsix`

The file is named something like `my-dev-team-vs-code-0.45.0.vsix`.

1. Open VS Code.
2. Press **Ctrl+Shift+X** to open the **Extensions** view (or click the
   four-squares icon in the left sidebar).
3. At the top of that view, click the **`...`** (More Actions) button.
4. Choose **Install from VSIX...**
5. In the file picker, select your `.vsix` file and click **Install**.
6. If VS Code shows a **Reload** or **Restart Extensions** button, click it.

The extension is now installed.

## Step 2 - Connect it to your AI service

Do **one** of the following, depending on what your organization gives you. If
you are not sure which you have, ask whoever sent you the `.vsix`.

### Option A - An Ollama server on your network

Use this if your organization runs Ollama on a shared server. (Ollama does not
have to be on your machine - it usually is not. Whoever runs the server installs
it there and pulls the models `qwen3:8b`, `qwen3:14b`, `qwen3-coder`, and
`gemma3:4b`.) You only need its web address.

1. Press **Ctrl+,** (comma) to open **Settings**.
2. In the search box at the top, type `My Dev Team`.
3. Find **Ollama: Endpoint** and type the server's address into its box, for
   example `http://ollama.mycompany.internal:11434` (the web address only, with
   no `/api` on the end).

There is no Save button - VS Code saves as you type. That is all Option A needs.

### Option B - Azure OpenAI (Microsoft Foundry)

Use this if you have an Azure OpenAI deployment. You need two things from it,
both found in **Microsoft Foundry** on your deployment's page: its **base URL**
(also called the endpoint or target URI) and its **API key**.

First, set the base URL:

1. Press **Ctrl+,** (comma) to open **Settings**.
2. In the search box, type `My Dev Team`.
3. Find **Openai: Base Url** and paste the base URL from Microsoft Foundry into
   its box.

Then, set the API key. Pick **one** of these two ways:

- **As a stored secret in VS Code (recommended):**
  1. Press **Ctrl+Shift+P** to open the Command Palette.
  2. Type `My Dev Team: Set API Key`, press **Enter**.
  3. Choose **OpenAI**, paste the key from Microsoft Foundry, press **Enter**.
     The key is stored securely and is never written into your settings file.

- **As an environment variable:** set `OPENAI_API_KEY` to the key before you
  launch VS Code (for example in your system environment variables), then start
  VS Code.

Finally, tell the extension to use it:

1. Open the Chat view (**Ctrl+Alt+I**).
2. Type `/model` and press **Enter**.
3. Pick the OpenAI model from the list.

> **If your organization has no Ollama server at all (Option B only):** the
> extension uses a small internal "triage" step that, by default, expects an
> Ollama model - so without Ollama anywhere, requests fail on the first step.
> This is fixed once, when the extension is packaged, by pointing triage at your
> cloud provider too. It is not something you change in Settings, so ask whoever
> prepared your `.vsix` to configure it (it is the `agents.triage.model` backend
> setting described in [DESIGN.md](DESIGN.md)).

## Step 3 - Open a folder

My Dev Team works inside a project folder.

1. Press **Ctrl+K Ctrl+O** (or use the menu: **File -> Open Folder...**).
2. Pick the folder you want to work in and click **Select Folder**.
3. If VS Code asks **"Do you trust the authors of the files in this folder?"**,
   click **Yes, I trust the authors** - otherwise the agent can read files but
   cannot run commands or change files.

## Step 4 - Say hello

1. Press **Ctrl+Alt+I** to open the **Chat** view.
2. In the chat box at the bottom, type `@devteam` followed by a space, then a
   message, and press **Enter**:

   ```
   @devteam hello
   ```

3. Try a real request:

   ```
   @devteam create a console calculator in calculator.py with add, subtract, multiply and divide
   ```

   The agent drafts a plan and then carries it out. It will **ask you to
   approve** before running any shell command - click **Approve** to let it run
   or **Decline** to skip it.

You now have a working setup. Read [HOWTO.md](HOWTO.md) to learn the slash
commands (`/explain`, `/fix`, `/test`, ...), how to attach files, and more.

## Updating the extension later

When you get a newer `.vsix`, install it exactly as in Step 1 - it replaces the
old version. Click **Reload** if VS Code asks. Your settings and API keys are
kept, so you do not redo Step 2.
