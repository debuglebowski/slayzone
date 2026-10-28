import { useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Command,
  CommandInput,
  CommandList,
  Dialog,
  DialogContent,
  cn,
  usePaletteCommandStore,
  type PaletteCommand,
  type PalettePage
} from '@slayzone/ui'
import { ChevronLeft } from 'lucide-react'
import { track } from '@slayzone/telemetry/client'
import { useTRPC } from '@slayzone/transport/client'
import { useDialogStore } from '@slayzone/settings'
import type { ActionId, FilterKind, SearchDialogProps, TaskTab } from './SearchDialog.types'
import { FILTERS, MAX_RECENT } from './SearchDialog.constants'
import {
  buildSearchItems,
  createFzf,
  firstResultValue,
  groupResults,
  rankResults
} from './SearchDialog.algorithm'
import { SearchResults } from './SearchResults'
import { PageResults, PROMPT_SUBMIT_VALUE, taskCommandValue } from './PaletteCommandResults'

const NO_COMMANDS: PaletteCommand[] = []
const NO_FILES: string[] = []

type RunLater = () => void | Promise<void>

export function SearchDialog({ open, onOpenChange, ...props }: SearchDialogProps) {
  // A command that moves focus itself runs once the dialog's focus trap is gone
  // (onCloseAutoFocus) — run earlier, the closing trap would pull focus back.
  const pendingFocusRunRef = useRef<RunLater | null>(null)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="overflow-hidden p-0 max-w-2xl !bg-surface-0 !rounded-3xl !border-0 shadow-2xl duration-[60ms]"
        // The content sits inside the overlay, so the overlay's fade multiplies into it:
        // match its duration or the 60ms palette open (a40626b75) becomes 150ms.
        overlayClassName="duration-[60ms]"
        showCloseButton={false}
        onCloseAutoFocus={(e) => {
          const run = pendingFocusRunRef.current
          if (!run) return
          pendingFocusRunRef.current = null
          e.preventDefault()
          void run()
        }}
      >
        {/* Mounted only while open: every open starts from a fresh search, filter,
            page and highlight. */}
        <SearchPalette
          {...props}
          onOpenChange={onOpenChange}
          runAfterClose={(run) => {
            pendingFocusRunRef.current = run
          }}
        />
      </DialogContent>
    </Dialog>
  )
}

interface SearchPaletteProps extends Omit<SearchDialogProps, 'open'> {
  /** Runs `run` once the dialog has closed and its focus trap is gone. */
  runAfterClose: (run: RunLater) => void
}

