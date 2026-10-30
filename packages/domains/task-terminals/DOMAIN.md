# Task Terminals Domain

Task-specific terminal orchestration layer. Manages terminal tabs for tasks.

## Responsibilities

- Tab data model + persistence (terminal_tabs table)
- "Main tab" concept - first tab whose events affect task state
- Terminal tab UI (tab bar, create, close, rename)
- Keyboard shortcuts (Cmd+Shift+N, Cmd+W, Ctrl+Tab)
- Session ID generation: `${taskId}:${tabId}`

## Architecture

This domain sits between tasks and the terminal core:

```
TaskDetailPage
    ↓
TerminalContainer (this domain)
    ↓
Terminal (terminal domain - generic)
    ↓
PTY (node-pty)
```

## Key Concepts

### Main Tab
- First tab created for a task
- Protected - cannot be closed
- Mode inherited from task, cannot be changed
- Events from main tab affect task state (prompts, activity)

### Secondary Tabs
- User-created additional terminals
- Can have any mode (default: terminal)
- Can be closed
- Events do NOT affect task state

## Exports

### `/client`
- `TerminalContainer` - Full terminal with tabs
- `TerminalTabBar` - Just the tab bar
- `useTaskTerminals` - Hook for tab state management

### `/main`
- `registerTerminalTabsHandlers` - IPC handlers for tab CRUD

### `/prompt-options`
- What a chat prompt card offers (rows + wire answers), pure: shared by the desktop prompt dock and the mobile app

### `/shared`
- `TerminalTab` - Tab data type
- `CreateTerminalTabInput` / `UpdateTerminalTabInput` - Input types
