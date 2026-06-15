---
name: changelog-entry
description: How to add an entry to a Keep a Changelog CHANGELOG.md - use when the task adds, changes, or removes a changelog entry or bumps the version.
---

When adding a CHANGELOG.md entry, follow the Keep a Changelog format already in
the file:

- Put new versions at the top, newest first, with a `## [x.y.z] - YYYY-MM-DD`
  heading. Use today's date.
- Group changes under the standard sections, in this order, omitting any that is
  empty: `### Added`, `### Changed`, `### Fixed`, `### Security`, `### Removed`.
- Write one entry per change: a bold short title, then 1-2 sentences saying what
  changed and why it matters. No commit hashes, no implementation detail.
- Match the existing entries' wording and punctuation. Do not reword or reorder
  unrelated existing entries.
- Choosing the version: bump the patch version for fixes, hardening, and
  refactors; bump the minor version for a new feature or a behavior change; only
  propose a major bump for a breaking change or a milestone release.
- Skip negligible changes entirely (pure renames, documentation-only changes,
  test-only changes, formatting): they get no entry.
