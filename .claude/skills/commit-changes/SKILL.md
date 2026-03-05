---
name: commit-changes
description: "Create focused git commits from local workspace changes using Conventional Commits. Use when the user asks to commit, finalize, or save completed work to git. Include only changes made for the current task, exclude unrelated edits, and ask the user whenever authorship or inclusion is ambiguous."
---

Prepare a git commit for the current task. User context: $ARGUMENTS

## Workflow

1. Inspect repository state.
- Run `git status --short`.
- Run `git diff --name-only` and `git diff --cached --name-only`.

2. Build a candidate set from current-task work only.
- Include files and hunks created or edited for the current request.
- Exclude pre-existing, unrelated, or user-authored edits that were not part of this task.
- If confidence is not high for any file or hunk, mark it as uncertain.

3. Resolve uncertainty before staging.
- If any file or hunk is uncertain, stop and ask the user exactly what to include.
- Ask with explicit paths/hunks so the user can approve or exclude each uncertain change.
- Do not commit until all uncertain items are resolved.

4. Stage explicit paths/hunks only.
- Use `git add <file1> <file2> ...`.
- Use `git add -p <file>` when only part of a file belongs in this commit.
- Do not use `git add .` or `git add -A` unless the user explicitly asks to commit everything.

5. Validate staged content.
- Run `git diff --cached`.
- Confirm staged hunks are only the current-task edits and do not include accidental or unrelated changes.

6. Write a Conventional Commit message.
- Use one type: `feat`, `fix`, `chore`, `refactor`, `docs`, `test`.
- Optional scope format: `type(scope): summary`.
- Keep the subject concise and imperative.

7. Commit non-interactively.
- Run `git commit -m "<message>"`.
- Do not use interactive commit flows.
- Do not amend existing commits unless the user explicitly asks.

8. Report completion.
- Provide commit hash, commit subject, and file list.
- Also report remaining modified or untracked files.

## Safety rules

- Never revert user changes unless explicitly instructed.
- Never run destructive commands (`git reset --hard`, force checkout) unless explicitly instructed.
- Never include a change with unclear ownership; ask the user first.
- Prefer one focused commit per user request unless asked to split into multiple commits.
