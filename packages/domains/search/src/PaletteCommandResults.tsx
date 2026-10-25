import { CommandGroup, CommandItem, cn, type PaletteCommand, type PalettePage } from '@slayzone/ui'
import { Check, ChevronRight, CornerDownLeft, Dot } from 'lucide-react'
import type { RankedResult } from './SearchDialog.algorithm'
import type { SearchItem } from './SearchDialog.types'
import { ActionShortcut } from './ActionShortcut'
import { Highlight } from './Highlight'

/** cmdk value of a task command row — the same everywhere it renders. */
export const taskCommandValue = (commandId: string): string => `task-command:cmd:${commandId}`

export const PROMPT_SUBMIT_VALUE = 'prompt:submit'

const EMPTY_POSITIONS = new Set<number>()

function TaskCommandRow({
  command,
  label,
  positions,
  onSelect
}: {
  command: PaletteCommand
  label: string
  positions: Set<number>
  onSelect: (command: PaletteCommand) => void
}) {
  const Icon = command.icon ?? Dot
  return (
    <CommandItem value={taskCommandValue(command.id)} onSelect={() => onSelect(command)}>
      <Icon className={cn('text-muted-foreground', command.iconClassName)} />
      <span className="truncate">
        <Highlight text={label} positions={positions} />
      </span>
      <div className="ml-auto flex items-center gap-1.5 shrink-0">
        {command.checked && <Check className="!size-4 text-muted-foreground" />}
        <ActionShortcut shortcutId={command.shortcutId} />
        {command.page && <ChevronRight className="!size-4 text-muted-foreground" />}
      </div>
    </CommandItem>
  )
}

/** "Current task" section: featured commands when idle, ranked hits when searching. */
export function TaskCommandGroup({
  heading,
  commands,
  results,
  onSelect
}: {
  heading: string
  /** Idle: rendered as-is. */
  commands?: PaletteCommand[]
  /** Searching: ranked hits (labels may carry a page trail). */
  results?: RankedResult[]
  onSelect: (command: PaletteCommand) => void
}) {
  if (results) {
    if (results.length === 0) return null
    return (
      <CommandGroup heading={heading}>
        {results.map((r) => {
          const item = r.item as Extract<SearchItem, { kind: 'task-command' }>
          return (
            <TaskCommandRow
              key={item.id}
              command={item.command}
              label={item.label}
              positions={r.positions}
              onSelect={onSelect}
            />
          )
        })}
      </CommandGroup>
    )
  }
  if (!commands || commands.length === 0) return null
  return (
    <CommandGroup heading={heading}>
      {commands.map((c) => (
        <TaskCommandRow
          key={c.id}
          command={c}
          label={c.label}
          positions={EMPTY_POSITIONS}
          onSelect={onSelect}
        />
      ))}
    </CommandGroup>
  )
}

/** The body of a sub-page. */
export function PageResults({
  page,
  search,
  results,
  onSelect,
  onSubmitPrompt
}: {
  page: PalettePage
  search: string
  results: RankedResult[]
  onSelect: (command: PaletteCommand) => void
  onSubmitPrompt: () => void
}) {
  if (page.kind === 'prompt') {
    const value = search.trim()
    return (
      <CommandGroup heading={page.title}>
        <CommandItem value={PROMPT_SUBMIT_VALUE} disabled={!value} onSelect={onSubmitPrompt}>
          <CornerDownLeft className="text-muted-foreground" />
          <span className="truncate">{value ? `${page.title}: ${value}` : page.placeholder}</span>
        </CommandItem>
      </CommandGroup>
    )
  }
  if (search.trim()) {
    if (results.length === 0) {
      return <div className="py-6 text-center text-sm text-muted-foreground">No results found.</div>
    }
    return <TaskCommandGroup heading={page.title} results={results} onSelect={onSelect} />
  }
  return <TaskCommandGroup heading={page.title} commands={page.items} onSelect={onSelect} />
}
