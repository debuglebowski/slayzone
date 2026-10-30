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
          <PromptRowMarker index={i} selected={i === selected} />
          <span className="min-w-0">{option.label}</span>
        </button>
      ))}
    </div>
  )
}

/**
 * A row's `❯ 1.`: one line at any width (the label beside it wraps under its
 * own text), the pointer in a fixed box so every row's label starts in the
 * same column whether selected or not.
 */
export function PromptRowMarker({ index, selected }: { index: number; selected: boolean }) {
  return (
    <span
      aria-hidden
      className="flex shrink-0 select-none whitespace-nowrap font-mono tabular-nums text-muted-foreground"
    >
      <span className="w-[2ch]">{selected ? '❯' : ''}</span>
      <span className="min-w-[3ch]">{index + 1}.</span>
    </span>
  )
}
