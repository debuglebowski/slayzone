import { useEffect, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { electronBootstrap } from '@slayzone/transport/client'
import {
  appBadgeProjectKey,
  computeAppBadge,
  parseAppBadgeSettings,
  type AppBadgeTask
} from '@slayzone/settings'
import type { Task } from '@slayzone/task-contracts'
import type { IdleTask } from '@slayzone/agent-panels'
import { useTRPC } from '../trpc'

const IS_WINDOWS = typeof navigator !== 'undefined' && /Windows/.test(navigator.userAgent)
// Badge fill — a notification red, deliberately not a theme token: it sits on the
// OS taskbar icon, outside the app's themed surfaces.
const OVERLAY_FILL = '#e5484d'

/** Windows overlay icons are images: draw the badge text on a red disc. */
function drawOverlay(text: string): string | null {
  const size = 32
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.fillStyle = OVERLAY_FILL
  ctx.beginPath()
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2)
  ctx.fill()
  if (text !== '•') {
    ctx.fillStyle = '#fff'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    const fontSize = text.length <= 1 ? 22 : text.length === 2 ? 18 : 12
    ctx.font = `bold ${fontSize}px system-ui, sans-serif`
    ctx.fillText(text, size / 2, size / 2 + 1, size - 4)
  }
  return canvas.toDataURL('image/png')
}

/**
 * Drives the app icon badge (dock / taskbar) from the "App icon badge" settings:
 * unread tasks (amber dot) and idle agents (the bell's list, after dismissals).
 * Main window only — App.tsx is its sole caller.
 */
export function useAppBadge({
  tasks,
  idleTasks,
  hubIdByProject,
  defaultHubId
}: {
  tasks: Task[]
  idleTasks: IdleTask[]
  hubIdByProject: Map<string, string>
  defaultHubId: string
}): void {
  const trpc = useTRPC()
  const all = useQuery(trpc.settings.getAll.queryOptions()).data

  const badge = useMemo(() => {
    const settings = parseAppBadgeSettings(all ?? {})
    if (settings.sources.length === 0) return { text: '', count: 0 }
    const toBadgeTask = (task: Task): AppBadgeTask => ({
      taskId: task.id,
      projectKey: appBadgeProjectKey(
        hubIdByProject.get(task.project_id) ?? defaultHubId,
        task.project_id
      )
    })
    return computeAppBadge(settings, {
      unread: tasks.filter((t) => t.needs_attention).map(toBadgeTask),
      idle: idleTasks.map((t) => toBadgeTask(t.task))
    })
  }, [all, tasks, idleTasks, hubIdByProject, defaultHubId])

  const { text, count } = badge
  useEffect(() => {
    const overlayPng = IS_WINDOWS && text ? drawOverlay(text) : null
    void electronBootstrap.setAppBadge({ text, count, overlayPng })
  }, [text, count])
}
