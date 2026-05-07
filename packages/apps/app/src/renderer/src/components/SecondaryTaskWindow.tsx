import { useEffect, useState, useCallback } from 'react'
import { getTrpcVanillaClient } from '@slayzone/transport/client'
import { Pin } from 'lucide-react'
import type { Task, PanelVisibility } from '@slayzone/task/shared'
import { TaskDetailPage } from '@slayzone/task/client/TaskDetailPage'
import { TaskShell } from '@slayzone/task/client/TaskShell'
import { fetchTaskDetail, type TaskDetailData } from '@slayzone/task/client/taskDetailCache'
import { Tooltip, TooltipTrigger, TooltipContent, cn } from '@slayzone/ui'
import { BoostPill } from '@/components/usage/BoostPill'
import { UsagePopover } from '@/components/usage/UsagePopover'
import { useUsage } from '@/components/usage/useUsage'

interface Props {
  taskId: string
}

const DEFAULT_PANEL_VIS: PanelVisibility = {
  terminal: false, browser: false, diff: false, settings: false, editor: false, artifacts: false, processes: false,
}

export function SecondaryTaskWindow({ taskId: initialTaskId }: Props) {
  const [taskId, setTaskId] = useState(initialTaskId)
  const [data, setData] = useState<TaskDetailData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [followPrimary, setFollowPrimary] = useState(false)
  const [panelVis, setPanelVis] = useState<PanelVisibility>(DEFAULT_PANEL_VIS)
  const { data: usageData, refresh: refreshUsage } = useUsage()

  useEffect(() => {
    if (!followPrimary) return
    let alive = true
    window.api.taskWindow.getPrimaryActive().then((id) => {
      if (alive && id && id !== taskId) setTaskId(id)
    })
    const unsub = window.api.taskWindow.onPrimaryActiveChanged((id) => {
      if (id) setTaskId(id)
    })
    return () => { alive = false; unsub() }
  }, [followPrimary]) // eslint-disable-line react-hooks/exhaustive-deps

  const loadTask = useCallback(async () => {
    try {
      const detail = await fetchTaskDetail(taskId)
      if (!detail) { setError(`Task not found: ${taskId}`); return }
      setError(null)
      setData(detail)
      document.title = `${detail.task.title} — SlayZone`
    } catch (e) {
      setError(String(e))
    }
  }, [taskId])

  useEffect(() => { loadTask() }, [loadTask])

  const handleTaskUpdated = useCallback((updated: Task) => {
    setData((prev) => prev ? { ...prev, task: updated } : prev)
    if (updated.title) document.title = `${updated.title} — SlayZone`
  }, [])

  const handleClose = useCallback(() => {
    window.api.window.close()
  }, [])

  const project = data?.project ?? null

  if (error) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-background text-destructive p-4">
        {error}
      </div>
    )
  }

  if (!data) {
    return (
      <div className="h-screen w-screen bg-background">
        <TaskShell />
      </div>
    )
  }

  const initialDataForPage: TaskDetailData = { ...data, panelVisibility: panelVis }

  return (
    <div className="h-screen w-screen bg-background text-foreground flex flex-col overflow-hidden">
      <div className="h-10 shrink-0 [-webkit-app-region:drag] flex items-center justify-between pl-22 pr-3 gap-2">
        <div className="flex items-center gap-1 [-webkit-app-region:no-drag]">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => setFollowPrimary((v) => !v)}
                className={cn(
                  'shrink-0 flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-colors',
                  followPrimary
                    ? 'bg-primary/15 text-foreground'
                    : 'bg-muted/50 hover:bg-muted text-muted-foreground hover:text-foreground'
                )}
              >
                <Pin className={cn('size-3.5', followPrimary && 'fill-current')} />
                Follow current tab
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {followPrimary
                ? 'This window swaps to whatever task is active in the main window.'
                : 'Click to make this window track the main window’s active tab.'}
            </TooltipContent>
          </Tooltip>
        </div>
        <div className="flex items-center gap-1 [-webkit-app-region:no-drag]">
          <BoostPill />
          <div className="w-4" />
          <UsagePopover data={usageData} onRefresh={refreshUsage} />
        </div>
      </div>
      <div className="flex-1 min-h-0 flex">
        <div id="main-area" className="flex-1 min-w-0 min-h-0 rounded-lg bg-surface-0 flex overflow-hidden p-4 mx-2 mb-2">
          <div className="flex-1 min-w-0 min-h-0 rounded-lg overflow-hidden relative">
            <div className="h-full">
              <TaskDetailPage
                key={taskId}
                taskId={taskId}
                task={data.task}
                project={project}
                isActive={true}
                hasShortcutFocus={true}
                onBack={handleClose}
                onTaskUpdated={handleTaskUpdated}
                onArchiveTask={async (id) => {
                  await getTrpcVanillaClient().task.archive.mutate({ id: id })
                  handleClose()
                }}
                onDeleteTask={async (id) => {
                  await getTrpcVanillaClient().task.delete.mutate({ id: id })
                  handleClose()
                }}
                onNavigateToTask={(id) => { window.api.taskWindow.open(id) }}
                onCloseTab={handleClose}
                initialData={initialDataForPage}
                isSidePanelResizing={false}
                isSecondaryWindow
                onPanelVisibilityChange={setPanelVis}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
