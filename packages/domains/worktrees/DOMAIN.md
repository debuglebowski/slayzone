# Worktrees Domain

Git integration for tasks. Shows git status, branch, and optional worktree per task (1:1).

## Structure

```
src/
├── shared/types.ts       # DetectedWorktree, MergeResult
├── main/
│   ├── handlers.ts       # IPC handlers for git operations
│   └── git-worktree.ts   # Git CLI wrappers
└── client/
    ├── GitPanel.tsx              # Git section in task detail
    ├── CreateWorktreeDialog.tsx  # Dialog for creating worktrees
    └── utils.ts                  # slugify helper
```

## Database

Worktree data stored on tasks table:

```sql
-- Columns on tasks table
worktree_path TEXT DEFAULT NULL,
worktree_parent_branch TEXT DEFAULT NULL
```

## IPC Handlers

### Git operations
- `git:isGitRepo(path)` - Check if path is git repo
- `git:init(path)` - Initialize git repo
- `git:getCurrentBranch(path)` - Get current branch name
- `git:detectWorktrees(repoPath)` - List worktrees
- `git:createWorktree(repoPath, targetPath, branch?)` - Create worktree
- `git:removeWorktree(repoPath, worktreePath)` - Remove worktree
- `git:hasUncommittedChanges(path)` - Check for uncommitted changes
- `git:mergeIntoParent(projectPath, parentBranch, sourceBranch)` - Merge branch into parent
- `git:abortMerge(path)` - Abort in-progress merge

## GitPanel Features

- Git status check (is repo?)
- Initialize git if not a repo
- Current branch display
- Worktree management (add/remove)
- Merge to parent branch (completes task + kills terminal)

## Dependencies

- Uses: none
- Used by: task (GitPanel in TaskDetailPage)

## Decision Log

**2026-11-15: Copy dialog's ignored-file tree is lazy and paged (FU1 S6)**
`getIgnoredFileTree` sent one node per ignored file (all of `node_modules`) in one
computer reply, which could exceed the 100 MiB frame limit and stall the computer
while it was built. The dialog now opens an index of the ignored files on the
computer (`openIgnoredTree`: one streamed `git ls-files`, held as a sorted path
array under a random id, idle-expiring, LRU 4). `listIgnoredTree` answers one
folder's children page by page, and `matchIgnoredTree` answers a preset's selection
roots page by page (`@slayzone/platform/bounded-reads`, ≤1000 items / 4 MiB per page).
Counts and preset rules are unchanged: exact descendant counts, and basename globs
match at any depth, including inside `node_modules`. The client selection is a set
of roots plus their counts, so row states need no unloaded folders. Unchecking
inside a selected folder loads that chain's folders completely first. Older
computers (no `boundedReads`): the hub fetches the whole tree once and serves the
same pages from a hub-held index (`hub:` ids, bound to scope + repo).
`getIgnoredFileTree` stays for older callers.
