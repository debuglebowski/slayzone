import { cn } from '@slayzone/ui'
import type { PromptOption } from './prompt-options'

/**
 * The TUI's numbered rows: `❯ 1. Yes`. The number and pointer are decoration
 * (keys 1–9 pick a row); each row's accessible name is its label.
 */
export function PromptRows({
  options,
  selected,
  disabled,
  onChoose
}: {
  options: PromptOption[]
  selected: number
  disabled: boolean
  onChoose: (index: number) => void
}) {
  return (
    <div role="group" className="grid gap-0.5">
      {options.map((option, i) => (
        <button
          key={option.id}
          type="button"
          disabled={disabled}
          aria-current={i === selected ? 'true' : undefined}
          onClick={() => onChoose(i)}
          className={cn(
            'flex items-start gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors',
            i === selected
              ? 'bg-accent text-accent-foreground'
              : 'hover:bg-muted/60 text-foreground',
            disabled && 'opacity-60 cursor-not-allowed'
          )}
        >
          <span aria-hidden className="shrink-0 w-6 select-none font-mono text-muted-foreground">
            {i === selected ? '❯' : ' '} {i + 1}.
          </span>
          <span className="min-w-0">{option.label}</span>
        </button>
      ))}
    </div>
  )
}
