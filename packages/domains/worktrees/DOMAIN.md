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

**2026-11-16: Paged preview loaders follow active effects and scoped clients (FU1 S15)**
`useDiffTexts`, `useIgnoredTree` and `usePagedStashDiff` acquire a fresh loader in
layout-effect setup and dispose/abort that generation in cleanup. React Activity
hide/show and StrictMode replay retain hook state but restart effects, so a
permanently disposed loader must never be retained as the active loader. A small
external store (`loader-lifetime.ts`) exposes the current loader and its snapshot;
rendering alone starts no I/O. Late batch/page/error/expiry completions cannot
publish, follow more pages or restart after disposal. Cleanup aborts only its
captured scoped client's requests.

Loader identity includes the scoped tRPC client (hub, task/project and computer),
path and read options/open state. Unchanged identity keeps its cache; same paths
on a different scope refetch. Stash identity additionally includes the selected
SHA, even when its numeric index is reused. Each stash remainder has its own
state identity, fenced across every await and expiry restart, preserving current
failure retries and all UTF-8 pages. Stale successes and errors cannot change the
current first page, loading/error flags or controls.

The actual large-preview Activity regression also exposed the shared diff viewer
choosing an expanding horizontal-overflow wrapper as its vertical viewport. The
scroll-parent picker now prefers an ancestor that actually overflows vertically;
otherwise it retains the nearest declared viewport fallback. Existing absolute
outer-virtualizer boundaries still apply. This keeps large split previews
virtualized during task-tab cleanup without dropping rows or changing diff data.

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

**2026-11-15: Git diffs are bounded and paged (FU1 S5)**
The working diff, per-file diffs, untracked previews and stash diffs used to be
one whole string per reply (`-U99999` and unlimited stdout). Large changes then
exceeded the 100 MiB frame limit and stalled the computer.
- **Snapshot.** With `opts.paged` (the renderer always sends it; older computers
  ignore it), each side carries whole files up to 4 MiB, cut between file
  sections. `deferred` names the rest (the `--name-status` entries with the same
  flags, so `-w` drops the same files, that git wrote no section for; read from the
  `diff --git` / `diff --cc` headers it actually wrote, C-quoted paths decoded, never
  by position: during a merge the unmerged `--cc` section comes first and
  `--name-status` lists that path twice). The patch is forced to `a/` `b/` prefixes.
  Each deferred file has its own fingerprint (unstaged: worktree stat + its index
  entry, so a partial stage counts; staged: its `--cached --raw` entry),
  plus one over all of them for older clients; the panel refetches only the files
  whose own fingerprint changed and keeps their old text until the new one arrives.
  A failed batch is retried twice, then shows a retry (single file: in place;
  continuous flow: a "Could not load N files" row; a kept old diff is marked
  outdated) and is asked again on its own after 15 s. Renames keep their old path.
- **Deferred files.** They come in budgeted batches (`getFileDiffsPage`, 8
  concurrent gits, rename pathspec paired).
- **Large files.** A file over budget is read by `readGitText`: git runs once,
  spooled to a temp file, and is served in line-cut pages (5 min idle, dropped by
  an unref'd timer; 1 GiB LRU; `GIT_TEXT_EXPIRED` restarts the read). Spool folders
  are named by pid; the first spool sweeps folders of processes that are gone. The panel shows the first page plus
  "Load rest of diff (X MB)".
- **Untracked files.** `getUntrackedFileDiffs` gains `paged` (`$paged` answer).
- **Stash diffs.** They read through `readGitText` too.
- **Older computers.** The hub serves `readGitText` from the whole-text ops.

**2026-11-15: Setup-script replies and commit lists are bounded (FU1 S4)**
- **Setup scripts.** A worktree setup script's reply carries only the LAST 1 MiB of its output (`output-tail.ts`, UTF-8-safe), plus `outputBytes` and `outputTruncated`. The full output still streams as it runs; no UI shows the reply's output. Under 1 MiB the reply is unchanged.
- **Commit lists.** `getCommitsSincePage` pages `getCommitsSince` (≤ 2000 commits / 4 MiB). Its cursor pins both ends as of page 1 (the branch's tip and `sinceRef`'s commit); a later page's error is an error, never a short list. For a `boundedReads` computer, the hub assembles `worktrees.getCommitsSince` from those pages, and builds `getResolvedForkGraph` / `getResolvedUpstreamGraph` WHOLE itself, with the same graph and counts (`fork-graph.ts`, pure). Older computers get the whole-answer ops.
