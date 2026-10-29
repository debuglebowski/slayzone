# @slayzone/diff-view

Presentational unified-diff rendering, shared by `worktrees` (git panel, PR view, stash) and `task-terminals` (chat edit/patch blocks). No tRPC, no domain dependencies.

## Exports

- `DiffView`: renders one `FileDiff` (unified or side-by-side, wrap, context-line folding), virtualized for large files, syntax-highlighted off the main thread.
- `parseUnifiedDiff`: `git diff` text to `FileDiff[]`, behind a global LRU keyed by the raw patch string.
- `computeInlineHighlights` / `ensureInlineHighlights`: word-level change spans; `DiffView` runs the latter lazily per file.
- Types: `FileDiff`, `DiffHunk`, `DiffLine`, `InlineHighlight`, `DiffViewProps`, `ContextLines`.

Syntax highlighting runs in `tokenize-worker.ts` (Vite `?worker`), emitting `.tok-*` classes styled by `@slayzone/theme-css`.
