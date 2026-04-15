import { useCallback, useEffect, useRef, useState } from 'react'

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
  reloadFromDisk: () => Promise<void>
  flushNow: () => Promise<void>
  onBlur: () => void
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
 * - Self-write harmless: after save, content === originalContent, so the watcher's reload is a no-op.
 */
export function useWatchedFile(options: UseWatchedFileOptions): UseWatchedFileResult {
  const { projectPath, relPath, read, save, debounceMs = 500 } = options

  const [content, setContentState] = useState('')
  const [originalContent, setOriginalContent] = useState('')
  const [diskChanged, setDiskChanged] = useState(false)

  const contentRef = useRef(content)
  const originalContentRef = useRef(originalContent)
  const dirty = content !== originalContent
  const dirtyRef = useRef(dirty)
  contentRef.current = content
  originalContentRef.current = originalContent
  dirtyRef.current = dirty

  // Track in-flight save to dedupe strict-mode double cleanup
  const savingRef = useRef<string | null>(null)

  // Stable refs for callbacks so effects can depend on [projectPath, relPath] only
  const readRef = useRef(read)
  const saveRef = useRef(save)
  readRef.current = read
  saveRef.current = save

  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Core save: idempotent, dedupes via savingRef
  const performSave = useCallback(async (target: string): Promise<void> => {
    if (savingRef.current === target) return
    savingRef.current = target
    try {
      await saveRef.current(target)
      // Only update baseline if no newer edits happened during the save
      if (contentRef.current === target) {
        originalContentRef.current = target
        setOriginalContent(target)
        setDiskChanged(false)
      }
    } finally {
      if (savingRef.current === target) {
        savingRef.current = null
      }
    }
  }, [])

  // Track whether the hook currently has a target — flushNow/onBlur no-op when null.
  const hasTargetRef = useRef(false)
  hasTargetRef.current = !!projectPath && !!relPath

  const flushNow = useCallback(async (): Promise<void> => {
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current)
      debounceTimer.current = null
    }
    if (!dirtyRef.current || !hasTargetRef.current) return
    await performSave(contentRef.current)
  }, [performSave])

  const reloadFromDisk = useCallback(async (): Promise<void> => {
    const next = await readRef.current()
    if (next == null) return
    contentRef.current = next
    originalContentRef.current = next
    setContentState(next)
    setOriginalContent(next)
    setDiskChanged(false)
  }, [])

  // Load on mount / relPath change. Cleanup flushes the OUTGOING relPath.
  useEffect(() => {
    if (!projectPath || !relPath) {
      setContentState('')
      setOriginalContent('')
      setDiskChanged(false)
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
          void capturedSave(target).finally(() => {
            if (savingRef.current === target) savingRef.current = null
          })
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
  relPathRef.current = relPath

  useEffect(() => {
    if (!projectPath) return

    void window.api.fs.watch(projectPath)
    const unsubscribe = window.api.fs.onFileChanged((changedRoot, changedRel) => {
      const normalize = (p: string) => p.replace(/\/+$/, '')
      if (normalize(changedRoot) !== normalize(projectPath)) return
      if (changedRel !== relPathRef.current) return

      // Ignore echoes from our own in-flight save
      if (savingRef.current !== null) return

      if (dirtyRef.current) {
        setDiskChanged(true)
        return
      }
      void reloadFromDisk()
    })

    return () => {
      unsubscribe()
      void window.api.fs.unwatch(projectPath)
    }
  }, [projectPath, reloadFromDisk])

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
    reloadFromDisk,
    flushNow,
    onBlur,
  }
}
