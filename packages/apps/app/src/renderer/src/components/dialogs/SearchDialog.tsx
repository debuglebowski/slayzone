import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Command, CommandInput, CommandList, Dialog, DialogContent, cn } from '@slayzone/ui'
import { track } from '@slayzone/telemetry/client'
import { useDialogStore } from '@slayzone/settings'
import type { ActionId, FilterKind, SearchDialogProps, TaskTab } from './SearchDialog.types'
import { FILTERS, MAX_RECENT } from './SearchDialog.constants'
import { buildSearchItems, createFzf, groupResults, rankResults } from './SearchDialog.algorithm'
import { SearchResults } from './SearchResults'

export function SearchDialog({
  open,
  onOpenChange,
  tasks,
  projects,
  closedTabs,
  openTaskTabs,
  activeTaskId,
  onSelectTask,
  onSelectProject,
  onNewTask,
  onNewTemporaryTask,
  onReopenClosedTab,
  onAddProject,
  onGoHome,
  onToggleGlobalAgentPanel,
  onOpenChangelog,
  onOpenSettings
}: SearchDialogProps) {
  const fileContext = useDialogStore((s) => s.searchFileContext)
  const [allFiles, setAllFiles] = useState<string[]>([])
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<FilterKind>('all')
  const cacheRef = useRef<{ path: string; files: string[] } | null>(null)

  useEffect(() => {
    if (!open || !fileContext) {
      setAllFiles([])
      return
    }
    const path = fileContext.projectPath
    if (cacheRef.current?.path === path) {
      setAllFiles(cacheRef.current.files)
      return
    }
    window.api.fs.listAllFiles(path).then((list) => {
      cacheRef.current = { path, files: list }
      setAllFiles(list)
    })
  }, [open, fileContext])

  useEffect(() => {
    if (open) {
      setSearch('')
      setFilter('all')
    }
  }, [open])

  const items = useMemo(
    () => buildSearchItems({ filter, fileContext, allFiles, tasks, projects }),
    [allFiles, tasks, projects, filter, fileContext]
  )

  const { fzfLabel, fzfPath } = useMemo(() => createFzf(items), [items])

  const results = useMemo(
    () => rankResults(fzfLabel, fzfPath, search),
    [fzfLabel, fzfPath, search]
  )

  const groupedResults = useMemo(() => groupResults(results), [results])

  const recentItems = useMemo(() => {
    const taskMap = new Map(tasks.map((t) => [t.id, t]))
    const seen = new Set<string>()
    const out: { tab: TaskTab; projectName: string; updatedAt: string }[] = []
    const push = (tab: TaskTab) => {
      if (out.length >= MAX_RECENT) return
      if (seen.has(tab.taskId)) return
      if (tab.taskId === activeTaskId) return
      const task = taskMap.get(tab.taskId)
      if (!task) return
      seen.add(tab.taskId)
      const projectName = projects.find((p) => p.id === task.project_id)?.name ?? ''
      out.push({ tab, projectName, updatedAt: task.updated_at })
    }
    for (let i = closedTabs.length - 1; i >= 0; i--) push(closedTabs[i])
    for (const tab of openTaskTabs) {
      if (tab.isTemporary) continue
      push(tab)
    }
    return out
  }, [closedTabs, openTaskTabs, activeTaskId, tasks, projects])

  const isSearching = search.trim().length > 0

  const firstValue = useMemo(() => {
    if (!isSearching) return 'action:new-task'
    const r = results[0]
    if (!r) return ''
    return r.item.kind === 'file' ? r.item.id : `${r.item.kind}:${r.item.id}`
  }, [isSearching, results])

  const [selected, setSelected] = useState('')
  const [prevFirstValue, setPrevFirstValue] = useState('')

  if (firstValue !== prevFirstValue) {
    setPrevFirstValue(firstValue)
    setSelected(firstValue)
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab' || !isSearching) return
    e.preventDefault()
    const idx = FILTERS.findIndex((f) => f.id === filter)
    const delta = e.shiftKey ? -1 : 1
    const next = FILTERS[(idx + delta + FILTERS.length) % FILTERS.length]
    setFilter(next.id)
  }

  const runAction = (fn: () => void) => {
    onOpenChange(false)
    fn()
  }

  const handlerFor = (id: ActionId): (() => void) => {
    switch (id) {
      case 'new-task':
        return () => runAction(onNewTask)
      case 'new-temp-task':
        return () => runAction(onNewTemporaryTask)
      case 'reopen-closed-tab':
        return () => runAction(onReopenClosedTab)
      case 'add-project':
        return () => runAction(onAddProject)
      case 'go-home':
        return () => runAction(onGoHome)
      case 'toggle-global-agent-panel':
        return () => runAction(onToggleGlobalAgentPanel)
      case 'open-changelog':
        return () => runAction(onOpenChangelog)
      case 'open-settings':
        return () => runAction(onOpenSettings)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="overflow-hidden p-0 max-w-2xl !bg-surface-0 !rounded-3xl !border-0 shadow-2xl"
        showCloseButton={false}
      >
        <Command
          shouldFilter={false}
          value={selected}
          onValueChange={setSelected}
          onKeyDown={handleKeyDown}
          className="bg-transparent [&_[cmdk-input-wrapper]]:border-b-0 [&_[cmdk-input-wrapper]_svg]:h-5 [&_[cmdk-input-wrapper]_svg]:w-5 [&_[cmdk-input]]:h-16 [&_[cmdk-input]]:text-base [&_[cmdk-item]]:rounded-xl [&_[cmdk-item]]:px-3 [&_[cmdk-item]]:py-2.5 [&_[cmdk-item]_svg]:h-5 [&_[cmdk-item]_svg]:w-5 [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground"
        >
          <CommandInput
            placeholder="Search files, folders, commands, projects, and tasks..."
            value={search}
            onValueChange={setSearch}
          />
          <div className="bg-card rounded-t-3xl">
            {isSearching && (
              <div className="flex items-center gap-1 px-2 py-1.5">
                {FILTERS.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    tabIndex={-1}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => setFilter(f.id)}
                    className={cn(
                      'rounded-md px-2 py-1 text-xs transition-colors',
                      filter === f.id
                        ? 'bg-accent text-accent-foreground'
                        : 'text-muted-foreground hover:text-foreground hover:bg-accent/40'
                    )}
                  >
                    {f.label}
                  </button>
                ))}
                <span className="ml-auto text-[10px] text-muted-foreground/70">Tab to switch</span>
              </div>
            )}
            <CommandList className="max-h-[480px]">
              <SearchResults
                isSearching={isSearching}
                groups={groupedResults}
                recentItems={recentItems}
                onRunAction={(id) => handlerFor(id)()}
                onSelectFile={(filePath) => {
                  track('quick_open_used')
                  fileContext?.openFile(filePath)
                  onOpenChange(false)
                }}
                onSelectTask={(taskId) => {
                  onSelectTask(taskId)
                  onOpenChange(false)
                }}
                onSelectProject={(projectId) => {
                  onSelectProject(projectId)
                  onOpenChange(false)
                }}
              />
            </CommandList>
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  )
}
