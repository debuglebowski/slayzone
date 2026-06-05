import React, { Suspense, type ComponentProps, type Dispatch, type SetStateAction } from 'react'
import type { Project } from '@slayzone/projects/shared'
import type { TerminalMode } from '@slayzone/terminal/shared'
import { ResizeHandle } from '@slayzone/task/client/ResizeHandle'
import {
  GLOBAL_AGENT_PANEL_MIN_WIDTH,
  GLOBAL_AGENT_PANEL_MAX_WIDTH,
  DEFAULT_GLOBAL_AGENT_PANEL_WIDTH,
  type GlobalAgentPanelState
} from '@/components/global-agent-panel'
import {
  AGENT_STATUS_PANEL_MIN_WIDTH,
  AGENT_STATUS_PANEL_MAX_WIDTH,
  DEFAULT_AGENT_STATUS_PANEL_WIDTH,
  type AgentStatusState
} from '@/components/agent-status'
import { GlobalAgentSidePanel, AgentStatusSidePanel } from './lazy'

type GlobalAgentSidePanelProps = ComponentProps<typeof GlobalAgentSidePanel>
type AgentStatusSidePanelProps = ComponentProps<typeof AgentStatusSidePanel>

interface AppSidePanelsProps {
  agentSessionId: string | null
  globalAgentPanelMounted: boolean
  hideSidebarPanel: boolean
  globalAgentPanelState: GlobalAgentPanelState
  setGlobalAgentPanelState: (updates: Partial<GlobalAgentPanelState>) => void
  isSidePanelResizing: boolean
  setIsSidePanelResizing: Dispatch<SetStateAction<boolean>>
  projects: Project[]
  selectedProjectId: string
  agentMode: string
  handleAgentNewSession: GlobalAgentSidePanelProps['onNewSession']
  handleAgentModeChange: GlobalAgentSidePanelProps['onModeChange']
  floatingState: GlobalAgentSidePanelProps['floatingState']
  agentStatusState: AgentStatusState
  setAgentStatusState: (updates: Partial<AgentStatusState>) => void
  idleTasks: AgentStatusSidePanelProps['idleTasks']
  openTask: AgentStatusSidePanelProps['onNavigate']
  handleDismissIdle: AgentStatusSidePanelProps['onDismiss']
  columnsByProjectId: AgentStatusSidePanelProps['columnsByProjectId']
}

export function AppSidePanels({
  agentSessionId,
  globalAgentPanelMounted,
  hideSidebarPanel,
  globalAgentPanelState,
  setGlobalAgentPanelState,
  isSidePanelResizing,
  setIsSidePanelResizing,
  projects,
  selectedProjectId,
  agentMode,
  handleAgentNewSession,
  handleAgentModeChange,
  floatingState,
  agentStatusState,
  setAgentStatusState,
  idleTasks,
  openTask,
  handleDismissIdle,
  columnsByProjectId
}: AppSidePanelsProps): React.JSX.Element {
  return (
    <>
      {agentSessionId &&
        globalAgentPanelMounted &&
        globalAgentPanelState.isOpen &&
        !hideSidebarPanel && (
          <ResizeHandle
            // Edge side panel against the flex-1 main area. The boundary
            // handle needs two widths; model the left (main) side as
            // effectively unbounded so the drag just resizes this panel
            // and the flex-1 main absorbs the slack. 100_000 is large
            // enough that the left clamp never binds yet keeps the
            // `total - newLeft` arithmetic exact. Max is enforced here.
            leftWidth={100_000}
            rightWidth={globalAgentPanelState.panelWidth}
            leftMinWidth={0}
            rightMinWidth={GLOBAL_AGENT_PANEL_MIN_WIDTH}
            onResize={(_lw, rw) =>
              setGlobalAgentPanelState({
                panelWidth: Math.min(
                  GLOBAL_AGENT_PANEL_MAX_WIDTH,
                  Math.max(GLOBAL_AGENT_PANEL_MIN_WIDTH, rw)
                )
              })
            }
            onDragStart={() => setIsSidePanelResizing(true)}
            onDragEnd={() => setIsSidePanelResizing(false)}
            onReset={() =>
              setGlobalAgentPanelState({ panelWidth: DEFAULT_GLOBAL_AGENT_PANEL_WIDTH })
            }
          />
        )}
      {agentSessionId && globalAgentPanelMounted && !hideSidebarPanel && (
        <div
          className={
            globalAgentPanelState.isOpen ? 'min-h-0' : 'w-0 overflow-hidden invisible'
          }
          style={globalAgentPanelState.isOpen ? undefined : { position: 'absolute' as const }}
        >
          <Suspense fallback={null}>
            <GlobalAgentSidePanel
              width={globalAgentPanelState.panelWidth}
              sessionId={agentSessionId}
              cwd={projects.find((p) => p.id === selectedProjectId)?.path ?? ''}
              mode={agentMode as TerminalMode}
              isActive={globalAgentPanelState.isOpen}
              isResizing={isSidePanelResizing}
              onNewSession={handleAgentNewSession}
              onModeChange={handleAgentModeChange}
              floatingEnabled={globalAgentPanelState.floatingEnabled}
              onToggleFloating={() =>
                setGlobalAgentPanelState({
                  floatingEnabled: !globalAgentPanelState.floatingEnabled
                })
              }
              floatingState={floatingState}
              onDetach={() => window.api.floatingGlobalAgentPanel.detach()}
              onReattach={() => window.api.floatingGlobalAgentPanel.reattach()}
            />
          </Suspense>
        </div>
      )}
      {agentStatusState.isLocked && (
        <ResizeHandle
          // Edge side panel — left side modeled as unbounded (see the
          // GlobalAgentSidePanel handle above); max enforced here.
          leftWidth={100_000}
          rightWidth={agentStatusState.panelWidth}
          leftMinWidth={0}
          rightMinWidth={AGENT_STATUS_PANEL_MIN_WIDTH}
          onResize={(_lw, rw) =>
            setAgentStatusState({
              panelWidth: Math.min(
                AGENT_STATUS_PANEL_MAX_WIDTH,
                Math.max(AGENT_STATUS_PANEL_MIN_WIDTH, rw)
              )
            })
          }
          onDragStart={() => setIsSidePanelResizing(true)}
          onDragEnd={() => setIsSidePanelResizing(false)}
          onReset={() => setAgentStatusState({ panelWidth: DEFAULT_AGENT_STATUS_PANEL_WIDTH })}
        />
      )}
      {agentStatusState.isLocked && (
        <Suspense fallback={null}>
          <AgentStatusSidePanel
            width={agentStatusState.panelWidth}
            idleTasks={idleTasks}
            filterCurrentProject={agentStatusState.filterCurrentProject}
            onFilterToggle={() =>
              setAgentStatusState({
                filterCurrentProject: !agentStatusState.filterCurrentProject
              })
            }
            onNavigate={openTask}
            onDismiss={handleDismissIdle}
            columnsByProjectId={columnsByProjectId}
            selectedProjectId={selectedProjectId}
            currentProjectName={projects.find((p) => p.id === selectedProjectId)?.name}
          />
        </Suspense>
      )}
    </>
  )
}
