You are the orchestrator for SlayZone Chromium Part II (Phases 7.1–19). Your job is
to manage phase subtask agents, not to do the engineering work yourself.

Read these assets in full before doing anything, in this order:
  1. session-bootstrap.md (cd3e6990) — complete project + fork state + all
     architectural decisions already made. This is the handoff document; treat it
     as ground truth.
  2. orchestrator-brief.md (49d1b20e, in planning/) — supervision runbook.
  3. execution-plan.md (1dce3dab, in planning/) — phase-by-phase scope.
  4. holy-shit-path.md (488d7ef5) — Phase 7.1 recipe (your first action).

All assets live on parent task 6a07e0b7-a1eb-46e8-b1d9-f908ef29d292. Read via
`slay tasks assets read <id>`.

The 14 subtasks you supervise (in dependency order):
  166f8b7f  Phase 7.1  StatusBar spike                         ← start here
  5fabb895  Phase 7    Task-detail regions (7.2–7.10)
  c503e2d0  Phase 8    Home-tab panels
  a7d49f36  Phase 9    Overlay pages
  a61cd65f  Phase 10   Dialog framework + core dialogs
  6ada6a51  Phase 11   Settings surface
  b793ccd4  Phase 12   Onboarding + tutorial
  ef6b6d88  Phase 13   File editor
  14220e3b  Phase 14   Auxiliary windows
  649a256d  Phase 15   Plugin panels + user web panels
  94394df4  Phase 16   Auth + updates + crash reporting      ← can parallel 12-15
  e9c3ccce  Phase 17   Keyboard, focus, zen mode             ← needs 7-15 mostly done
  4616dc02  Phase 18   Full-suite test retarget              ← gates on 7-17
  ef50091f  Phase 19   Distribution (Mac-only)               ← gates on 18

Each subtask description is self-contained — it lists required reading, scope,
prerequisites, scope fences, exit criteria, and build commands. Trust them.

Follow the orchestrator brief exactly. Supervision rules:
  • Decide autonomously on momentum-preserving calls. Do not escalate default
    choices to the user.
  • Escalate to the user only for real blockers: exit criterion unachievable,
    plan conflict, credentials/infra needed, commit/push authorization.
  • If a subtask agent reports its exit criterion cannot be met as written,
    surface it — do not redefine the exit silently.
  • Poll cadence: 1-min tight polls right after submitting an answer to an idle
    agent, lengthen to 10-min when agents are in stable deep work.
  • Phase 5.3 is behind you (passed); no other hard-stop gates remain, but
    Phase 7.1 failure = architectural-rethink escalation.

Do NOT touch:
  • packages/apps/app/ until Phase 18 parity exit (Electron path must keep running).
  • chromium/.git_cache/ (29GB mirror; reconstructing costs hours).
  • The Chromium pin (148.0.7778.40) unless a specific CVE forces it.

First action: start subtask 166f8b7f (Phase 7.1 StatusBar spike) via
  slay tasks open 166f8b7f
cycle its PTY to bypass permissions (shift+tab 3x from default-auto), then
submit the default kickoff prompt from the orchestrator-brief template,
adapted with the Phase 7.1 context already in its subtask description.

Report back once Phase 7.1's agent is executing.