function SearchPalette({
  onOpenChange,
  runAfterClose,
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
}: SearchPaletteProps) {
  const trpc = useTRPC()
  const fileContext = useDialogStore((s) => s.searchFileContext)
  // Fetched once per project and kept for the session (never refetched), keyed by
  // path so a slow answer can only ever fill its own project.
  // `files` is capped at the transport layer; `truncated` says so. Nothing here
  // acts on it yet.
  const { data: filesData } = useQuery({
    ...trpc.fileEditor.listAllFiles.queryOptions({ rootPath: fileContext?.projectPath ?? '' }),
    enabled: fileContext != null,
    staleTime: Infinity,
    gcTime: Infinity
  })
  const allFiles = fileContext ? (filesData?.files ?? NO_FILES) : NO_FILES
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<FilterKind>('all')
  // Commands the current task published (null outside a task).
  const taskScope = usePaletteCommandStore((s) => s.scope)
  const taskCommands = taskScope?.commands ?? NO_COMMANDS
  const taskHeading = taskScope ? `Current task · ${taskScope.title}` : null
  // Sub-page stack; the last entry is the page shown.
  const [pages, setPages] = useState<PalettePage[]>([])
  const page = pages.at(-1) ?? null
  // Page changes refocus the input: a mouse-picked row would otherwise leave focus
  // outside it, and typing (a prompt page's value) would go nowhere.
  const inputRef = useRef<HTMLInputElement>(null)

  const items = useMemo(() => {
    if (page) {
      // A page searches its own items only.
      if (page.kind === 'prompt') return []
      return buildSearchItems({
        filter: 'task',
        fileContext: null,
        allFiles: [],
        tasks: [],
        projects: [],
        taskCommands: page.items
      })
    }
    return buildSearchItems({ filter, fileContext, allFiles, tasks, projects, taskCommands })
  }, [page, allFiles, tasks, projects, filter, fileContext, taskCommands])

  const filters = useMemo(() => FILTERS.filter((f) => f.id !== 'task' || taskScope), [taskScope])
  const featuredTaskCommands = useMemo(() => taskCommands.filter((c) => c.featured), [taskCommands])

  const { fzfLabel, fzfPath } = useMemo(() => createFzf(items), [items])

  const results = useMemo(
    () => rankResults(fzfLabel, fzfPath, search, items),
    [fzfLabel, fzfPath, search, items]
  )

  const groupedResults = useMemo(() => groupResults(results), [results])

  const recentItems = useMemo(() => {
    const taskMap = new Map(tasks.map((t) => [t.id, t]))
    const seen = new Set<string>()
    const out: { tab: TaskTab; projectName: string; updatedAt: string }[] = []
    const push = (tab: TaskTab) => {
      if (out.length >= MAX_RECENT) return
      // Scratch terminals aren't "recent work" — open or closed.
      if (tab.isTemporary) return
      if (seen.has(tab.taskId)) return
      if (tab.taskId === activeTaskId) return
      const task = taskMap.get(tab.taskId)
      if (!task) return
      seen.add(tab.taskId)
      const projectName = projects.find((p) => p.id === task.project_id)?.name ?? ''
      out.push({ tab, projectName, updatedAt: task.updated_at })
    }
    for (let i = closedTabs.length - 1; i >= 0; i--) push(closedTabs[i])
    for (const tab of openTaskTabs) push(tab)
    return out
  }, [closedTabs, openTaskTabs, activeTaskId, tasks, projects])

  const isSearching = search.trim().length > 0

  const firstValue = useMemo(() => {
    if (page?.kind === 'prompt') return PROMPT_SUBMIT_VALUE
    if (!isSearching) {
      if (page) {
        const current = page.items.find((c) => c.checked) ?? page.items[0]
        return current ? taskCommandValue(current.id) : ''
      }
      const featured = featuredTaskCommands[0]
      return featured ? taskCommandValue(featured.id) : 'action:new-task'
    }
    return firstResultValue(groupedResults)
  }, [page, isSearching, groupedResults, featuredTaskCommands])

  const [selected, setSelected] = useState('')
  const [prevFirstValue, setPrevFirstValue] = useState('')

  if (firstValue !== prevFirstValue) {
    setPrevFirstValue(firstValue)
    setSelected(firstValue)
  }

  // cmdk selects the first row on screen after every search edit. Our selection is the
  // best hit, which can sit below its command row, so that one re-select is ignored.
  // It runs in cmdk's layout effect; the frame clears the flag should it not come.
  const searchEditedRef = useRef(false)
  const handleSearchChange = (value: string) => {
    setSearch(value)
    searchEditedRef.current = true
    requestAnimationFrame(() => {
      searchEditedRef.current = false
    })
  }

  const pushPage = (next: PalettePage) => {
    setPages((prev) => [...prev, next])
    setSearch(next.kind === 'prompt' ? (next.initialValue ?? '') : '')
    inputRef.current?.focus()
  }

  const popPage = () => {
    setPages((prev) => prev.slice(0, -1))
    setSearch('')
    inputRef.current?.focus()
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Backspace' && page && !search) {
      e.preventDefault()
      popPage()
      return
    }
    if (e.key !== 'Tab' || !isSearching || page) return
    e.preventDefault()
    const idx = filters.findIndex((f) => f.id === filter)
    const delta = e.shiftKey ? -1 : 1
    const next = filters[(idx + delta + filters.length) % filters.length]
    setFilter(next.id)
  }

  const runTaskCommand = (command: PaletteCommand) => {
    if (command.page) {
      pushPage(command.page)
      return
    }
    if (!command.run) return
    if (command.keepOpen) {
      void command.run()
      return
    }
    if (command.takesFocus) {
      runAfterClose(command.run)
      onOpenChange(false)
      return
    }
    onOpenChange(false)
    void command.run()
  }

  const submitPrompt = () => {
    if (page?.kind !== 'prompt') return
    const value = search.trim()
    if (!value) return
    onOpenChange(false)
    void page.onSubmit(value)
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
    <Command
      shouldFilter={false}
      value={selected}
      onValueChange={(value) => {
        if (searchEditedRef.current) {
          // cmdk's own select-first-row after a search edit. It has already moved its
          // internal selection, and re-reads ours only when our prop changes — so toggle
          // a trailing space (cmdk trims values, per its docs) to make it re-sync.
          searchEditedRef.current = false
          setSelected((cur) => (cur.endsWith(' ') ? cur.trimEnd() : `${cur} `))
          return
        }
        setSelected(value)
      }}
      onKeyDown={handleKeyDown}
      className="bg-transparent [&_[cmdk-input-wrapper]]:border-b-0 [&_[cmdk-input-wrapper]_svg]:h-5 [&_[cmdk-input-wrapper]_svg]:w-5 [&_[cmdk-input]]:h-16 [&_[cmdk-input]]:text-base [&_[cmdk-item]]:rounded-xl [&_[cmdk-item]]:px-3 [&_[cmdk-item]]:py-2.5 [&_[cmdk-item]_svg]:h-5 [&_[cmdk-item]_svg]:w-5 [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground"
    >
      <CommandInput
        ref={inputRef}
        placeholder={
          page
            ? (page.placeholder ?? `Search ${page.title.toLowerCase()}...`)
            : 'Search files, folders, commands, projects, and tasks...'
        }
        value={search}
        onValueChange={handleSearchChange}
      />
      <div className="bg-card rounded-t-3xl">
        {page && (
          <div className="flex items-center gap-1 px-2 py-1.5">
            <button
              type="button"
              tabIndex={-1}
              onMouseDown={(e) => e.preventDefault()}
              onClick={popPage}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-accent/40"
            >
              <ChevronLeft className="size-3.5" />
              {[taskScope?.title, ...pages.map((p) => p.title)].filter(Boolean).join(' › ')}
            </button>
            <span className="ml-auto text-[10px] text-muted-foreground/70">
              Backspace to go back
            </span>
          </div>
        )}
        {isSearching && !page && (
          <div className="flex items-center gap-1 px-2 py-1.5">
            {filters.map((f) => (
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
        {/* No fixed cap: grows with its results, bounded only by the window (input + chips + margins). */}
        <CommandList className="max-h-[calc(100dvh-12rem)]">
          {page ? (
            <PageResults
              page={page}
              search={search}
              results={groupedResults.taskCommands}
              onSelect={runTaskCommand}
              onSubmitPrompt={submitPrompt}
            />
          ) : (
            <SearchResults
              isSearching={isSearching}
              groups={groupedResults}
              recentItems={recentItems}
              taskHeading={taskHeading}
              featuredTaskCommands={featuredTaskCommands}
              onRunTaskCommand={runTaskCommand}
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
          )}
        </CommandList>
      </div>
    </Command>
  )
}
