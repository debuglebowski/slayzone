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

### Chat answers and threads

- `chat/AssistantAnswer.tsx` owns the answer bubble, full-row hover highlight, top-right Copy/Thread/More toolbar, and shared Activities/Files/Threads/details footer. The toolbar keeps the same placement for short and long replies.
- `chat/useAnswerThreads.ts` opens discussions for a specific answer in the current conversation. `ChatThreadsPanel` selects them with tabs and keeps visited discussions mounted so switching preserves their state. The open panel (answer + selected thread) is view state in localStorage per hub + tab (`chat/answer-threads-panel.ts`), so reload/restart reopens it; closing forgets it, and a remembered thread that no longer exists closes it.
- The first question creates a durable thread through `chat.threads.create`. Each discussion uses an ordinary `ChatPanel` and its own terminal tab, event history, draft, and CLI conversation. Thread tabs stay out of the terminal tab bar.
- “Send to main” previews an editable conclusion, then uses the main chat queue. The returned message links back to its discussion. Queued conclusions carry their source conversation ID; the queue waits rather than delivering them into a different main conversation.

### Pinned messages

- A user message (with an id) or a finished answer of the main conversation pins from its row (`PinnedMessageControls.tsx`); a pinned row keeps a filled pin mark. `pinned-messages.ts` decides what pins and keys a pin by the row's timeline key (`timeline-item-key.ts`, the same key the timeline renders with).
- `usePinnedMessages.ts` lists the pins of the conversation on screen (`chat.pinnedMessages.*`, live via `onChanged`), toggles optimistically, and goes to a pin: through its page when not loaded (`row`), opening the fold a rewind put it in. The composer footer's `PinnedMessagesPopover` and Cmd+K ("Go to pinned message…", previous / next) read it.

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

### `/tab-label`
- `getTabLabel` / `getModeLabel` / `numberDuplicateLabels` (`client/get-tab-label.ts`), pure: what desktop's tab bar calls a tab; the mobile app's agent screen names tabs the same way

### `/slash-commands`
- The chat's `/` commands without the menu (`autocomplete/slash-commands.ts`), DOM-free: the builtins registry + `availableBuiltins`, the CLI's list (`cliCommandItems`), command files as the CLI names them (`customCommandItems`, `takesArguments`, `expandCommandBody`, `transformCommandSubmit`), `rankByName`, `resolveEnter`, `resetChat`. The desktop autocomplete sources build on the same functions; the mobile chat's `/` menu uses them directly

### `/shared`
- `TerminalTab` - Tab data type
- `CreateTerminalTabInput` / `UpdateTerminalTabInput` - Input types
