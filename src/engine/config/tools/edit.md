---
name: edit
sideEffecting: false
previewArg: path
snippetArg: newText
---

Replace text in an existing file. Give the exact text to replace (oldText)
copied verbatim from the file, and its replacement (newText). oldText must
match exactly one place in the file - include enough surrounding lines to
make it unique. Read the file first and copy oldText from what you read.
Prefer this over "write" for a small targeted change; when the change
rewrites most of the file, use "write" with the complete new contents
instead.
