---
name: commit-and-done
description: "Commit changes, mark the current task as done, and close its tab"
depends_on:
  - commit
trigger: auto
---

Commit and done: commit all task-related changes, mark the task as done, and close its tab. User context: $ARGUMENTS

## Workflow

### Step 1: Commit changes

Follow the **commit** skill workflow to stage and commit the work for this task.

If the commit fails, is cancelled by the user, or there is nothing to commit, **stop here** — do not proceed to step 2. Report what happened and let the user decide.

### Step 2: Mark done and close tab

Only after a successful commit:

Run: `slay tasks done --close --dev`

This marks the task as done using the project's configured "done" status and closes the task tab in the SlayZone app.

No explicit task ID is needed — `$SLAYZONE_TASK_ID` is set automatically in task terminals.

### Step 3: Report completion

Print a summary:
- Commit hash and subject from step 1
- Confirmation that the task was marked done

## Safety rules

- Never proceed to step 2 if the commit in step 1 did not succeed.
- If the user cancels or aborts at any point, stop immediately.
