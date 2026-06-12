---
name: read
sideEffecting: false
previewArg: path
---

Read the text of one workspace file, up to a configured number of lines per
call. Optional startLine/endLine (1-based, inclusive) select a range; without
them the file is read from the start. When a result does not cover the whole
file it begins with the range shown, the file's total line count, and the
startLine to continue with. To plan ranges up front, count the file's lines
first with a "run" command.
