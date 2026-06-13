# Editing requests

The deliverable is a change to a file that already exists. These exercise the
`edit` tool: the executor reads the file first, then replaces an exact text
match instead of rewriting the whole file. A change that grows beyond a
targeted replacement falls back to `write` with the complete new contents.
Neither `write` nor `edit` asks for approval - the workspace is git-backed, so
the changes are recoverable; only `run` commands prompt first.

Most prompts below assume a file from [planning-simple.md](planning-simple.md)
exists; run that example first, or aim the prompt at any file of your own.

## Targeted change to one file

```
@devteam in calculator.py, add a power operation to the menu: ask for base and exponent and print the result; keep the existing operations and menu style unchanged
```

## Follow-up edit (conversation history)

Right after the "Console calculator" example, in the same chat session:

```
@devteam now also handle non-numeric input: when the user types something that is not a number, print "please enter a number" and ask again instead of crashing
```

## Small behavior fix

```
@devteam wordcount.py crashes when the file path does not exist; change it to print a friendly error and exit with code 1 instead of a traceback
```

## Tweak a constant and the texts around it

```
@devteam in guess.py, change the range from 1-100 to 1-1000 and update every message that mentions the range so they stay correct
```

## Edit, then verify

```
@devteam change fizzbuzz.py to print FizzBuzz for multiples of 3 and 5 up to 100 instead of 50, then run it and show me the last ten lines
```

## Rename across a project

A bigger edit workload: several files, each needing exploration first
(this one fits [planning-advanced.md](planning-advanced.md) too).

```
@devteam rename the ContactBook class in the contacts project to AddressBook: update its definition, every import and usage, and any message or comment that mentions the old name
```
