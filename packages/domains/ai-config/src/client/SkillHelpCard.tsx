import { useState } from 'react'
import { ChevronDown, Sparkles } from 'lucide-react'
import { cn } from '@slayzone/ui'

export function SkillHelpCard({ testId, className }: { testId?: string; className?: string }) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div
      data-testid={testId}
      className={cn('rounded-xl border border-border/80 bg-background/70 shadow-sm backdrop-blur-sm', className)}
    >
      <button
        type="button"
        className="flex w-full items-center justify-between gap-3 rounded-t-xl px-4 py-3 text-left"
        aria-expanded={expanded}
        data-testid={testId ? `${testId}-toggle` : undefined}
        onClick={() => setExpanded((value) => !value)}
      >
        <div className="flex items-center gap-2">
          <div className="flex size-7 items-center justify-center rounded-md border bg-muted/30">
            <Sparkles className="size-3.5 text-muted-foreground" />
          </div>
          <div>
            <p className="text-sm font-medium">Skill file</p>
            <p className="text-[11px] text-muted-foreground">Required structure and field meanings</p>
          </div>
        </div>
        <div className="flex size-7 items-center justify-center rounded-md border bg-muted/20">
          <ChevronDown
            className={cn(
              'size-4 shrink-0 text-muted-foreground transition-transform',
              expanded && 'rotate-180'
            )}
          />
        </div>
      </button>
      {expanded && (
        <div className="border-t px-4 py-3">
          <p className="text-xs text-muted-foreground">
            Frontmatter comes first, followed by the instruction body.
          </p>
          <div className="mt-3 grid gap-2.5 sm:grid-cols-2">
            <div className="rounded-lg bg-muted/20 px-3 py-2.5">
              <p className="font-mono text-[11px] font-medium text-foreground">name</p>
              <p className="mt-1 text-xs leading-5 text-foreground">Skill identifier. Usually matches the slug.</p>
              <p className="text-[11px] text-muted-foreground">Options: any value</p>
            </div>

            <div className="rounded-lg bg-muted/20 px-3 py-2.5">
              <p className="font-mono text-[11px] font-medium text-foreground">description</p>
              <p className="mt-1 text-xs leading-5 text-foreground">Short summary of what the skill does.</p>
              <p className="text-[11px] text-muted-foreground">Options: any value</p>
            </div>

            <div className="rounded-lg bg-muted/20 px-3 py-2.5">
              <p className="font-mono text-[11px] font-medium text-foreground">trigger</p>
              <p className="mt-1 text-xs leading-5 text-foreground">Hint for when the skill should be used.</p>
              <p className="text-[11px] text-muted-foreground">Options: any value. Default: auto</p>
            </div>

            <div className="rounded-lg bg-muted/20 px-3 py-2.5">
              <p className="text-[11px] font-medium text-foreground">other fields</p>
              <p className="mt-1 text-xs leading-5 text-foreground">Allowed, but not interpreted by the app today.</p>
            </div>

            <div className="rounded-lg bg-muted/20 px-3 py-2.5 sm:col-span-2">
              <p className="font-mono text-[11px] font-medium text-foreground">body</p>
              <p className="mt-1 text-xs leading-5 text-foreground">The actual instructions or prompt.</p>
              <p className="text-[11px] text-muted-foreground">Options: any content</p>
            </div>
          </div>

        </div>
      )}
    </div>
  )
}
