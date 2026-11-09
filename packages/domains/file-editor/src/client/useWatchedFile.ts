import { useCallback, useEffect, useRef, useState } from 'react'
import { useResubscribeOnComputerConnect, useSubscription } from '@slayzone/transport/client'
import { useTRPC } from './trpc'
import { useStableCallback } from '@slayzone/ui'
import { useWorkspaceTarget } from './workspace-target'

export interface UseWatchedFileOptions {
  projectPath: string | null
  relPath: string | null
  read: () => Promise<string | null>
  save: (content: string) => Promise<void>
  debounceMs?: number
}

export interface UseWatchedFileResult {
  content: string
  setContent: (next: string) => void
  dirty: boolean
  diskChanged: boolean
  /** Why the last save failed; null after a save succeeds. The draft stays dirty. */
  saveError: string | null
  reloadFromDisk: () => Promise<void>
  flushNow: () => Promise<void>
  onBlur: () => void
}

interface PerformSaveDeps {
  savingRef: { current: string | null }
  /** Bumped on every target (projectPath/relPath) change. */
  generationRef: { current: number }
  originalContentRef: { current: string }
  setOriginalContent: (content: string) => void
  setDiskChanged: (changed: boolean) => void
  setSaveError: (error: string | null) => void
}

function saveErrorMessage(err: unknown): string {
  return err instanceof Error && err.message ? err.message : String(err)
}

// Core save. Plain module function — React Compiler can't lower try/finally, and
// the finally must keep its exact timing. Runs serialized (see `performSave`).
// Never rejects: a failed save is reported through setSaveError (the callers are
// fire-and-forget — blur, debounce), and the draft stays dirty so the next save retries.
async function performSaveImpl(
  deps: PerformSaveDeps,
  request: { target: string; save: (content: string) => Promise<void>; generation: number }
): Promise<void> {
  const {
    savingRef,
    generationRef,
    originalContentRef,
    setOriginalContent,
    setDiskChanged,
    setSaveError
  } = deps
  const { target, save, generation } = request
  // Queued behind an identical save that already landed.
  if (generationRef.current === generation && originalContentRef.current === target) return
  savingRef.current = target
  try {
    // `save` was captured at enqueue: a queued save always writes the file it was
    // issued for, even if the target swapped while it waited.
    await save(target)
    setSaveError(null)
    // Baseline = exactly what was written. Keys typed during the write differ
    // from it, so they stay dirty and get saved next. Skipped once the target
    // swapped — the baseline now belongs to another file.
    if (generationRef.current === generation) {
      originalContentRef.current = target
      setOriginalContent(target)
      setDiskChanged(false)
    }
  } catch (err) {
    setSaveError(saveErrorMessage(err))
  } finally {
    if (savingRef.current === target) {
      savingRef.current = null
    }
  }
}

interface ReloadDeps {
  readRef: { current: () => Promise<string | null> }
  generationRef: { current: number }
  contentRef: { current: string }
  originalContentRef: { current: string }
  savingRef: { current: string | null }
  setContentState: (content: string) => void
  setOriginalContent: (content: string) => void
  setDiskChanged: (changed: boolean) => void
}

/**
 * Read disk and fold it into the draft without losing keystrokes.
 * - `discardDraft` (explicit Reload): adopt disk, unless keys were typed while the
 *   read was in flight — those are newer than the click and are kept.
 * - Otherwise a clean draft adopts disk; a dirty draft is never overwritten:
 *   disk === draft → now clean; disk === baseline or our in-flight write → no
 *   outside change; anything else → `diskChanged`.
 */
async function reloadImpl(deps: ReloadDeps, discardDraft: boolean): Promise<void> {
  const {
    readRef,
    generationRef,
    contentRef,
    originalContentRef,
    savingRef,
    setContentState,
    setOriginalContent,
    setDiskChanged
  } = deps
  const generation = generationRef.current
  const draftAtRead = contentRef.current
  const next = await readRef.current()
  // Target swapped during the read: the result belongs to the previous file.
  if (next == null || generationRef.current !== generation) return
  const typedDuringRead = contentRef.current !== draftAtRead
  const dirty = contentRef.current !== originalContentRef.current
  if ((discardDraft && !typedDuringRead) || !dirty) {
    contentRef.current = next
    originalContentRef.current = next
    setContentState(next)
    setOriginalContent(next)
    setDiskChanged(false)
    return
  }
  if (next === contentRef.current) {
    originalContentRef.current = next
    setOriginalContent(next)
    setDiskChanged(false)
    return
  }
  if (next === originalContentRef.current || next === savingRef.current) return
  setDiskChanged(true)
}

