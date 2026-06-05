import { useState, useEffect, useCallback, useRef } from 'react'
import { useStablePoll } from '@slayzone/ui'
import type { Task, UpdateTaskInput } from '@slayzone/task/shared'
import type { GhPullRequest } from '../shared/types'

export function usePullRequestTab({
  task,
  projectPath,
  visible,
  onUpdateTask,
  onTaskUpdated
}: {
  task: Task
  projectPath: string | null
  visible: boolean
  onUpdateTask: (data: UpdateTaskInput) => Promise<Task>
  onTaskUpdated: (task: Task) => void
}) {
  const [ghInstalled, setGhInstalled] = useState<boolean | null>(null)
  const [pr, setPr] = useState<GhPullRequest | null>(null)
  const [loading, setLoading] = useState(true)
  const [createOpen, setCreateOpen] = useState(false)
  const [linkOpen, setLinkOpen] = useState(false)

  const [error, setError] = useState<string | null>(null)

  // Check gh + fetch PR if linked
  useEffect(() => {
    if (!visible || !projectPath) return
    let cancelled = false
    ;(async () => {
      try {
        const installed = await window.api.git.checkGhInstalled()
        if (cancelled) return
        setGhInstalled(installed)
        if (!installed) {
          setLoading(false)
          return
        }

        if (task.pr_url) {
          const data = await window.api.git.getPrByUrl(projectPath, task.pr_url)
          if (!cancelled) setPr(data)
        }
      } catch {
        /* ignore */
      }
      if (!cancelled) setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [visible, projectPath, task.pr_url])

  const lastPrHashRef = useRef<string>('')

  // Single refresh function — used by poll, refresh button, and post-merge
  const refreshPr = useCallback(async () => {
    if (!projectPath || !task.pr_url) return null
    try {
      const data = await window.api.git.getPrByUrl(projectPath, task.pr_url)
      const hash = JSON.stringify(data)
      if (hash !== lastPrHashRef.current) {
        lastPrHashRef.current = hash
        if (data) setPr(data)
      }
      return hash
    } catch {
      return null
    }
  }, [projectPath, task.pr_url])

  // Poll PR status when linked (faster when checks are pending)
  const prPollMs = pr?.statusCheckRollup === 'PENDING' ? 10000 : 30000
  useStablePoll(refreshPr, {
    enabled: visible && !!projectPath && !!task.pr_url && !!ghInstalled,
    baseDelayMs: prPollMs
  })

  const handleUnlink = useCallback(async () => {
    const updated = await onUpdateTask({ id: task.id, prUrl: null })
    onTaskUpdated(updated)
    setPr(null)
  }, [task.id, onUpdateTask, onTaskUpdated])

  const handleLinkPr = useCallback(
    async (url: string) => {
      setError(null)
      try {
        const updated = await onUpdateTask({ id: task.id, prUrl: url })
        onTaskUpdated(updated)
        if (projectPath) {
          const data = await window.api.git.getPrByUrl(projectPath, url)
          setPr(data)
        }
        setLinkOpen(false)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    },
    [task.id, projectPath, onUpdateTask, onTaskUpdated]
  )

  const handleCreated = useCallback(
    async (url: string) => {
      const updated = await onUpdateTask({ id: task.id, prUrl: url })
      onTaskUpdated(updated)
      if (projectPath) {
        const data = await window.api.git.getPrByUrl(projectPath, url)
        setPr(data)
      }
      setCreateOpen(false)
    },
    [task.id, projectPath, onUpdateTask, onTaskUpdated]
  )

  return {
    ghInstalled,
    pr,
    loading,
    createOpen,
    setCreateOpen,
    linkOpen,
    setLinkOpen,
    error,
    refreshPr,
    handleUnlink,
    handleLinkPr,
    handleCreated
  }
}
