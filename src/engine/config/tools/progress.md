---
name: progress
sideEffecting: false
---

Print a status checklist of the plan to the user. Call it from time to time as
you work - when you start a step, finish one, or want to show where things
stand - passing the plan steps you want to show, each as its 1-based step
number and a status of "pending", "in_progress", or "done". This only displays
progress; it touches nothing in the workspace and needs no approval. Use the
drafted plan's step numbers - never invent steps.
