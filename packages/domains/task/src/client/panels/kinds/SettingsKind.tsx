import { ChevronRight, Expand, MoveVertical, Paperclip, Plus } from 'lucide-react'
import { getExtensionFromTitle } from '@slayzone/task-contracts'
import {
  cn,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  IconButton,
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from '@slayzone/ui'
import { TaskSettingsPanel } from '../../TaskSettingsPanel'
import { getTaskPanels } from '../registry'
import { PanelFrame } from '../PanelFrame'
import { useTaskPageContext } from '../TaskPageContext'
import { DescriptionEditor, DetailsBody, SubtasksList, useSubtaskProgress } from './taskSections'
import type { PanelKindProps } from './types'

/**
 * The task's settings (`settings`): external sync links, the Description /
 * Sub-tasks / Artifacts cards and Details (metadata, working directory, danger zone).
 * The cards' bodies are shared with the Description / Subtasks / Details panels
 * (./taskSections); only here do open cards share the height (useSharedCardHeights).
 */
export function SettingsKind({ panelId }: PanelKindProps): React.JSX.Element {
  const { task, handleTaskUpdate, settings } = useTaskPageContext()
  const {
    settingsCardsGridRef,
    settingsCols,
    descFullHeight,
    descriptionOpen,
    setDescriptionOpen,
    descriptionExpanded,
    setDescriptionExpanded,
    subTasksOpen,
    setSubTasksOpen,
    artifactsOpen,
    setArtifactsOpen,
    detailsOpen,
    setDetailsOpen,
    setDescriptionFullscreen,
    artifacts,
    selectArtifactInPanel,
    createArtifactInPanel
  } = settings
  const subtaskProgress = useSubtaskProgress()
  const { ExternalSyncCard } = getTaskPanels()

  // Built OUTSIDE the frame's JSX, so the compiler memoizes it on its own inputs:
  // the frame re-renders on every tab switch (`isActive`), this panel must not.
  const taskSettingsPanel = (
    <TaskSettingsPanel
      taskId={task.id}
      renderDefaultContent={() => {
        // The grid holds Description / Sub-tasks / Artifacts (and, in
        // full-height, Details). Open cards SHARE the available height via
        // useSharedCardHeights: each hugs its content, tall cards cap at a
        // shared water-level and scroll internally, short neighbours' unused
        // space flows to the tall ones, and nothing is squeezed below 9rem
        // by sharing alone (the grid scrolls instead). `grid-template-rows`
        // is set imperatively by the hook — keep none here.
        //
        // Details (task metadata + working dir + danger zone) renders in two
        // places depending on mode: pinned at the bottom of the panel in
        // normal mode (always shown, unshrinkable), or as a 4th card INSIDE
        // the grid in full-height mode (collapsible, shares space via the
        // water-fill). Body is shared via this const.
        const detailsBody = <DetailsBody />
        // Layout tier from the panel's resolved width: 1 column (stacked, as
        // before), 2 (Description | cards + Details), 3 (Description | cards |
        // Details). Multi-column gives Description its own full-height column.
        const descriptionCard = (
          <Collapsible
            data-testid="settings-description-card"
            data-card
            data-card-open={descriptionOpen}
            open={descriptionOpen}
            onOpenChange={setDescriptionOpen}
            className={cn(
              'flex flex-col rounded-md border border-border overflow-hidden min-h-0',
              settingsCols > 1 && descriptionOpen && 'flex-1'
            )}
          >
            <div
              className={cn(
                'flex w-full items-center gap-1.5 bg-muted/50 px-2.5 py-1.5 text-xs font-medium text-muted-foreground',
                descriptionOpen && 'border-b border-border'
              )}
            >
              <CollapsibleTrigger className="flex flex-1 items-center gap-1.5 hover:text-foreground transition-colors [&[data-state=open]>svg:first-child]:rotate-90">
                <ChevronRight className="size-3 transition-transform" />
                Description
              </CollapsibleTrigger>
              <div className="ml-auto flex items-center gap-0.5">
                {/* Multi-column: Description already owns a full-height column */}
                {settingsCols === 1 && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <IconButton
                        type="button"
                        variant="ghost"
                        aria-label={descriptionExpanded ? 'Default height' : 'Full height'}
                        className={cn(
                          'size-5 hover:text-foreground',
                          descriptionExpanded ? 'text-foreground bg-muted' : 'text-muted-foreground'
                        )}
                        onClick={() =>
                          setDescriptionExpanded((v) => {
                            if (!v) {
                              setDetailsOpen(false)
                              setSubTasksOpen(false)
                              setArtifactsOpen(false)
                            } else {
                              setDetailsOpen(true)
                              setSubTasksOpen(true)
                              setArtifactsOpen(true)
                            }
                            return !v
                          })
                        }
                      >
                        <MoveVertical size={12} />
                      </IconButton>
                    </TooltipTrigger>
                    <TooltipContent>
                      {descriptionExpanded ? 'Default height' : 'Full height'}
                    </TooltipContent>
                  </Tooltip>
                )}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <IconButton
                      type="button"
                      variant="ghost"
                      aria-label="Fullscreen"
                      className="size-5 text-muted-foreground hover:text-foreground"
                      onClick={() => setDescriptionFullscreen(true)}
                    >
                      <Expand size={12} />
                    </IconButton>
                  </TooltipTrigger>
                  <TooltipContent>Fullscreen</TooltipContent>
                </Tooltip>
              </div>
            </div>
            {descriptionOpen && (
              <div className="flex flex-col min-h-0 flex-1">
                <DescriptionEditor />
              </div>
            )}
          </Collapsible>
        )
        const cardsGrid = (
          <div
            ref={settingsCardsGridRef}
            data-testid="settings-cards-grid"
            className="flex-1 min-h-0 overflow-hidden grid gap-4 content-start"
          >
            {settingsCols === 1 && descriptionCard}
            {/* Sub-tasks */}
            <Collapsible
              data-testid="settings-subtasks-card"
              data-card
              data-card-open={subTasksOpen}
              open={subTasksOpen}
              onOpenChange={setSubTasksOpen}
              className="group/sub rounded-md border border-border overflow-hidden flex flex-col min-h-0"
            >
              <CollapsibleTrigger className="shrink-0 flex w-full items-center gap-1.5 bg-muted/50 px-2.5 py-1.5 min-h-8 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors group-data-[state=open]/sub:border-b border-border [&[data-state=open]>svg:first-child]:rotate-90">
                <ChevronRight className="size-3 transition-transform" />
                Sub-tasks
                {subtaskProgress && (
                  <span className="ml-auto text-muted-foreground/60 text-[10px]">
                    {subtaskProgress}
                  </span>
                )}
              </CollapsibleTrigger>
              <CollapsibleContent className="p-2 flex flex-col flex-1 min-h-0">
                <SubtasksList />
              </CollapsibleContent>
            </Collapsible>

            {/* Artifacts */}
            <Collapsible
              data-testid="settings-artifacts-card"
              data-card
              data-card-open={artifactsOpen}
              open={artifactsOpen}
              onOpenChange={setArtifactsOpen}
              className="group/artifacts rounded-md border border-border overflow-hidden flex flex-col min-h-0"
            >
              <CollapsibleTrigger className="flex w-full items-center gap-1.5 bg-muted/50 px-2.5 py-1.5 min-h-8 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors group-data-[state=open]/artifacts:border-b border-border [&[data-state=open]>svg:first-child]:rotate-90">
                <ChevronRight className="size-3 transition-transform" />
                Artifacts
                {artifacts.length > 0 && (
                  <span className="ml-auto text-muted-foreground/60 text-[10px]">
                    {artifacts.length}
                  </span>
                )}
              </CollapsibleTrigger>
              <CollapsibleContent className="p-2 flex flex-col flex-1 min-h-0">
                <div
                  data-card-scroll
                  className="flex flex-col gap-0.5 flex-1 min-h-0 overflow-y-auto overscroll-contain"
                >
                  {artifacts.map((artifact) => (
                    <button
                      key={artifact.id}
                      type="button"
                      className="flex items-center gap-2 py-1 px-1 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 text-left"
                      onClick={() => selectArtifactInPanel(artifact.id)}
                    >
                      <Paperclip className="size-3 shrink-0" />
                      <span className="truncate">{artifact.title}</span>
                      <span className="ml-auto text-[10px] opacity-60">
                        {getExtensionFromTitle(artifact.title) || 'file'}
                      </span>
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={createArtifactInPanel}
                    className="flex items-center gap-1.5 py-1 px-1 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 mt-1"
                  >
                    <Plus className="size-3" />
                    Add artifact
                  </button>
                </div>
              </CollapsibleContent>
            </Collapsible>
            {/* Details — in full-height mode this becomes a 4th card that
                shares the grid via the water-fill (collapsed by default
                when entering full-height). */}
            {descFullHeight && (
              <Collapsible
                data-testid="settings-details-card"
                data-card
                data-card-open={detailsOpen}
                open={detailsOpen}
                onOpenChange={setDetailsOpen}
                className="group/details rounded-md border border-border overflow-hidden flex flex-col min-h-0"
              >
                <CollapsibleTrigger className="shrink-0 flex w-full items-center gap-1.5 bg-muted/50 px-2.5 py-1.5 min-h-8 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors group-data-[state=open]/details:border-b border-border [&[data-state=open]>svg:first-child]:rotate-90">
                  <ChevronRight className="size-3 transition-transform" />
                  Details
                </CollapsibleTrigger>
                <CollapsibleContent className="flex flex-col flex-1 min-h-0">
                  <div data-card-scroll className="flex-1 min-h-0 overflow-y-auto p-2.5">
                    {detailsBody}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            )}
          </div>
        )
        return (
          <>
            {/* External sync links — pinned above the cards */}
            <ExternalSyncCard taskId={task.id} onUpdate={handleTaskUpdate} />

            {settingsCols === 1 ? (
              <>
                {/* Cards grid: flex-1 min-h-0 → height is the spare space
                  between ExternalSync and the pinned Details (definite, so
                  the water-level caps resolve). useSharedCardHeights also sets
                  a min-height = floored content, so a short window scrolls the
                  PANEL (keeping cards usable) instead of crushing them; the
                  grid itself never overflows. content-start → short cards leave
                  the leftover as empty space above the pinned meta. */}
                {cardsGrid}

                {/* Details — normal mode: pinned at the bottom of the panel,
                  always visible, never shrinks. */}
                {!descFullHeight && (
                  <div data-testid="settings-details-pinned" className="shrink-0 mt-auto">
                    {detailsBody}
                  </div>
                )}
              </>
            ) : (
              <div
                data-testid="settings-columns"
                data-columns={settingsCols}
                className="flex-1 min-h-0 flex gap-4"
              >
                <div className="flex-1 min-w-0 min-h-0 flex flex-col">{descriptionCard}</div>
                <div className="flex-1 min-w-0 min-h-0 flex flex-col gap-4">
                  {cardsGrid}
                  {settingsCols === 2 && (
                    <div data-testid="settings-details-pinned" className="shrink-0 mt-auto">
                      {detailsBody}
                    </div>
                  )}
                </div>
                {settingsCols === 3 && (
                  <div
                    data-testid="settings-details-column"
                    className="flex-1 min-w-0 min-h-0 overflow-y-auto"
                  >
                    {detailsBody}
                  </div>
                )}
              </div>
            )}
          </>
        )
      }}
    />
  )

  return (
    <PanelFrame
      kind="settings"
      panelId={panelId}
      testId="task-settings-panel"
      className="p-3 flex flex-col gap-4 overflow-y-auto"
    >
      {taskSettingsPanel}
    </PanelFrame>
  )
}
