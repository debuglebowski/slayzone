---
name: release-monitor-ci
description: "Monitor CI on main and iterate until it is successful"
trigger: auto
---

Monitor the Release workflow and iterate until it succeeds. User context: $ARGUMENTS

## Workflow

1. **Find the latest Release run.**
   - Run `gh run list --workflow=release.yml --limit 1` to find the latest run.
   - If no run exists, tell the user and stop.

2. **Wait for the run to complete.**
   - Run `gh run watch <run-id> --exit-status` to stream logs and wait.
   - If it succeeds, report success and stop.

3. **On failure, diagnose.**
   - Run `gh run view <run-id> --log-failed` to get failed job logs.
   - Identify the root cause from the logs.

4. **Fix the issue.**
   - Make the minimal code/config change to fix the failure.
   - Commit with a conventional commit message (e.g. `fix(ci): ...`).
   - Push to main.

5. **Loop.**
   - Wait for the new Release run to appear (`gh run list --workflow=release.yml --limit 1`).
   - Go back to step 2.
   - Repeat until the Release workflow is green or you've attempted 10 iterations.

6. **If stuck after 10 iterations**, report what's failing and ask for guidance.

## Rules

- Only fix CI-related failures — don't refactor unrelated code.
- Each fix should be its own commit.
- Never force-push or rewrite history.
- If a failure looks like a flaky test (passes on retry), re-run with `gh run rerun <run-id> --failed` instead of changing code.
