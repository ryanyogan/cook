# Handoff protocol (every agent reads this first)

Work on Cook is done by a chain of short-lived agents. No agent is trusted to
remember anything: the files in this directory are the only shared memory.

## Before you start
1. Read `.handoff/NEXT.md` (current direction) and `.handoff/DESIGN-TS.md` (architecture
   decisions for the TypeScript engine, already made; do not re-litigate). `DESIGN.md`
   describes the frozen Elixir engine.
2. Read the other `.handoff/*.md` files your brief names (what earlier agents did, verified,
   and left open).
3. The product spec is `docs/cook-spec.md` (private, git-ignored, written before the target
   changed from Phoenix to Playwright Test). Your scope is your brief.

## Context budget: stay under 170k tokens
- Never dump whole files or dependency trees. Use `grep -n`, read line ranges, and
  pipe command output through `tail -n 40` / `head`.
- Do not read `deps/` wholesale; grep for the function you need.
- Stay inside your stage's scope. Do not refactor other stages' code.
- If your stage is not finished by the time you have done a lot of work (rule of
  thumb: you have made ~80 tool calls, or you notice you are re-reading things you
  already read), STOP at a clean point, write your handoff, and say "INCOMPLETE,
  respawn needed" in your final reply. A fresh agent will continue from your file.
  Stopping early with a good handoff is a success, not a failure.

## When you stop (finished or not) write `.handoff/<stage>.md`
Use exactly these sections:
- **Status**: COMPLETE or INCOMPLETE.
- **Done**: what exists now, with file paths.
- **Verified**: the exact commands you ran and their real results (numbers, pass/fail).
  Anything you did not run goes under Unverified, never here.
- **Unverified / assumptions**.
- **Not done / next steps**: concrete, ordered.
- **Gotchas**: things that surprised you and will bite the next agent.
- **Interfaces**: public functions / commands / file formats later stages rely on.

If a previous handoff for your stage exists, append a new dated section to it
rather than rewriting history.

## Rules
- Do not invent API names. If you are unsure a function exists in the installed
  version, grep `deps/` or the Elixir install and confirm before using it.
- Report failures honestly. A failing test in your handoff is fine; a hidden one is not.
- Do not commit, push, or delete anything outside your scope unless your brief says so.
- Final reply to the orchestrator: under 250 words, status first, pointing at your handoff file.
