import { useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTRPC } from '@slayzone/transport/client'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
  Dialog,
  DialogContent,
  cn,
  PriorityIcon,
  getTaskStatusStyle,
  useShortcutDisplay
} from '@slayzone/ui'
import {
  CheckSquare,
  Folder,
  FolderPlus,
  History,
  Home,
  Megaphone,
  PanelRight,
  Settings,
  SquarePen,
  Zap,
  type LucideIcon
} from 'lucide-react'
import { Fzf } from 'fzf'
import { FileIcon } from '@slayzone/icons'
import { track } from '@slayzone/telemetry/client'
import { useDialogStore, type Tab } from '@slayzone/settings'
import { type Task, priorityOptions } from '@slayzone/task/shared'
import type { Project } from '@slayzone/projects/shared'

const MAX_RESULTS = 50
const MAX_RECENT = 4

type FilterKind = 'all' | 'actions' | 'files' | 'tasks' | 'projects'
const FILTERS: { id: FilterKind; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'actions', label: 'Actions' },
  { id: 'files', label: 'Files' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'projects', label: 'Projects' }
]

type TaskTab = Extract<Tab, { type: 'task' }>

type ActionId =
  | 'new-task'
  | 'new-temp-task'
  | 'reopen-closed-tab'
  | 'add-project'
  | 'go-home'
  | 'toggle-global-agent-panel'
  | 'open-changelog'
  | 'open-settings'

type SearchItem =
  | { kind: 'action'; id: ActionId; label: string; sublabel: string; shortcutId?: string }
  | { kind: 'file'; id: string; label: string; sublabel: string; filePath: string }
  | { kind: 'task'; id: string; label: string; sublabel: string; status: string; priority: number }
  | { kind: 'project'; id: string; label: string; sublabel: string }

const KIND_WEIGHT: Record<SearchItem['kind'], number> = {
  action: 1.05,
  file: 1.0,
  task: 0.95,
  project: 0.9
}

const BASENAME_BOOST = 1.5

const ACTION_DEFS: { id: ActionId; label: string; sublabel: string; shortcutId?: string; featured?: boolean }[] = [
  { id: 'new-task', label: 'New task', sublabel: 'Create a task', shortcutId: 'new-task', featured: true },
  { id: 'new-temp-task', label: 'New temporary task', sublabel: 'Open a scratch terminal', shortcutId: 'new-temp-task', featured: true },
  { id: 'reopen-closed-tab', label: 'Reopen last closed tab', sublabel: 'Restore the most recently closed task', shortcutId: 'reopen-closed-tab', featured: true },
  { id: 'add-project', label: 'Add project', sublabel: 'Add a project folder' },
  { id: 'go-home', label: 'Go to home', sublabel: 'Switch to the home tab', shortcutId: 'go-home' },
  { id: 'toggle-global-agent-panel', label: 'Toggle global agent panel', sublabel: 'Show or hide the global agent side panel', shortcutId: 'global-agent-panel' },
  { id: 'open-changelog', label: 'Open changelog', sublabel: "What's new in SlayZone" },
  { id: 'open-settings', label: 'Open settings', sublabel: 'App settings', shortcutId: 'global-settings', featured: true }
]

const ACTION_ICONS: Record<ActionId, LucideIcon> = {
  'new-task': SquarePen,
  'new-temp-task': Zap,
  'reopen-closed-tab': History,
  'add-project': FolderPlus,
  'go-home': Home,
  'toggle-global-agent-panel': PanelRight,
  'open-changelog': Megaphone,
  'open-settings': Settings
}

function ActionShortcut({ shortcutId }: { shortcutId?: string }) {
  const display = useShortcutDisplay(shortcutId ?? '')
  if (!shortcutId || !display) return null
  return <CommandShortcut>{display}</CommandShortcut>
}

function selectorForItem(item: SearchItem): string {
  if (item.kind === 'file') return item.filePath
  return item.label
}

