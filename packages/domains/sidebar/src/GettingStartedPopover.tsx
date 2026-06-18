import { useState } from 'react'
import { Check, CheckCheck } from 'lucide-react'
import { FaRegHandshake } from 'react-icons/fa'
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  Popover,
  PopoverTrigger,
  PopoverContent,
  cn
} from '@slayzone/ui'
import type { OnboardingChecklistState } from './types'

export function GettingStartedPopover({
  layout,
  tooltipSide,
  onboardingChecklist
}: {
  layout: 'vertical' | 'horizontal'
  tooltipSide: 'top' | 'right'
  onboardingChecklist: OnboardingChecklistState
}) {
  const [checklistOpen, setChecklistOpen] = useState(false)

  return (
    <Popover open={checklistOpen} onOpenChange={setChecklistOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label="Getting Started"
              className={cn(
                'relative inline-flex items-center justify-center rounded-lg transition-colors',
                layout === 'horizontal' ? 'size-10' : 'h-11 w-11',
                'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                onboardingChecklist.dismissed && 'opacity-80'
              )}
            >
              <FaRegHandshake className="size-5" />
              {onboardingChecklist.hasRemaining && !onboardingChecklist.dismissed && (
                <span className="absolute -top-1 -right-1 min-w-4 rounded-full bg-primary px-1 text-[10px] font-semibold leading-4 text-primary-foreground">
                  {onboardingChecklist.remainingCount}
                </span>
              )}
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side={tooltipSide}>Getting Started</TooltipContent>
      </Tooltip>
      <PopoverContent side={tooltipSide} align="end" sideOffset={12} className="w-[320px] p-3">
        <div className="mb-5 flex items-center justify-between gap-2">
          <p className="pt-0.5 text-base font-semibold">Getting started</p>
          {onboardingChecklist.hasRemaining && !onboardingChecklist.dismissed && (
            <button
              type="button"
              aria-label="Complete all items"
              onClick={() => {
                onboardingChecklist.onDismiss()
                setChecklistOpen(false)
              }}
              className="mr-1 inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <CheckCheck className="size-4" />
            </button>
          )}
        </div>
        <div className="space-y-2">
          {onboardingChecklist.steps.map((step, index) => {
            const disabled = step.disabled || (step.completed && !step.allowWhenCompleted)

            return (
              <button
                key={step.id}
                type="button"
                onClick={() => {
                  step.onClick()
                  setChecklistOpen(false)
                }}
                disabled={disabled}
                className={cn(
                  'group flex w-full items-center justify-between rounded-lg px-2.5 py-2.5 text-left text-sm transition-colors',
                  step.completed
                    ? disabled
                      ? 'text-muted-foreground'
                      : 'text-muted-foreground hover:bg-muted/35'
                    : step.disabled
                      ? 'cursor-not-allowed border border-border/60 bg-muted/25 text-muted-foreground/50 shadow-[0_1px_0_rgba(255,255,255,0.03)]'
                      : 'border border-border/70 bg-muted/35 shadow-[0_1px_0_rgba(255,255,255,0.03)] hover:border-border hover:bg-muted/55'
                )}
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span
                    className={cn(
                      'inline-flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold',
                      step.disabled
                        ? 'border-border bg-muted text-muted-foreground/60'
                        : 'border-border bg-background text-muted-foreground group-hover:bg-muted'
                    )}
                  >
                    {index + 1}
                  </span>
                  <span
                    className={cn(
                      'truncate',
                      step.completed && 'line-through decoration-muted-foreground/70'
                    )}
                  >
                    {step.label}
                  </span>
                </div>
                {step.completed ? (
                  <Check className="size-4 text-green-500" />
                ) : (
                  <span className="h-4 w-4 rounded-full border border-border" />
                )}
              </button>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}
