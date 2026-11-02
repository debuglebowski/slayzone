import React, { useRef, useCallback, useEffect, useEffectEvent } from 'react'
import { useTRPCClient } from '../trpc'
import type { ArtifactsSidebarState, Task } from '@slayzone/task-contracts'
import type { EditorOpenFilesState } from '@slayzone/file-editor/shared'

export interface UsePersistenceSavesResult {
  /** Live cache of web-panel URLs; callers (e.g. applyTemplate) may overwrite `.current` directly. */
  webPanelUrlsRef: React.RefObject<Record<string, string>>
  handleActiveArtifactIdChange: (id: string | null) => void
  handleArtifactsSidebarChange: (state: ArtifactsSidebarState) => void
  handleWebPanelUrlChange: (panelId: string, url: string) => void
  handleEditorStateChange: (state: EditorOpenFilesState) => void
  handleWebPanelFaviconChange: (panelId: string, favicon: string) => void
}

/**
 * A debounced save bound to the task it was made in: `schedule` (re)starts a 500 ms
 * timer; `flush` (task switch, unmount) sends the pending value to its own task now.
 */
function useTaskBoundSave<T>(
  taskIdRef: React.RefObject<string | null>,
  send: (taskId: string, value: T) => void
): { schedule: (value: T) => void; flush: () => void } {
  const pendingRef = useRef<{
    taskId: string
    value: T
    timer: ReturnType<typeof setTimeout>
  } | null>(null)

  const flush = useCallback(() => {
    const pending = pendingRef.current
    if (!pending) return
    pendingRef.current = null
    clearTimeout(pending.timer)
    send(pending.taskId, pending.value)
  }, [send])

  const schedule = useCallback(
    (value: T) => {
      const previous = pendingRef.current
      if (previous) clearTimeout(previous.timer)
      pendingRef.current = null
      const taskId = taskIdRef.current
      if (!taskId) return
      pendingRef.current = { taskId, value, timer: setTimeout(flush, 500) }
    },
    [taskIdRef, flush]
  )

  return { schedule, flush }
}

/**
 * Debounced, ref-based persistence of web-panel URLs, editor open-files, the
 * active artifact id, and the artifacts sidebar. Flushes pending saves on task
 * switch and unmount.
 */
export function usePersistenceSaves(task: Task | null): UsePersistenceSavesResult {
  const trpcClient = useTRPCClient()
  // Web panel URL persistence — use ref to avoid stale closures
  const webPanelUrlsRef = useRef<Record<string, string>>({})
  const webPanelUrlTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const taskIdRef = useRef<string | null>(null)

  // Flush any pending URL save (fire-and-forget)
  const flushPendingUrlSave = useCallback(() => {
    if (webPanelUrlTimerRef.current) {
      clearTimeout(webPanelUrlTimerRef.current)
      webPanelUrlTimerRef.current = null
      if (taskIdRef.current && Object.keys(webPanelUrlsRef.current).length > 0) {
        void trpcClient.task.update.mutate({
          id: taskIdRef.current,
          webPanelUrls: { ...webPanelUrlsRef.current }
        })
      }
    }
  }, [trpcClient])

  // Active artifact + artifacts sidebar persistence — debounced; a pending save keeps
  // the task it was made in: a flush (task switch, unmount) sends it there, now.
  const sendActiveArtifact = useCallback(
    (id: string, activeArtifactId: string | null) =>
      void trpcClient.task.update.mutate({ id, activeArtifactId }),
    [trpcClient]
  )
  const { schedule: handleActiveArtifactIdChange, flush: flushPendingActiveArtifactSave } =
    useTaskBoundSave(taskIdRef, sendActiveArtifact)

  const sendArtifactsSidebar = useCallback(
    (id: string, artifactsSidebar: ArtifactsSidebarState) =>
      void trpcClient.task.update.mutate({ id, artifactsSidebar }),
    [trpcClient]
  )
  const { schedule: handleArtifactsSidebarChange, flush: flushPendingArtifactsSidebarSave } =
    useTaskBoundSave(taskIdRef, sendArtifactsSidebar)

  // Editor open files persistence — debounced, ref-based (same pattern as webPanelUrls)
  const editorStateRef = useRef<EditorOpenFilesState | null>(null)
  const editorStateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flushPendingEditorSave = useCallback(() => {
    if (editorStateTimerRef.current) {
      clearTimeout(editorStateTimerRef.current)
      editorStateTimerRef.current = null
      if (taskIdRef.current && editorStateRef.current) {
        void trpcClient.task.update.mutate({
          id: taskIdRef.current,
          editorOpenFiles: editorStateRef.current
        })
      }
    }
  }, [trpcClient])

  // Seed the url cache from the task as of a task switch. An Effect Event: a
  // later web_panel_urls change (our own save echoing back) must not re-seed.
  const seedWebPanelUrls = useEffectEvent((): void => {
    if (task?.web_panel_urls) webPanelUrlsRef.current = { ...task.web_panel_urls }
    else webPanelUrlsRef.current = {}
  })

  // Initialize from task on load — flush old task's pending saves first
  const taskId = task?.id ?? null
  useEffect(() => {
    flushPendingUrlSave()
    flushPendingEditorSave()
    flushPendingActiveArtifactSave()
    flushPendingArtifactsSidebarSave()
    taskIdRef.current = taskId
    seedWebPanelUrls()
  }, [
    taskId,
    flushPendingUrlSave,
    flushPendingEditorSave,
    flushPendingActiveArtifactSave,
    flushPendingArtifactsSidebarSave
  ])

  // Flush pending saves on unmount
  useEffect(() => {
    return () => {
      flushPendingUrlSave()
      flushPendingEditorSave()
      flushPendingActiveArtifactSave()
      flushPendingArtifactsSidebarSave()
    }
  }, [
    flushPendingUrlSave,
    flushPendingEditorSave,
    flushPendingActiveArtifactSave,
    flushPendingArtifactsSidebarSave
  ])

  const handleWebPanelUrlChange = useCallback(
    (panelId: string, url: string) => {
      if (!taskIdRef.current) return
      webPanelUrlsRef.current = { ...webPanelUrlsRef.current, [panelId]: url }
      if (webPanelUrlTimerRef.current) clearTimeout(webPanelUrlTimerRef.current)
      const id = taskIdRef.current
      const urlSnapshot = { ...webPanelUrlsRef.current }
      webPanelUrlTimerRef.current = setTimeout(async () => {
        await trpcClient.task.update.mutate({
          id,
          webPanelUrls: urlSnapshot
        })
      }, 500)
    },
    [trpcClient]
  )

  const handleEditorStateChange = useCallback(
    (state: EditorOpenFilesState) => {
      editorStateRef.current = state
      if (editorStateTimerRef.current) clearTimeout(editorStateTimerRef.current)
      const id = taskIdRef.current
      editorStateTimerRef.current = setTimeout(async () => {
        if (!id) return
        await trpcClient.task.update.mutate({
          id,
          editorOpenFiles: state
        })
      }, 500)
    },
    [trpcClient]
  )

  // Handle web panel favicon change
  const handleWebPanelFaviconChange = useCallback((_panelId: string, _favicon: string) => {
    // Favicon caching — no-op for now, auto-fetched by webview on each load
  }, [])

  return {
    webPanelUrlsRef,
    handleActiveArtifactIdChange,
    handleArtifactsSidebarChange,
    handleWebPanelUrlChange,
    handleEditorStateChange,
    handleWebPanelFaviconChange
  }
}
