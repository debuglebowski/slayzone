import { cn } from '@slayzone/ui'

export interface PromptRowOption {
  id: string
  label: string
  description?: string
}

/**
 * Numbered choices shared by approval and question prompts. Approval rows
 * execute when clicked; question rows select a value for later submission.
 */
export function PromptRows({
  options,
  selected,
  disabled,
  onChoose,
  appearance = 'plain',
  selectionMode = 'cursor',
  label
}: {
  options: PromptRowOption[]
  selected: number
  disabled: boolean
  onChoose: (index: number) => void
  appearance?: 'plain' | 'cards'
  selectionMode?: 'cursor' | 'answer'
  label?: string
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn('grid', appearance === 'cards' ? 'gap-1.5' : 'gap-0.5')}
    >
      {options.map((option, i) => (
        <button
          key={option.id}
          type="button"
          disabled={disabled}
          aria-current={selectionMode === 'cursor' && i === selected ? 'true' : undefined}
          aria-pressed={selectionMode === 'answer' ? i === selected : undefined}
          onClick={() => onChoose(i)}
          className={cn(
            'flex w-full items-start gap-2 rounded-md text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            appearance === 'cards'
              ? cn(
                  'border px-3 py-2 text-sm',
                  i === selected
                    ? 'border-primary/60 bg-primary/10 text-foreground'
                    : 'border-border bg-background/40 text-foreground hover:border-primary/40 hover:bg-muted/60'
                )
              : cn(
                  'px-2 py-1 text-xs',
                  i === selected
                    ? 'bg-accent text-accent-foreground'
                    : 'hover:bg-muted/60 text-foreground'
                ),
            disabled && 'opacity-60 cursor-not-allowed'
          )}
        >
          <span aria-hidden className="shrink-0 w-6 select-none font-mono text-muted-foreground">
            {selectionMode === 'cursor' && i === selected ? '❯' : ' '} {i + 1}.
          </span>
          <span className="min-w-0 flex-1 break-words">
            <span className={cn(appearance === 'cards' && 'font-medium')}>{option.label}</span>
            {option.description && (
              <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
                {option.description}
              </span>
            )}
          </span>
          {selectionMode === 'answer' && appearance === 'cards' && (
            <span
              aria-hidden
              className={cn(
                'mt-0.5 flex size-3.5 shrink-0 items-center justify-center rounded-full border',
                i === selected ? 'border-primary' : 'border-muted-foreground/50'
              )}
            >
              {i === selected && <span className="size-1.5 rounded-full bg-primary" />}
            </span>
          )}
        </button>
      ))}
    </div>
  )
}