/**
 * Single-file editor primitive. Watches a file on disk, holds a draft overlay in React state,
 * and persists on blur / debounce / unmount. Disk changes auto-reload when clean, flag
 * `diskChanged` when dirty (caller shows banner + Reload button).
 *
 * Robustness contract:
 * - onBlur flushes immediately.
 * - Background debounce fires after `debounceMs` (default 500ms) of inactivity.
 * - Unmount-flush: if dirty at cleanup, issues save IPC fire-and-forget. Main process
 *   processes the IPC regardless of renderer teardown, so side-effects survive.
 * - Strict-mode double cleanup: savingRef dedupes identical in-flight saves.
 * - relPath swap while dirty: previous file flushed before new file loads — no cross-file contamination.
 * - Saves are serialized: one issued while another is in flight runs after it.
 * - Baseline after a save = exactly what was written; keys typed meanwhile stay dirty.
 * - Reloads never overwrite a draft that is dirty (or was typed into during the read).
 * - Self-write harmless: the watcher's read matches the written content → no-op.
 */
export function useWatchedFile(options: UseWatchedFileOptions): UseWatchedFileResult {
  const { projectPath, relPath, read, save, debounceMs = 500 } = options
  const trpc = useTRPC()

  // Which machine these filesystem calls are for. Ambient for the whole
  // panel — see ./workspace-target. Spread into every input so it also
  // keys the query cache.
  const target = useWorkspaceTarget()
  const [content, setContentState] = useState('')
  const [originalContent, setOriginalContent] = useState('')
  const [diskChanged, setDiskChanged] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const contentRef = useRef(content)
  const originalContentRef = useRef(originalContent)
  const dirty = content !== originalContent
  const dirtyRef = useRef(dirty)
  useEffect(() => {
    contentRef.current = content
  })
  useEffect(() => {
    originalContentRef.current = originalContent
  })
  useEffect(() => {
    dirtyRef.current = dirty
  })

  // Track in-flight save to dedupe strict-mode double cleanup
  const savingRef = useRef<string | null>(null)

  // Stable refs for callbacks so effects can depend on [projectPath, relPath] only
  const readRef = useRef(read)
  const saveRef = useRef(save)
  useEffect(() => {
    readRef.current = read
  })
  useEffect(() => {
    saveRef.current = save
  })

  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Tail of the save queue: writes run one at a time, in issue order, so disk and
  // baseline never go backwards. performSaveImpl never rejects.
  const saveChainRef = useRef<Promise<void>>(Promise.resolve())
  // Identifies the current target; bumped by the load effect on every swap.
  const generationRef = useRef(0)

  // Core save: serialized; dedupes an identical save already in flight.
  const performSave = useCallback((target: string): Promise<void> => {
    if (savingRef.current === target) return saveChainRef.current
    const request = { target, save: saveRef.current, generation: generationRef.current }
    const run = saveChainRef.current.then(() =>
      performSaveImpl(
        {
          savingRef,
          generationRef,
          originalContentRef,
          setOriginalContent,
          setDiskChanged,
          setSaveError
        },
        request
      )
    )
    saveChainRef.current = run
    return run
  }, [])

  // Track whether the hook currently has a target — flushNow/onBlur no-op when null.
  const hasTargetRef = useRef(false)
  useEffect(() => {
    hasTargetRef.current = !!projectPath && !!relPath
  })

  const flushNow = useCallback(async (): Promise<void> => {
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current)
      debounceTimer.current = null
    }
    if (!dirtyRef.current || !hasTargetRef.current) return
    await performSave(contentRef.current)
  }, [performSave])

  const reloadDeps: ReloadDeps = {
    readRef,
    generationRef,
    contentRef,
    originalContentRef,
    savingRef,
    setContentState,
    setOriginalContent,
    setDiskChanged
  }
  const reloadFromDisk = useStableCallback((): Promise<void> => reloadImpl(reloadDeps, true))
  const reconcileWithDisk = useStableCallback((): Promise<void> => reloadImpl(reloadDeps, false))

  // No target: clear the draft state on mount / target change — adjusted during
  // render. The refs are still cleared in the load effect below (commit time, after
  // the outgoing file's cleanup flush has read them).
  const [targetSyncedFor, setTargetSyncedFor] = useState<{
    projectPath: string | null
    relPath: string | null
  } | null>(null)
  if (
    targetSyncedFor === null ||
    targetSyncedFor.projectPath !== projectPath ||
    targetSyncedFor.relPath !== relPath
  ) {
    setTargetSyncedFor({ projectPath, relPath })
    if (!projectPath || !relPath) {
      setContentState('')
      setOriginalContent('')
      setDiskChanged(false)
    }
  }

  // Load on mount / relPath change. Cleanup flushes the OUTGOING relPath.
  useEffect(() => {
    generationRef.current += 1
    if (!projectPath || !relPath) {
      contentRef.current = ''
      originalContentRef.current = ''
      return
    }

    let cancelled = false
    void (async () => {
      const next = await readRef.current()
      if (cancelled || next == null) return
      contentRef.current = next
      originalContentRef.current = next
      setContentState(next)
      setOriginalContent(next)
      setDiskChanged(false)
    })()

    // Capture closure values for cleanup — ESP for flush-before-swap
    const capturedSave = saveRef.current
    return () => {
      cancelled = true
      // Flush pending debounce synchronously into an IPC call. Fire-and-forget;
      // Electron main will process the write even if the renderer teardown
      // races us.
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current)
        debounceTimer.current = null
      }
      if (dirtyRef.current) {
        const target = contentRef.current
        if (savingRef.current !== target) {
          savingRef.current = target
          // Fire-and-forget. Do not await — cleanup must return synchronously.
          // Queued behind any save in flight so writes stay ordered.
          // A file swap (still mounted) shows the outgoing file's failure too.
          const run = saveChainRef.current
            .then(() => capturedSave(target))
            .catch((err: unknown) => setSaveError(saveErrorMessage(err)))
            .finally(() => {
              if (savingRef.current === target) savingRef.current = null
            })
          saveChainRef.current = run
        }
      }
    }
  }, [projectPath, relPath])

  // Debounce effect: schedule background save while typing. Disabled when
  // projectPath/relPath are null — no target to save to.
  useEffect(() => {
    if (!dirty || !projectPath || !relPath) return
    if (debounceTimer.current) clearTimeout(debounceTimer.current)
    debounceTimer.current = setTimeout(() => {
      debounceTimer.current = null
      void performSave(contentRef.current)
    }, debounceMs)
    return () => {
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current)
        debounceTimer.current = null
      }
    }
  }, [content, dirty, debounceMs, performSave, projectPath, relPath])

  // File watcher: dirty-aware disk-change handling. Keyed on projectPath only
  // to avoid re-subscribing on every relPath swap — relPath compared via ref.
  const relPathRef = useRef(relPath)
  useEffect(() => {
    relPathRef.current = relPath
  })

  const onWatchEvent = useStableCallback(
    (event: { type: 'changed' | 'deleted'; root: string; relPath: string }) => {
      if (event.type !== 'changed') return
      const changedRoot = event.root
      const changedRel = event.relPath
      const normalize = (p: string) => p.replace(/\/+$/, '')
      if (!projectPath || normalize(changedRoot) !== normalize(projectPath)) return
      if (changedRel !== relPathRef.current) return

      // Ignore echoes from our own in-flight save
      if (savingRef.current !== null) return

      // Read + reconcile: clean draft reloads; dirty draft keeps its buffer and is
      // flagged only when disk differs from both the draft and the last write.
      void reconcileWithDisk()
    }
  )

  const watch = useSubscription(
    trpc.fileEditor.watch.subscriptionOptions(
      { ...target, rootPath: projectPath ?? '' },
      { enabled: !!projectPath, onData: onWatchEvent }
    )
  )
  // Refused before any computer was there ("connect a computer"): start again on a connect.
  useResubscribeOnComputerConnect(watch)

  const setContent = useCallback((next: string) => {
    contentRef.current = next
    setContentState(next)
  }, [])

  const onBlur = useCallback(() => {
    void flushNow()
  }, [flushNow])

  return {
    content,
    setContent,
    dirty,
    diskChanged,
    saveError,
    reloadFromDisk,
    flushNow,
    onBlur
  }
}
