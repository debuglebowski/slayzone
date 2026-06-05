import { type ReactNode, type ButtonHTMLAttributes } from 'react'
import {
  toggleStrongCommand,
  toggleEmphasisCommand,
  wrapInBulletListCommand,
  wrapInOrderedListCommand
} from '@milkdown/preset-commonmark'
import { cn } from '@slayzone/ui'
import type { FormatState } from './rich-text-editor.types'
import { toggleTaskListCommand } from './editor-commands'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function EditorToolbar({
  formatState,
  onCommand
}: {
  formatState: FormatState
  onCommand: (cmd: any) => void
}) {
  return (
    <div className="flex items-center gap-0.5 border-b border-border/50 px-1 py-1 shrink-0">
      <ToolbarButton
        active={formatState.bold}
        onClick={() => onCommand(toggleStrongCommand.key)}
        aria-label="Bold"
        title="Bold"
      >
        B
      </ToolbarButton>
      <ToolbarButton
        active={formatState.italic}
        onClick={() => onCommand(toggleEmphasisCommand.key)}
        aria-label="Italic"
        title="Italic"
      >
        <span className="italic">I</span>
      </ToolbarButton>
      <div className="mx-1 h-4 w-px bg-border/50" />
      <ToolbarButton
        active={formatState.bulletList}
        onClick={() => onCommand(wrapInBulletListCommand.key)}
        aria-label="Bullet list"
        title="Bullet list"
      >
        <svg className="size-3.5" viewBox="0 0 16 16" fill="currentColor">
          <circle cx="3" cy="4" r="1.5" />
          <circle cx="3" cy="8" r="1.5" />
          <circle cx="3" cy="12" r="1.5" />
          <rect x="6" y="3" width="9" height="2" rx="0.5" />
          <rect x="6" y="7" width="9" height="2" rx="0.5" />
          <rect x="6" y="11" width="9" height="2" rx="0.5" />
        </svg>
      </ToolbarButton>
      <ToolbarButton
        active={formatState.orderedList}
        onClick={() => onCommand(wrapInOrderedListCommand.key)}
        aria-label="Ordered list"
        title="Ordered list"
      >
        <svg className="size-3.5" viewBox="0 0 16 16" fill="currentColor">
          <text x="1" y="5.5" fontSize="5" fontFamily="sans-serif">
            1
          </text>
          <text x="1" y="9.5" fontSize="5" fontFamily="sans-serif">
            2
          </text>
          <text x="1" y="13.5" fontSize="5" fontFamily="sans-serif">
            3
          </text>
          <rect x="6" y="3" width="9" height="2" rx="0.5" />
          <rect x="6" y="7" width="9" height="2" rx="0.5" />
          <rect x="6" y="11" width="9" height="2" rx="0.5" />
        </svg>
      </ToolbarButton>
      <ToolbarButton
        active={formatState.taskList}
        onClick={() => onCommand(toggleTaskListCommand.key)}
        aria-label="Checkbox list"
        title="Checkbox list"
      >
        <svg
          className="size-3.5"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <rect x="1" y="2" width="4" height="4" rx="0.75" />
          <rect x="1" y="6" width="4" height="4" rx="0.75" />
          <rect x="1" y="10" width="4" height="4" rx="0.75" />
          <path d="M2 8.5 3 9.5 4.5 7.5" strokeLinecap="round" strokeLinejoin="round" />
          <line x1="7" y1="4" x2="15" y2="4" />
          <line x1="7" y1="8" x2="15" y2="8" />
          <line x1="7" y1="12" x2="15" y2="12" />
        </svg>
      </ToolbarButton>
    </div>
  )
}

function ToolbarButton({
  active,
  onClick,
  children,
  ...props
}: {
  active: boolean
  onClick: () => void
  children: ReactNode
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-center justify-center size-7 rounded text-xs font-semibold transition-colors',
        active
          ? 'bg-accent text-accent-foreground'
          : 'text-muted-foreground hover:bg-muted hover:text-foreground'
      )}
      {...props}
    >
      {children}
    </button>
  )
}
