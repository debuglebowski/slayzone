import { useState } from 'react'
import { Bot, GitBranch, Pin, User, X } from 'lucide-react'
import {
  cn,
  Popover,
  PopoverTrigger,
  PopoverContent,
  Tooltip,
  TooltipTrigger,
  TooltipContent
} from '@slayzone/ui'
import type { ChatPinnedMessage } from '@slayzone/terminal-contracts'
import { formatTime } from './tool-cards/card-shell'

/**
 * The composer footer's list of the conversation's pinned messages, newest
 * first: picking one goes to it, × unpins it. Absent while nothing is pinned.
 */
export function PinnedMessagesPopover({
  pins,
  go,
  unpin,
  inBranchOf
}: {
  /** Oldest first (as listed). */
  pins: readonly ChatPinnedMessage[]
  go: (pin: ChatPinnedMessage) => void
  unpin: (pin: ChatPinnedMessage) => void
  /** The fold a rewind / fork put the pin's row in, else null. */
  inBranchOf: (pin: ChatPinnedMessage) => string | null
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  if (pins.length === 0) return null
  const label = `Pinned messages (${pins.length})`
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">
            <PopoverTrigger asChild>
              <button
                type="button"
                data-testid="chat-pinned-messages"
                aria-label={label}
                className={cn(
                  'flex items-center gap-1 rounded-md px-1.5 py-0.5 tabular-nums transition-colors hover:bg-muted/60 hover:text-foreground',
                  open && 'bg-muted/60 text-foreground'
                )}
              >
                <Pin className="size-3" />
                {pins.length}
              </button>
            </PopoverTrigger>
          </span>
        </TooltipTrigger>
        <TooltipContent side="top">{label}</TooltipContent>
      </Tooltip>
      <PopoverContent
        align="end"
        className="w-[360px] max-w-[calc(100vw-2rem)] max-h-[min(420px,var(--radix-popover-content-available-height))] overflow-y-auto p-1"
      >
        <h3 className="px-2 pb-1 pt-1.5 text-[9px] font-medium uppercase tracking-widest text-muted-foreground">
          Pinned messages
        </h3>
        <ul aria-label="Pinned messages">
          {[...pins].reverse().map((pin) => {
            const elsewhere = inBranchOf(pin) !== null
            const Icon = pin.target === 'answer' ? Bot : User
            return (
              <li key={pin.key} className="group flex items-center rounded-md hover:bg-muted/60">
                <button
                  type="button"
                  data-testid="chat-pinned-message"
                  className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-xs"
                  onClick={() => {
                    setOpen(false)
                    go(pin)
                  }}
                >
                  <Icon
                    className="size-3.5 shrink-0 text-muted-foreground"
                    aria-label={pin.target === 'answer' ? 'Answer' : 'Your message'}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-foreground">
                      {pin.excerpt || '(empty message)'}
                    </span>
                    {elsewhere && (
                      <span className="mt-0.5 flex items-center gap-1 text-[10px] text-muted-foreground">
                        <GitBranch className="size-2.5" />
                        Not in the current branch
                      </span>
                    )}
                  </span>
                  <time
                    className="shrink-0 text-[10px] text-muted-foreground tabular-nums"
                    dateTime={new Date(pin.pinnedAt).toISOString()}
                    title={`Pinned ${new Date(pin.pinnedAt).toLocaleString()}`}
                  >
                    {formatTime(pin.pinnedAt)}
                  </time>
                </button>
                <button
                  type="button"
                  aria-label="Unpin message"
                  title="Unpin"
                  className="mr-1 flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                  onClick={() => unpin(pin)}
                >
                  <X className="size-3" />
                </button>
              </li>
            )
          })}
        </ul>
      </PopoverContent>
    </Popover>
  )
}
