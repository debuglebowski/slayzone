import {
  createElement,
  createContext,
  useCallback,
  useContext,
  useRef,
  useSyncExternalStore,
  type ReactNode
} from 'react'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UndoableAction {
  /** Human-readable label shown in toast, e.g. "Moved task to Done" */
  label: string
  /** Reverse the action */
  undo: () => void | Promise<void>
  /** Re-apply the action (called on redo). If omitted, redo only moves the action back to the undo stack. */
  redo?: () => void | Promise<void>
}

interface UndoStackSnapshot {
  canUndo: boolean
  canRedo: boolean
  undoLabel: string | undefined
  redoLabel: string | undefined
}

interface UndoStackAPI {
  push: (action: UndoableAction) => void
  undo: () => Promise<string | undefined>
  redo: () => Promise<string | undefined>
  subscribe: (listener: () => void) => () => void
  getSnapshot: () => UndoStackSnapshot
}

// ---------------------------------------------------------------------------
// Stack implementation (framework-agnostic)
// ---------------------------------------------------------------------------

const MAX_HISTORY = 20

function createUndoStack(): UndoStackAPI {
  let undoStack: UndoableAction[] = []
  let redoStack: UndoableAction[] = []
  let listeners: Array<() => void> = []
  let snapshot: UndoStackSnapshot = {
    canUndo: false,
    canRedo: false,
    undoLabel: undefined,
    redoLabel: undefined
  }

  function emit(): void {
    snapshot = {
      canUndo: undoStack.length > 0,
      canRedo: redoStack.length > 0,
      undoLabel: undoStack.at(-1)?.label,
      redoLabel: redoStack.at(-1)?.label
    }
    for (const fn of listeners) fn()
  }

  return {
    push(action) {
      undoStack = [...undoStack.slice(-(MAX_HISTORY - 1)), action]
      redoStack = []
      emit()
    },

    async undo() {
      const action = undoStack.at(-1)
      if (!action) return undefined
      undoStack = undoStack.slice(0, -1)
      await action.undo()
      redoStack = [...redoStack, action]
      emit()
      return action.label
    },

    async redo() {
      const action = redoStack.at(-1)
      if (!action) return undefined
      redoStack = redoStack.slice(0, -1)
      if (action.redo) await action.redo()
      undoStack = [...undoStack, action]
      emit()
      return action.label
    },

    subscribe(listener) {
      listeners = [...listeners, listener]
      return () => {
        listeners = listeners.filter((l) => l !== listener)
      }
    },

    getSnapshot() {
      return snapshot
    }
  }
}

// ---------------------------------------------------------------------------
// React Context
// ---------------------------------------------------------------------------

const UndoContext = createContext<UndoStackAPI | null>(null)

export function UndoProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const stackRef = useRef<UndoStackAPI | null>(null)
  if (!stackRef.current) {
    stackRef.current = createUndoStack()
  }
  return createElement(UndoContext.Provider, { value: stackRef.current }, children)
}

/**
 * Hook to interact with the undo/redo stack.
 *
 * ```tsx
 * const { push, undo, redo, canUndo, canRedo } = useUndo()
 *
 * // After mutating:
 * push({ label: 'Moved task to Done', undo: () => revert() })
 *
 * // Cmd+Z handler:
 * if (canUndo) await undo()
 * ```
 */
export function useUndo() {
  const stack = useContext(UndoContext)
  if (!stack) throw new Error('useUndo must be used within UndoProvider')

  const { canUndo, canRedo, undoLabel, redoLabel } = useSyncExternalStore(
    stack.subscribe,
    stack.getSnapshot,
    stack.getSnapshot
  )

  const push = useCallback((action: UndoableAction) => stack.push(action), [stack])
  const undo = useCallback(() => stack.undo(), [stack])
  const redo = useCallback(() => stack.redo(), [stack])

  return { push, undo, redo, canUndo, canRedo, undoLabel, redoLabel } as const
}
