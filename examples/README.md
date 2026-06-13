# Example requests

Copy-pasteable prompts for trying out `@devteam` in the VS Code chat. Each
file targets one of the paths the triage agent routes to:

| File | Triage category | What it exercises |
| --- | --- | --- |
| [oneshot.md](oneshot.md) | `oneshot` | Direct streamed answer, no tools |
| [planning-simple.md](planning-simple.md) | `planning` | A short plan plus execution, little or no workspace exploration |
| [planning-advanced.md](planning-advanced.md) | `planning` | Multi-step plans that need exploration (search/read) before edits |
| [editing.md](editing.md) | `planning` | Changes to existing files via the `edit` tool (read first, replace an exact match; applied directly, not gated) |

The deciding question for triage is what you want to receive: text in the
chat (`oneshot`) or a change in your workspace (`planning`). Anything that
should create, modify, delete, or run something is `planning`, no matter how
small.
