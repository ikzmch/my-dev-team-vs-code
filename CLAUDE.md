# Project instructions

## Keep DESIGN.md in sync

DESIGN.md is the developer documentation: architecture, request flow, the
engine protocol, configuration, the model router, the tools, development
setup, and the roadmap. Every time a significant change is made, update
DESIGN.md in the same piece of work - do not leave it for a follow-up.
Significant means anything DESIGN.md describes or a reader would rely on,
e.g.:

- architecture: new/renamed/deleted files in `src/`, new layers or seams
- configuration: the `.md` config formats (agents, models, tools), frontmatter
  fields, capability vocabulary, registered models
- behavior: the request flow, what `@devteam` does, model selection results
- workflow: build/test scripts, prerequisites (e.g. which Ollama models to pull)

Check in particular the architecture tree, the config table, the
capability-router section, "Current behavior", "Prerequisites", and the
scripts table - they name concrete files and models and drift easily.

Pure refactors that change no structure or behavior, and test-only changes, do
not require a DESIGN.md update.

## Keep README.md high-level

README.md is the front page, written to attract developers and end users: a
short pitch, the highlights, links to QUICKSTART.md (end users) and DESIGN.md
(developers), a minimal getting-started snippet, the tech stack, and the
license. Keep it at that altitude - detail belongs in DESIGN.md or
QUICKSTART.md, never here. Update it only when the pitch-level facts change:
what the extension is and does, a headline feature, the tech stack, the
build/launch one-liner, the license, or the set of documents it links to.

## Keep QUICKSTART.md in sync

QUICKSTART.md is the end-user guide: it tells a non-developer how to set up,
launch, and use the extension. Every time a change affects what an end user
sees or does, update it in the same piece of work - do not leave it for a
follow-up. That means changes to:

- setup: prerequisites, which Ollama models to pull, build/launch steps
- usage: what `@devteam` does, the slash commands and their effects,
  attachments, follow-ups
- the approval flow: which actions ask first, what the prompts show, what
  Approve/Decline/cancel do, the "Dev Team" terminal
- user-facing settings: any added/renamed/removed `myDevTeam.*` setting or a
  changed default
- feedback and troubleshooting: the 👍/👎 flow, the eval log, common failure
  modes and their fixes

Keep it written for an end user, not a developer: plain language, no
architecture or implementation detail, no source file paths. Internal
changes (refactors, new seams, protocol work) that do not change what the
user experiences do not require an update.

Every time a significant change is made, add a CHANGELOG.md entry in the same
piece of work, following the file's existing Keep a Changelog format (newest
version first, `## [x.y.z] - date`, changes under `### Added` / `### Changed`
/ `### Fixed` / `### Security` / `### Removed`):

- one entry per change: a bold short title plus 1-2 sentences - what changed
  and why it matters, no commit hashes, no implementation detail
- skip negligible changes entirely: pure renames, documentation-only changes,
  test-only changes, formatting, and minor tweaks get no entry
- propose the version with the entry: bump the minor version when the change
  is significant (a new feature, a behavior change, an architecture change),
  bump only the patch version for fixes, hardening, and refactors; propose a
  major version bump only when it is really justified (e.g. a breaking change
  or a milestone like the first stable release)

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
