import { useEffect, useRef, useState } from 'react'
import type { Task } from '@slayzone/task/shared'

/**
 * Continuous-flow per-file collapse set, persisted per task. Distinct from the
 * sidebar folder-tree expansion in useGitDiffFolders.
 */
export function useGitDiffCollapse(task: Task | null) {
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(
    () => new Set(task?.diff_collapsed_files ?? [])
  )
  // Reset when switching tasks so we don't carry one task's collapsed set into another.
  const lastLoadedTaskIdRef = useRef<string | null>(task?.id ?? null)
  useEffect(() => {
    if (task?.id !== lastLoadedTaskIdRef.current) {
      lastLoadedTaskIdRef.current = task?.id ?? null
      setCollapsedFiles(new Set(task?.diff_collapsed_files ?? []))
    }
  }, [task?.id, task?.diff_collapsed_files])
  // Persist on change, debounced. Skip first render so we don't overwrite the
  // freshly-loaded value with itself.
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const didMountSaveRef = useRef(false)
  useEffect(() => {
    if (!task?.id) return
    if (!didMountSaveRef.current) {
      didMountSaveRef.current = true
      return
    }
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    const taskId = task.id
    const arr = [...collapsedFiles]
    saveTimerRef.current = setTimeout(() => {
      void window.api.db.updateTask({ id: taskId, diffCollapsedFiles: arr })
    }, 400)
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    }
  }, [collapsedFiles, task?.id])

  return { collapsedFiles, setCollapsedFiles }
}
