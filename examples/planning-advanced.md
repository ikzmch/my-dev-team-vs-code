# Advanced planning requests

The deliverable is a multi-file or workspace-aware change. A good plan here
starts with exploration steps (search/read) before any edit or command, and
may use most of the 8-step budget.

On runs this long the agent prints a **Progress** checklist from time to time
as it works: the plan steps with each one's status, the done ones ticked off
and the current one marked in progress. It shows up inline in the execution
output, so you can glance at where things stand without reading every tool
call. The agent decides when to show it - it does not pause the work or add
steps, it just reports. The examples below are the kind of multi-step request
where you will see it update a few times before the run finishes.

## Multi-file project from scratch

```
@devteam create a small python project "contacts": a Contact dataclass in models.py, a ContactBook class in book.py that can add, remove, search by name, and save/load to contacts.json, and a console menu in main.py that wires it together; then run main.py to check it starts
```

## Refactor guided by the existing code

```
@devteam find every place in src/ that calls fetchUser and change them to use the new getUser(id, options) signature; update the corresponding tests so npm test still passes
```

## Add a feature to an existing codebase

```
@devteam add a /health endpoint to the express server in this repo that returns the package version and uptime as JSON; find where routes are registered, follow the same style, and add a unit test next to the existing route tests
```

## Investigate, then fix

```
@devteam the test in test/parser.test.ts named "handles empty input" is failing; read the test and the parser it covers, find the cause, fix the parser without changing the test's expectations, and run the tests to confirm
```

## Cross-cutting cleanup

```
@devteam search the project for console.log calls outside test files, replace them with the logger from src/log.ts (importing it where missing), and run the linter to make sure nothing broke
```
