import type { ReactNode } from 'react'
import { TerminalProgressDot } from '@slayzone/ui'
import { type Task } from '@slayzone/task/shared'

// Floating drag preview — renders portal'd to document.body via DragOverlay,
// so it escapes the project's `overflow-hidden` collapsible wrapper. Without
// this, the dragged row's transform is clipped at the project boundary and
// vanishes after a few pixels of motion.
export function TaskDragPreview({ tasks }: { tasks: Task[] }): ReactNode {
  if (tasks.length === 0) return null
  const lead = tasks[0]
  const extra = tasks.length - 1
  const isMulti = extra > 0
  // Single-row card with source title + "+N" chip. When multi, two thin peeks
  // behind hint at the stack without making a heavy visual.
  return (
    <div className="relative">
      {isMulti && (
        <>
          <div
            aria-hidden
            className="absolute inset-0 -z-10 translate-x-1 translate-y-1 rounded-md bg-surface-2/60 ring-1 ring-border/60"
          />
          <div
            aria-hidden
            className="absolute inset-0 -z-20 translate-x-2 translate-y-2 rounded-md bg-surface-2/30 ring-1 ring-border/40"
          />
        </>
      )}
      <div className="relative flex items-center gap-2 rounded-md bg-surface-2/95 px-2 py-1 text-sm text-foreground shadow-lg ring-1 ring-border min-h-[28px]">
        <TerminalProgressDot
          state={undefined}
          progress={undefined}
          isDone={false}
          needsAttention={Boolean(lead.needs_attention)}
          alwaysShow
        />
        <span className="truncate max-w-[260px]">{lead.title || 'Untitled'}</span>
        {isMulti && (
          <span className="shrink-0 rounded bg-foreground/10 text-muted-foreground px-1.5 py-0.5 text-[10px] font-medium tabular-nums">
            +{extra}
          </span>
        )}
      </div>
    </div>
  )
}

/** Floating preview shown in the DragOverlay while a project is being
 *  reordered — a compact header chip (color swatch + name), mirroring the
 *  "lift the card out" feel of {@link TaskDragPreview}. */
export function ProjectDragPreview({
  project
}: {
  project: { name: string; color: string }
}): ReactNode {
  return (
    <div className="flex h-10 items-center gap-2 rounded-lg bg-surface-2/95 px-2.5 text-sm font-semibold text-foreground shadow-lg ring-1 ring-border">
      <span
        aria-hidden
        className="size-2.5 shrink-0 rounded-full"
        style={{ backgroundColor: project.color }}
      />
      <span className="truncate max-w-[220px]">{project.name}</span>
    </div>
  )
}
