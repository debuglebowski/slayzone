# AI Config Domain

Centralized management for AI configuration:

- Skills (reusable AI instructions)
- Commands (prompt commands / runbooks)
- Context Files (CLAUDE.md, AGENTS.md, etc.)
- Project selections copied from library repository items

## Contracts (`shared/`)

- `AiConfigItem` - Config artifact (library or project scoped)
- `AiConfigProjectSelection` - Per-project selected item with target path
- `ContextFileInfo` - Discovered context file on disk

## Main Process (`main/`)

- `registerAiConfigHandlers(ipcMain, db)` - IPC handlers for CRUD, selection state, and context file I/O

## Client (`client/`)

- `ContextManagerPage` / `ContextManagerShell` - Full-page Context Manager
- `ContextItemEditor` - Inline editor for skills/commands

## Slay setup

The task banner sends `taskId`, `projectId`, and the effective workspace path.
The hub injects a `SlayExecutor` resolving the same computer as workspace browsing;
checks and setup execute there, never falling back to hub files after a remote
failure. Standalone hosts retain the local ops. Computer handlers enforce allowed
roots, run `slay init --path` with a temporary CLI relay capability, and share the
instruction-file check through `@slayzone/ai-config/slay-setup`.
