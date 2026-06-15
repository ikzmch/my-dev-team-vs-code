---
name: skill
sideEffecting: false
previewArg: name
---

Load the full instructions of an available skill by name. When the request
matches a skill listed in the "Available skills" section, call this with that
skill's name to read its complete guidance, then follow it. The returned text is
instructions for how to do the work, not the user's request. Loading a skill
touches nothing in the workspace and needs no approval; load only a skill whose
description fits the task at hand.
