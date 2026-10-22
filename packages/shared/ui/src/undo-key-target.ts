/**
 * Whether the undo/redo key event (mod+Z / mod+Shift+Z) belongs to the focused
 * element rather than the app's task undo/redo.
 *
 * Text fields and editors (inputs, textareas, contenteditable, CodeMirror) own it:
 * they have their own text undo. A terminal owns Ctrl+Z — the shell's suspend —
 * but not ⌘Z: xterm produces no shell input for ⌘+letter (we don't enable its
 * kitty keyboard protocol, which would forward it), so on macOS the app's undo
 * applies there. That matters because a task's live terminal holds focus almost
 * permanently — it reclaims focus whenever it blurs to <body> — so deferring to
 * it would make task undo/redo unreachable from any task with a running terminal.
 */
export function focusOwnsUndoKey(e: KeyboardEvent): boolean {
  const el = e.target
  if (!(el instanceof Element)) return false
  // Before the tag check: xterm's input surface is itself a <textarea>.
  if (el.closest('.xterm')) return !e.metaKey
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return true
  if (el instanceof HTMLElement && el.isContentEditable) return true
  return !!el.closest('.cm-editor')
}
