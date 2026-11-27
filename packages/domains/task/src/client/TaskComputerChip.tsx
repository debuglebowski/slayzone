import { useQuery } from '@tanstack/react-query'
import { Check, ChevronDown, Laptop, Loader2, Server } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
  cn,
  useShortcutDisplay
} from '@slayzone/ui'
import { runsOnLabel } from '@slayzone/computers/labels'
import { useTRPC } from './trpc'
import { MOVE_STEP_TEXT, useTaskComputerControls, type ComputerListItem } from './ComputerCard'

interface TaskComputerChipProps {
  taskId: string
  projectId: string
  /** The task's own binding — null = inherit the project default. */
  taskComputerId: string | null
  /** The project's default computer — null = local. */
  projectDefaultComputerId: string | null
  /** Controlled open state, so the task's ⌘⇧M shortcut can open it. */
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * Title-row chip showing which computer the task runs on, with a menu to switch it.
 * Switching goes through the same preview/confirm dialog as Settings → Computer, so a
 * move that copies files is never started by one click. Renders nothing when no
 * computer is enrolled (everything runs locally then).
 */
export function TaskComputerChip(props: TaskComputerChipProps): React.JSX.Element | null {
  const trpc = useTRPC()
  const computers = useQuery(trpc.computers.list.queryOptions()).data ?? []
  if (computers.length === 0) return null
  return <TaskComputerChipControls key={props.taskId} {...props} computers={computers} />
}

function TaskComputerChipControls({
  open,
  onOpenChange,
  ...props
}: TaskComputerChipProps & { computers: ComputerListItem[] }): React.JSX.Element {
  const shortcut = useShortcutDisplay('task-computer')
  const { effectiveId, nameFor, options, inheritValue, moving, move, openDialog, dialog } =
    useTaskComputerControls(props)
  const current = props.taskComputerId ?? inheritValue
  const Icon = effectiveId == null ? Laptop : Server
  const label =
    moving && move ? `Moving to ${nameFor(move.destinationComputerId)}` : nameFor(effectiveId)

  return (
    <>
      <DropdownMenu open={open} onOpenChange={onOpenChange}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`Computer: ${label}`}
            title={
              moving && move
                ? `${label} · ${MOVE_STEP_TEXT[move.step]}`
                : `${runsOnLabel(nameFor(effectiveId))}${shortcut ? ` (${shortcut})` : ''}`
            }
            className={cn(
              'inline-flex h-7 max-w-48 shrink-0 items-center gap-1.5 rounded-md border border-border bg-surface-1 px-2 text-xs text-foreground transition-colors hover:bg-accent data-[state=open]:bg-accent window-no-drag'
            )}
          >
            {moving ? (
              <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
            ) : (
              <Icon className="size-3.5 shrink-0 text-muted-foreground" />
            )}
            <span className="truncate">{label}</span>
            <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-[260px]">
          <DropdownMenuLabel className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/60">
            Run on
          </DropdownMenuLabel>
          {options.map((option) => (
            <DropdownMenuItem
              key={option.value}
              disabled={moving || ('disabled' in option && option.disabled)}
              onSelect={() => {
                if (option.value === current) return
                openDialog(option.value === inheritValue ? null : option.value)
              }}
            >
              {option.value === inheritValue ? (
                <Laptop className="size-4" />
              ) : (
                <Server className="size-4" />
              )}
              <span className="truncate">
                {option.label}
                {'mark' in option && option.mark && (
                  <span className="text-muted-foreground"> {option.mark}</span>
                )}
              </span>
              {option.value === current && <Check className="size-4 col-start-3" />}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={moving} onSelect={() => openDialog()}>
            <span>Change computer…</span>
            {shortcut && <DropdownMenuShortcut>{shortcut}</DropdownMenuShortcut>}
          </DropdownMenuItem>
          <p className="px-2 pb-1.5 pt-1 text-[11px] leading-snug text-muted-foreground">
            New agents and terminals start there. Moving a task with work in progress copies its
            files first.
          </p>
        </DropdownMenuContent>
      </DropdownMenu>
      {dialog}
    </>
  )
}