function Highlight({ text, positions }: { text: string; positions: Set<number> }) {
  if (positions.size === 0) return <>{text}</>
  const parts: ReactNode[] = []
  let run = ''
  let inMatch = false
  for (let i = 0; i < text.length; i++) {
    const matched = positions.has(i)
    if (matched !== inMatch && run) {
      parts.push(inMatch ? <mark key={i} className="bg-transparent text-foreground font-semibold">{run}</mark> : run)
      run = ''
    }
    inMatch = matched
    run += text[i]
  }
  if (run) {
    parts.push(inMatch ? <mark key={text.length} className="bg-transparent text-foreground font-semibold">{run}</mark> : run)
  }
  return <>{parts}</>
}

function offsetPositions(positions: Set<number>, offset: number): Set<number> {
  const out = new Set<number>()
  for (const p of positions) {
    const adj = p - offset
    if (adj >= 0) out.add(adj)
  }
  return out
}

function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (Number.isNaN(ms) || ms < 0) return ''
  const s = Math.floor(ms / 1000)
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d ago`
  const w = Math.floor(d / 7)
  if (w < 4) return `${w}w ago`
  const mo = Math.floor(d / 30)
  if (mo < 12) return `${mo}mo ago`
  const y = Math.floor(d / 365)
  return `${y}y ago`
}

interface SearchDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  tasks: Task[]
  projects: Project[]
  closedTabs: TaskTab[]
  openTaskTabs: TaskTab[]
  activeTaskId: string | null
  onSelectTask: (taskId: string) => void
  onSelectProject: (projectId: string) => void
  onNewTask: () => void
  onNewTemporaryTask: () => void
  onReopenClosedTab: () => void
  onAddProject: () => void
  onGoHome: () => void
  onToggleGlobalAgentPanel: () => void
  onOpenChangelog: () => void
  onOpenSettings: () => void
}

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
  const trpc = useTRPC()
  const fileContext = useDialogStore((s) => s.searchFileContext)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<FilterKind>('all')

  const filesQuery = useQuery({
    ...trpc.fileEditor.listAllFiles.queryOptions({ rootPath: fileContext?.projectPath ?? '' }),
    enabled: open && !!fileContext,
  })
  const allFiles: string[] = filesQuery.data ?? []

  useEffect(() => {
    if (open) {
      setSearch('')
      setFilter('all')
    }
  }, [open])

  const items = useMemo<SearchItem[]>(() => {
    const list: SearchItem[] = []
    const showActions = filter === 'all' || filter === 'actions'
    const showFiles = filter === 'all' || filter === 'files'
    const showTasks = filter === 'all' || filter === 'tasks'
    const showProjects = filter === 'all' || filter === 'projects'

    if (showActions) {
      for (const a of ACTION_DEFS) {
        list.push({ kind: 'action', id: a.id, label: a.label, sublabel: a.sublabel, shortcutId: a.shortcutId })
      }
    }
    if (showFiles && fileContext) {
      for (const f of allFiles) {
        const name = f.split('/').pop() ?? f
        const dir = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : ''
        list.push({ kind: 'file', id: f, label: name, sublabel: dir, filePath: f })
      }
    }
    if (showTasks) {
      for (const t of tasks) {
        const projectName = projects.find((p) => p.id === t.project_id)?.name ?? ''
        list.push({ kind: 'task', id: t.id, label: t.title, sublabel: projectName, status: t.status, priority: t.priority })
      }
    }
    if (showProjects) {
      for (const p of projects) {
        list.push({ kind: 'project', id: p.id, label: p.name, sublabel: '' })
      }
    }
    return list
  }, [allFiles, tasks, projects, filter, fileContext])

  const fzfLabel = useMemo(() => new Fzf(items, { selector: (i) => i.label, limit: MAX_RESULTS * 2, casing: 'case-insensitive' }), [items])
  const fzfPath = useMemo(() => new Fzf(items, { selector: selectorForItem, limit: MAX_RESULTS * 2, casing: 'case-insensitive' }), [items])

  const results = useMemo(() => {
    if (!search) return []
    const labelHits = fzfLabel.find(search)
    const pathHits = fzfPath.find(search)

    const pathMap = new Map(pathHits.map((r) => [r.item.id, r]))
    const seenIds = new Set<string>()
    const merged: { item: SearchItem; score: number; positions: Set<number>; usedPath: boolean }[] = []

    for (const r of labelHits) {
      seenIds.add(r.item.id)
      const boosted = r.score * BASENAME_BOOST
      const pathHit = r.item.kind === 'file' ? pathMap.get(r.item.id) : undefined
      if (pathHit && pathHit.score > boosted) {
        merged.push({ item: r.item, score: pathHit.score, positions: pathHit.positions, usedPath: true })
      } else {
        merged.push({ item: r.item, score: boosted, positions: r.positions, usedPath: false })
      }
    }

    for (const r of pathHits) {
      if (!seenIds.has(r.item.id)) {
        seenIds.add(r.item.id)
        merged.push({ item: r.item, score: r.score, positions: r.positions, usedPath: true })
      }
    }

    const weighted = merged.map((r) => ({
      ...r,
      weightedScore: r.score * KIND_WEIGHT[r.item.kind]
    }))
    weighted.sort((a, b) => b.weightedScore - a.weightedScore || selectorForItem(a.item).length - selectorForItem(b.item).length)
    return weighted.slice(0, MAX_RESULTS)
  }, [fzfLabel, fzfPath, search])

  const groupedResults = useMemo(() => {
    const actions = results.filter((r) => r.item.kind === 'action')
    const files = results.filter((r) => r.item.kind === 'file')
    const taskHits = results.filter((r) => r.item.kind === 'task')
    const projectHits = results.filter((r) => r.item.kind === 'project')
    return { actions, files, tasks: taskHits, projects: projectHits }
  }, [results])

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

  const renderActionItem = (id: ActionId) => {
    const def = ACTION_DEFS.find((a) => a.id === id)!
    const Icon = ACTION_ICONS[id]
    return (
      <CommandItem key={`action:${id}`} value={`action:${id}`} onSelect={handlerFor(id)}>
        <Icon className="text-muted-foreground" />
        <span>{def.label}</span>
        <ActionShortcut shortcutId={def.shortcutId} />
      </CommandItem>
    )
  }

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

  const handlerFor = (id: ActionId): () => void => {
    switch (id) {
      case 'new-task': return () => runAction(onNewTask)
      case 'new-temp-task': return () => runAction(onNewTemporaryTask)
      case 'reopen-closed-tab': return () => runAction(onReopenClosedTab)
      case 'add-project': return () => runAction(onAddProject)
      case 'go-home': return () => runAction(onGoHome)
      case 'toggle-global-agent-panel': return () => runAction(onToggleGlobalAgentPanel)
      case 'open-changelog': return () => runAction(onOpenChangelog)
      case 'open-settings': return () => runAction(onOpenSettings)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="overflow-hidden p-0 max-w-2xl !bg-surface-0 !rounded-3xl !border-0 shadow-2xl" showCloseButton={false}>
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
            {!isSearching && (
              <>
                <CommandGroup heading="Actions">
                  {ACTION_DEFS.filter((a) => a.featured).map((a) => renderActionItem(a.id))}
                </CommandGroup>
                {recentItems.length > 0 && (
                  <CommandGroup heading="Recent Tasks">
                    {recentItems.map(({ tab, projectName, updatedAt }) => {
                      const statusStyle = tab.status ? getTaskStatusStyle(tab.status) : null
                      const subtitle = projectName
                      const ago = formatRelative(updatedAt)
                      return (
                        <CommandItem
                          key={`recent:${tab.taskId}`}
                          value={`recent:${tab.taskId}`}
                          className="!items-start"
                          onSelect={() => {
                            onSelectTask(tab.taskId)
                            onOpenChange(false)
                          }}
                        >
                          {statusStyle ? (
                            <statusStyle.icon className={cn('size-4 mt-0.5', statusStyle.iconClass)} />
                          ) : (
                            <CheckSquare className="text-muted-foreground mt-0.5" />
                          )}
                          <div className="flex flex-col min-w-0 flex-1">
                            <span className="truncate font-medium">{tab.title}</span>
                            {subtitle && (
                              <span className="truncate text-[11px] text-muted-foreground">{subtitle}</span>
                            )}
                          </div>
                          {ago && (
                            <span className="ml-auto shrink-0 text-[11px] text-muted-foreground mt-0.5">{ago}</span>
                          )}
                        </CommandItem>
                      )
                    })}
                  </CommandGroup>
                )}
              </>
            )}

            {isSearching && results.length === 0 && <CommandEmpty>No results found.</CommandEmpty>}

            {isSearching && groupedResults.actions.length > 0 && (
              <CommandGroup heading="Actions">
                {groupedResults.actions.map((r) => {
                  const item = r.item as Extract<SearchItem, { kind: 'action' }>
                  const Icon = ACTION_ICONS[item.id]
                  return (
                    <CommandItem
                      key={`action:${item.id}`}
                      value={`action:${item.id}`}
                      onSelect={handlerFor(item.id)}
                    >
                      <Icon className="text-muted-foreground" />
                      <span><Highlight text={item.label} positions={r.positions} /></span>
                      <ActionShortcut shortcutId={item.shortcutId} />
                    </CommandItem>
                  )
                })}
              </CommandGroup>
            )}

            {isSearching && groupedResults.files.length > 0 && (
              <CommandGroup heading="Files">
                {groupedResults.files.map((r) => {
                  const item = r.item as Extract<SearchItem, { kind: 'file' }>
                  const namePositions = r.usedPath
                    ? offsetPositions(r.positions, item.filePath.length - item.label.length)
                    : r.positions
                  return (
                    <CommandItem
                      key={item.id}
                      value={item.id}
                      onSelect={() => {
                        track('quick_open_used')
                        fileContext?.openFile(item.filePath)
                        onOpenChange(false)
                      }}
                    >
                      <FileIcon fileName={item.label} className="size-4 shrink-0 flex items-center [&>svg]:size-full" />
                      <span className="truncate font-mono text-xs">
                        <Highlight text={item.label} positions={namePositions} />
                      </span>
                      {item.sublabel && (
                        <span className="ml-auto text-[11px] text-muted-foreground truncate max-w-[200px]">
                          {item.sublabel}
                        </span>
                      )}
                    </CommandItem>
                  )
                })}
              </CommandGroup>
            )}

            {isSearching && groupedResults.tasks.length > 0 && (
              <CommandGroup heading="Tasks">
                {groupedResults.tasks.map((r) => {
                  const item = r.item as Extract<SearchItem, { kind: 'task' }>
                  const statusStyle = getTaskStatusStyle(item.status)
                  const priorityLabel = priorityOptions.find((o) => o.value === item.priority)?.label
                  return (
                    <CommandItem
                      key={`task:${item.id}`}
                      value={`task:${item.id}`}
                      onSelect={() => {
                        onSelectTask(item.id)
                        onOpenChange(false)
                      }}
                    >
                      <CheckSquare className="mr-2" />
                      <span className="truncate"><Highlight text={item.label} positions={r.positions} /></span>
                      <div className="ml-auto flex items-center gap-1.5 shrink-0">
                        {statusStyle && (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium border border-border/60 text-muted-foreground">
                            <statusStyle.icon className={cn('size-3!', statusStyle.iconClass)} />
                            {statusStyle.label}
                          </span>
                        )}
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium border border-border/60 text-muted-foreground">
                          <PriorityIcon priority={item.priority} className="size-3!" />
                          {priorityLabel}
                        </span>
                      </div>
                    </CommandItem>
                  )
                })}
              </CommandGroup>
            )}

            {isSearching && groupedResults.projects.length > 0 && (
              <CommandGroup heading="Projects">
                {groupedResults.projects.map((r) => {
                  const item = r.item as Extract<SearchItem, { kind: 'project' }>
                  return (
                    <CommandItem
                      key={`project:${item.id}`}
                      value={`project:${item.id}`}
                      onSelect={() => {
                        onSelectProject(item.id)
                        onOpenChange(false)
                      }}
                    >
                      <Folder className="mr-2" />
                      <span><Highlight text={item.label} positions={r.positions} /></span>
                    </CommandItem>
                  )
                })}
              </CommandGroup>
            )}
          </CommandList>
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  )
}
