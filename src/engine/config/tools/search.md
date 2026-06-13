---
name: search
sideEffecting: false
previewArg: query
---

Find files by glob, or find text inside files. Glob mode returns matching file
paths. Content mode returns one result per matching line, formatted
`path:line: <preview of the line>`, so you can jump straight to a ranged "read"
(startLine around that line) instead of reading the file from the start. In a
multi-root workspace every listed path is prefixed with its folder's name
(e.g. backend/src/app.ts); pass it to read/write/edit unchanged.
