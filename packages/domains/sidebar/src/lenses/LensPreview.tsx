import { useState } from 'react'
import type { TerminalState } from '@slayzone/terminal-contracts'
import { cn, useNow } from '@slayzone/ui'
import { TreeView } from '../views/TreeView'
import { useSidebarSnapshot } from '../views/sidebar-snapshot'
import type { SidebarViewContext } from '../views/types'
import { MOCK_PROJECTS, mockTasks } from './mock-data'

const NOOP = (): void => {
  // Read-only preview: no action does anything.
}

const MOCK_AGENT_STATES: Record<string, TerminalState> = {
  'mock-a:mock-a': 'running',
  'mock-e:mock-e': 'running',
  'mock-c:mock-c': 'idle'
}

function mockContext(now: number): SidebarViewContext {
  const tasks = mockTasks(now)
  return {
    projects: MOCK_PROJECTS,
    projectGroups: [],
    tasks,
    selectedProjectId: MOCK_PROJECTS[0].id,
    sessionTaskIds: new Set(['mock-a', 'mock-e']),
    doneTaskIds: new Set(tasks.filter((t) => t.status === 'done').map((t) => t.id)),
    blockedTaskIds: new Set(tasks.filter((t) => t.is_blocked).map((t) => t.id)),
    onSelectProject: NOOP,
    onProjectSettings: NOOP,
    onReorderProjects: NOOP
  }
}

/** The real sidebar's data with every action stripped: the preview never changes data. */
function readOnly(ctx: SidebarViewContext): SidebarViewContext {
  return {
    projects: ctx.projects,
    projectGroups: ctx.projectGroups,
    tasks: ctx.tasks,
    selectedProjectId: ctx.selectedProjectId,
    sessionTaskIds: ctx.sessionTaskIds,
    taskProgress: ctx.taskProgress,
    doneTaskIds: ctx.doneTaskIds,
    columnsByProjectId: ctx.columnsByProjectId,
    tags: ctx.tags,
    taskTags: ctx.taskTags,
    blockedTaskIds: ctx.blockedTaskIds,
    onSelectProject: NOOP,
    onProjectSettings: NOOP,
    onReorderProjects: NOOP
  }
}

/**
 * The sidebar as the active lens draws it, on sample data or on the sidebar's real
 * data. Drawn by the tree view itself (header-less, read-only), so it can't drift
 * from the real thing.
 */
export function LensPreview({ className }: { className?: string }): React.JSX.Element {
  const [source, setSource] = useState<'mock' | 'real'>('mock')
  const snapshot = useSidebarSnapshot()
  const now = useNow(60_000)
  const real = source === 'real' && snapshot
  const ctx = real ? readOnly(snapshot) : mockContext(now)
  return (
    <div className={cn('flex min-h-0 flex-col gap-2', className)} data-testid="lens-preview">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">Preview</span>
        <span className="flex-1" />
        <div
          role="radiogroup"
          aria-label="Preview data"
          className="inline-flex rounded-md border border-border bg-input/30 p-0.5"
        >
          {(
            [
              ['mock', 'Mock data'],
              ['real', 'Real data']
            ] as const
          ).map(([v, l]) => (
            <button
              key={v}
              type="button"
              role="radio"
              aria-checked={source === v}
              onClick={() => setSource(v)}
              className={cn(
                'rounded px-2 py-0.5 text-xs transition-colors',
                source === v
                  ? 'bg-accent text-accent-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {l}
            </button>
          ))}
        </div>
      </div>
      <div className="h-[460px] overflow-hidden rounded-lg border border-border bg-sidebar py-2">
        {source === 'real' && !snapshot ? (
          <p className="px-4 py-8 text-center text-xs text-muted-foreground">
            Open the tree sidebar once to preview your own tasks.
          </p>
        ) : (
          <TreeView {...ctx} preview agentStates={real ? undefined : MOCK_AGENT_STATES} />
        )}
      </div>
    </div>
  )
}
