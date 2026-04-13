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

- `ContextManagerSettings` - Settings-embedded context manager
- `ContextItemEditor` - Inline editor for skills/commands
- `ContextFilesPanel` - Context file discovery and editing
