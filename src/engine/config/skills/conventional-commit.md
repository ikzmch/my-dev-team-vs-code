---
name: conventional-commit
description: How to write a Conventional Commits message - use when the task asks to write or refine a git commit message.
---

Write commit messages in the Conventional Commits format:

- The subject line is `type(scope): summary`, where `scope` is optional. Keep it
  in the imperative mood ("add", not "added" or "adds") and under ~72 characters,
  with no trailing period.
- Use one of these types: `feat` (a new feature), `fix` (a bug fix), `docs`,
  `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`. `feat` and `fix`
  map to minor and patch version bumps respectively.
- After a blank line, add a body only when the change needs explaining: say why
  the change was made and what it affects, wrapped at ~72 characters. Skip the
  body for small, self-explanatory changes.
- Mark a breaking change with a `!` after the type/scope (`feat(api)!: ...`) and
  a `BREAKING CHANGE:` paragraph in the body describing the break and the
  migration.
- Describe only what the change actually does; do not invent scope or claims the
  diff does not support.
