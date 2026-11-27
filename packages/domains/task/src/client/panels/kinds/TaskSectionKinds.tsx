import type { ReactNode } from 'react'
import { Expand } from 'lucide-react'
import { IconButton, Tooltip, TooltipContent, TooltipTrigger } from '@slayzone/ui'
import { PANEL_KINDS } from '../registry'
import { PanelFrame } from '../PanelFrame'
import { useTaskPageContext } from '../TaskPageContext'
import { DescriptionEditor, DetailsBody, SubtasksList, useSubtaskProgress } from './taskSections'
import type { PanelKindProps } from './types'

/**
 * Description, Subtasks and Details on their own (docs/plans/panel-model.md step
 * 12): one of the Settings panel's cards as a panel, the same body Settings shows
 * (./taskSections). One each per task.
 */

function SectionHeader({
  kind,
  aside
}: {
  kind: 'description' | 'subtasks' | 'details'
  aside?: ReactNode
}): React.JSX.Element {
  const def = PANEL_KINDS[kind]
  return (
    // h-10 matches the other panels' tab bars.
    <div className="shrink-0 flex items-center h-10 px-3 gap-1.5 border-b border-border text-xs font-medium text-muted-foreground">
      <def.icon className="size-3.5 shrink-0" />
      <span className="truncate">{def.label}</span>
      <div className="ml-auto flex items-center gap-0.5">{aside}</div>
    </div>
  )
}

export function DescriptionKind({ panelId }: PanelKindProps): React.JSX.Element {
  const { settings } = useTaskPageContext()
  return (
    <PanelFrame
      kind="description"
      panelId={panelId}
      testId="task-description-panel"
      className="overflow-hidden flex flex-col"
    >
      <SectionHeader
        kind="description"
        aside={
          <Tooltip>
            <TooltipTrigger asChild>
              <IconButton
                type="button"
                variant="ghost"
                aria-label="Fullscreen"
                className="size-6 text-muted-foreground hover:text-foreground"
                onClick={() => settings.setDescriptionFullscreen(true)}
              >
                <Expand size={12} />
              </IconButton>
            </TooltipTrigger>
            <TooltipContent>Fullscreen</TooltipContent>
          </Tooltip>
        }
      />
      <div className="flex-1 min-h-0 flex flex-col overflow-y-auto">
        <DescriptionEditor testId="task-description-panel-editor" />
      </div>
    </PanelFrame>
  )
}

export function SubtasksKind({ panelId }: PanelKindProps): React.JSX.Element {
  const progress = useSubtaskProgress()
  return (
    <PanelFrame
      kind="subtasks"
      panelId={panelId}
      testId="task-subtasks-panel"
      className="overflow-hidden flex flex-col"
    >
      <SectionHeader
        kind="subtasks"
        aside={progress && <span className="text-[10px] text-muted-foreground/60">{progress}</span>}
      />
      <div className="flex-1 min-h-0 flex flex-col p-2">
        <SubtasksList />
      </div>
    </PanelFrame>
  )
}

export function DetailsKind({ panelId }: PanelKindProps): React.JSX.Element {
  return (
    <PanelFrame
      kind="details"
      panelId={panelId}
      testId="task-details-panel"
      className="overflow-hidden flex flex-col"
    >
      <SectionHeader kind="details" />
      <div className="flex-1 min-h-0 overflow-y-auto p-3">
        <DetailsBody />
      </div>
    </PanelFrame>
  )
}
