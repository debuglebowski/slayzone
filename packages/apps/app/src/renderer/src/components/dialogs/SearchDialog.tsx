import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { getTrpcVanillaClient } from '@slayzone/transport/client'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
  Dialog,
  DialogContent,
  cn,
  PriorityIcon,
  getTaskStatusStyle
} from '@slayzone/ui'
import { CheckSquare, Folder } from 'lucide-react'
import { Fzf } from 'fzf'
import { FileIcon } from '@slayzone/icons'
import { track } from '@slayzone/telemetry/client'
import { useDialogStore } from '@slayzone/settings'
import { type Task, priorityOptions } from '@slayzone/task/shared'
import type { Project } from '@slayzone/projects/shared'

const MAX_RESULTS = 50

type FilterKind = 'all' | 'files' | 'tasks' | 'projects'
const FILTERS: { id: FilterKind; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'files', label: 'Files' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'projects', label: 'Projects' }
]

type SearchItem =
  | { kind: 'file'; id: string; label: string; sublabel: string; filePath: string }
  | { kind: 'task'; id: string; label: string; sublabel: string; status: string; priority: number }
  | { kind: 'project'; id: string; label: string; sublabel: string }

const KIND_WEIGHT: Record<SearchItem['kind'], number> = {
  file: 1.0,
  task: 0.95,
  project: 0.9
}

const BASENAME_BOOST = 1.5

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

interface SearchDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  tasks: Task[]
  projects: Project[]
  onSelectTask: (taskId: string) => void
  onSelectProject: (projectId: string) => void
}

export function SearchDialog({
  open,
  onOpenChange,
  tasks,
  projects,
  onSelectTask,
  onSelectProject
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
    getTrpcVanillaClient().fileEditor.listAllFiles.query({ rootPath: path }).then((list) => {
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

  const items = useMemo<SearchItem[]>(() => {
    const list: SearchItem[] = []
    const showFiles = filter === 'all' || filter === 'files'
    const showTasks = filter === 'all' || filter === 'tasks'
    const showProjects = filter === 'all' || filter === 'projects'

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

  const firstValue = results[0]
    ? results[0].item.kind === 'file'
      ? results[0].item.id
      : `${results[0].item.kind}:${results[0].item.id}`
    : ''
  const [selected, setSelected] = useState('')
  const [prevFirstValue, setPrevFirstValue] = useState('')

  if (firstValue !== prevFirstValue) {
    setPrevFirstValue(firstValue)
    setSelected(firstValue)
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab') return
    e.preventDefault()
    const idx = FILTERS.findIndex((f) => f.id === filter)
    const delta = e.shiftKey ? -1 : 1
    const next = FILTERS[(idx + delta + FILTERS.length) % FILTERS.length]
    setFilter(next.id)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="overflow-hidden p-0 max-w-2xl" showCloseButton={false}>
        <Command
          shouldFilter={false}
          value={selected}
          onValueChange={setSelected}
          onKeyDown={handleKeyDown}
          className="[&_[cmdk-input-wrapper]_svg]:h-5 [&_[cmdk-input-wrapper]_svg]:w-5 [&_[cmdk-input]]:h-12 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-3 [&_[cmdk-item]_svg]:h-5 [&_[cmdk-item]_svg]:w-5"
        >
          <CommandInput
            placeholder="Search files, tasks, projects..."
            value={search}
            onValueChange={setSearch}
          />
          <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                tabIndex={-1}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setFilter(f.id)}
                className={cn(
                  'rounded px-2 py-1 text-xs transition-colors',
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
          <CommandList className="max-h-[600px]">
            {search && results.length === 0 && <CommandEmpty>No results found.</CommandEmpty>}

            {results.map((r) => {
              const item = r.item
              if (item.kind === 'file') {
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
              }
              if (item.kind === 'task') {
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
                    <CheckSquare className="mr-2 h-4 w-4" />
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
              }
              return (
                <CommandItem
                  key={`project:${item.id}`}
                  value={`project:${item.id}`}
                  onSelect={() => {
                    onSelectProject(item.id)
                    onOpenChange(false)
                  }}
                >
                  <Folder className="mr-2 h-4 w-4" />
                  <span><Highlight text={item.label} positions={r.positions} /></span>
                </CommandItem>
              )
            })}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  )
}
