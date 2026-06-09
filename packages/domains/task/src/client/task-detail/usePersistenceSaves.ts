import React, { useRef, useCallback, useEffect } from 'react'
import { useTRPCClient } from '@slayzone/transport/client'
import type { Task } from '@slayzone/task/shared'
import type { EditorOpenFilesState } from '@slayzone/file-editor/shared'

export interface UsePersistenceSavesResult {
  /** Live cache of web-panel URLs; callers (e.g. applyTemplate) may overwrite `.current` directly. */
  webPanelUrlsRef: React.RefObject<Record<string, string>>
  handleActiveArtifactIdChange: (id: string | null) => void
  handleWebPanelUrlChange: (panelId: string, url: string) => void
  handleEditorStateChange: (state: EditorOpenFilesState) => void
  handleWebPanelFaviconChange: (panelId: string, favicon: string) => void
}

/**
 * Debounced, ref-based persistence of web-panel URLs, editor open-files, and the
 * active artifact id. Flushes pending saves on task switch and unmount.
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

  // Active artifact persistence — debounced, ref-based
  const activeArtifactIdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flushPendingActiveArtifactSave = useCallback(() => {
    if (activeArtifactIdTimerRef.current) {
      clearTimeout(activeArtifactIdTimerRef.current)
      activeArtifactIdTimerRef.current = null
    }
  }, [])

  const handleActiveArtifactIdChange = useCallback(
    (id: string | null) => {
      if (activeArtifactIdTimerRef.current) clearTimeout(activeArtifactIdTimerRef.current)
      const taskId = taskIdRef.current
      activeArtifactIdTimerRef.current = setTimeout(async () => {
        if (!taskId) return
        await trpcClient.task.update.mutate({ id: taskId, activeArtifactId: id })
      }, 500)
    },
    [trpcClient]
  )

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

  // Initialize from task on load — flush old task's pending saves first
  useEffect(() => {
    flushPendingUrlSave()
    flushPendingEditorSave()
    flushPendingActiveArtifactSave()
    taskIdRef.current = task?.id ?? null
    if (task?.web_panel_urls) webPanelUrlsRef.current = { ...task.web_panel_urls }
    else webPanelUrlsRef.current = {}
  }, [task?.id, flushPendingUrlSave, flushPendingEditorSave, flushPendingActiveArtifactSave])

  // Flush pending saves on unmount
  useEffect(() => {
    return () => {
      flushPendingUrlSave()
      flushPendingEditorSave()
      flushPendingActiveArtifactSave()
    }
  }, [flushPendingUrlSave, flushPendingEditorSave])

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
    handleWebPanelUrlChange,
    handleEditorStateChange,
    handleWebPanelFaviconChange
  }
}
