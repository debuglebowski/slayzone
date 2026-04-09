import { useEffect, useMemo, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle
} from '@slayzone/ui'
import { Input } from '@slayzone/ui'
import type { Task } from '@slayzone/task/shared'
import type { Project } from '@slayzone/projects/shared'
import { isTerminalStatus } from '@slayzone/projects/shared'
import { SearchIcon } from 'lucide-react'
import { BlockerStatusIcon } from '@slayzone/task/client'

interface BlockerDialogProps {
  taskId: string | null
  projects?: Project[]
  onClose: () => void
}

export function BlockerDialog({ taskId, projects, onClose }: BlockerDialogProps): React.JSX.Element {
  const [allTasks, setAllTasks] = useState<Task[]>([])
  const [blockers, setBlockers] = useState<Task[]>([])
  const [search, setSearch] = useState('')

  const columnsByProject = useMemo(
    () => new Map((projects ?? []).map((p) => [p.id, p.columns_config])),
    [projects]
  )

  const open = taskId !== null

  useEffect(() => {
    if (!open || !taskId) return
    Promise.all([
      window.api.db.getTasks(),
      window.api.taskDependencies.getBlockers(taskId)
    ]).then(([tasks, currentBlockers]) => {
      setAllTasks(tasks.filter((t) => t.id !== taskId))
      setBlockers(currentBlockers)
      setSearch('')
    })
  }, [open, taskId])

  const handleAddBlocker = async (blockerTaskId: string): Promise<void> => {
    if (!taskId) return
    await window.api.taskDependencies.addBlocker(taskId, blockerTaskId)
    onClose()
    window.dispatchEvent(new CustomEvent('slayzone:blocked-changed'))
  }

  const availableBlockers = allTasks.filter(
    (t) => !isTerminalStatus(t.status, columnsByProject.get(t.project_id)) && !blockers.some((b) => b.id === t.id)
  )
  const filteredAvailableBlockers = availableBlockers.filter((t) => {
    const q = search.trim().toLowerCase()
    return !q || t.title.toLowerCase().includes(q)
  })

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) { onClose(); setSearch('') } }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Add blocking task</DialogTitle>
        </DialogHeader>
        {availableBlockers.length === 0 && !search ? (
          <p className="text-sm text-muted-foreground">No tasks available</p>
        ) : (
          <div className="space-y-2">
            <div className="relative">
              <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                aria-label="Search available blockers"
                placeholder="Search tasks..."
                className="h-8 pl-8 text-sm"
              />
            </div>
            {filteredAvailableBlockers.length === 0 ? (
              <p className="text-sm text-muted-foreground">No tasks match your search</p>
            ) : (
              <div className="max-h-[200px] space-y-1 overflow-y-auto">
                {filteredAvailableBlockers.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => handleAddBlocker(t.id)}
                    className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-muted"
                  >
                    <BlockerStatusIcon task={t} columns={columnsByProject.get(t.project_id)} />
                    <span className="line-clamp-1 flex-1">{t.title}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
