# Running requests

The deliverable depends on executing a shell command in the workspace: running
a script, the tests, a build, a linter, or a git command, and reporting what it
printed. These exercise the `run` tool. The command runs in the workspace root,
in your platform shell (PowerShell on Windows, /bin/sh elsewhere), and its
output - success or failure - comes back into the chat.

`run` is the only tool that asks first: each command shows an approval prompt
with the exact `$ command` line, and Approve/Decline decides whether it runs. A
declined command does nothing and tells the model it was not approved. Long or
hung commands are killed on a timeout, and cancelling the chat kills the process
too. Watch the live output in the "Dev Team" terminal while it runs.

Most prompts below assume a script or project from the other examples exists;
create one first, or aim the prompt at any file of your own.

## Run an existing script

```
@devteam run calculator.py and show me what it prints
```

## Create, then run to verify

```
@devteam create fizzbuzz.py that prints fizzbuzz from 1 to 50, then run it and show me the output
```

## Run the tests

```
@devteam run npm test and tell me whether everything passes; if anything fails, show me the failing output
```

## Check the environment

```
@devteam what python version is on this machine? run the command to find out and tell me
```

## Inspect git state

```
@devteam run git status and git log for the last five commits, then summarise what has changed and whether anything is uncommitted
```

## Build and report

```
@devteam run the build script in package.json and tell me if it succeeds; if it errors, show me the error output
```

## Run, read the failure, then fix

A command whose failure feeds the next step (this one fits
[planning-advanced.md](planning-advanced.md) too: it runs, reads, edits, and
runs again).

```
@devteam run wordcount.py against a path that does not exist, show me how it fails, then fix it to print a friendly error and exit 1, and run it again to confirm
```
