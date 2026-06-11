# Project instructions

## Keep README.md in sync

Every time a significant change is made, update README.md in the same piece of
work - do not leave it for a follow-up. Significant means anything the README
describes or a reader would rely on, e.g.:

- architecture: new/renamed/deleted files in `src/`, new layers or seams
- configuration: the `.md` config formats (agents, models, tools), frontmatter
  fields, capability vocabulary, registered models
- behavior: the request flow, what `@devteam` does, model selection results
- workflow: build/test scripts, prerequisites (e.g. which Ollama models to pull)

Check in particular the architecture tree, the config table, the
capability-router section, "Current behavior", "Prerequisites", and the
scripts table - they name concrete files and models and drift easily.

Pure refactors that change no structure or behavior, and test-only changes, do
not require a README update.

## Keep unit tests in sync

When a change needs it, update the affected unit tests and add new ones in the
same piece of work - not as a follow-up:

- new logic or config (a module, a registry entry, a schema field) gets new
  tests covering it
- changed behavior gets its existing tests updated to assert the new behavior,
  not deleted or loosened to make them pass
- run `npm test` before considering the work done

Tests live in `test/` and run on Vitest in plain Node: `vscode` is aliased to
the in-memory fake in `test/mocks/vscode.ts`, and Mastra agents are stubbed so
tests never construct a model or reach Ollama. Follow those patterns rather
than introducing real I/O or network calls.

## No en/em dashes

Never use the en dash (–) or em dash (—) in anything written: code strings,
comments, docs, prompts, commit messages, and chat replies. Always use the
plain hyphen (-) instead.
