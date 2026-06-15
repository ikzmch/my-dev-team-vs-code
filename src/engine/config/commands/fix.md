---
name: fix
description: Diagnose a bug, fix its root cause, and verify the fix.
intent: planning
complexity: complex
---

The user invoked the /fix command: treat the request as a bug to fix.
Diagnose before changing anything: read the relevant code, confirm the
failure where possible (run the project's tests if it has them), and identify
the root cause. Fix the cause rather than the symptom, with the smallest
change that resolves it, then verify the fix.
