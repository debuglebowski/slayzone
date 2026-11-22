// @vitest-environment jsdom
// The project-wide agent panel lives in the app shell, under the DEFAULT hub's
// client. A project another hub owns (multi-hub federation) must start its agent
// on THAT hub: the default hub does not know the project, so it put the session on
// this machine's computer with the other hub's folder, which refused it ("path
// '/home/…' is outside the computer's allowedRoots", issue #183).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import type { Project } from '@slayzone/projects-contracts'
import type { GlobalAgentPanelState, AgentStatusState } from '@slayzone/agent-panels'

vi.mock('../trpc', () => ({
  useTRPC: () => ({
    app: {
      floatingAgent: {
        detach: { mutationOptions: () => ({ mutationFn: async () => {} }) },
        reattach: { mutationOptions: () => ({ mutationFn: async () => {} }) }
      }
    }
  })
}))
vi.mock('@tanstack/react-query', () => ({
  useMutation: () => ({ mutate: () => {} })
}))
vi.mock('@slayzone/transport/client', () => ({
  HubScope: ({ hubId, children }: { hubId: string; children: ReactNode }) => (
    <div data-testid={`hub-${hubId}`}>{children}</div>
  )
}))
vi.mock('@slayzone/agent-panels', () => ({
  GLOBAL_AGENT_PANEL_MIN_WIDTH: 200,
  GLOBAL_AGENT_PANEL_MAX_WIDTH: 800,
  DEFAULT_GLOBAL_AGENT_PANEL_WIDTH: 400,
  AGENT_STATUS_PANEL_MIN_WIDTH: 200,
  AGENT_STATUS_PANEL_MAX_WIDTH: 800,
  DEFAULT_AGENT_STATUS_PANEL_WIDTH: 300
}))
vi.mock('@slayzone/task/client/ResizeHandle', () => ({
  ResizeHandle: () => null
}))
vi.mock('./lazy', () => ({
  GlobalAgentSidePanel: ({ cwd }: { cwd: string }) => <div data-testid="global-agent">{cwd}</div>,
  AgentStatusSidePanel: () => null
}))

const { AppSidePanels } = await import('./AppSidePanels')

const project = {
  id: 'R',
  name: 'R',
  placements: [{ computer_id: 'remote-computer', path: '/home/ci/proj', status: 'ready' }],
  resolved_computer_id: 'remote-computer'
} as unknown as Project

function renderPanels(selectedProjectHubId: string): void {
  render(
    <AppSidePanels
      agentSessionId="__global-agent-panel:R:0"
      globalAgentPanelMounted
      hideSidebarPanel={false}
      globalAgentPanelState={{ isOpen: true, panelWidth: 400 } as GlobalAgentPanelState}
      setGlobalAgentPanelState={() => {}}
      isSidePanelResizing={false}
      setIsSidePanelResizing={() => {}}
      projects={[project]}
      selectedProjectId="R"
      selectedProjectHubId={selectedProjectHubId}
      agentMode="claude-code"
      handleAgentNewSession={() => {}}
      handleAgentModeChange={() => {}}
      floatingState="attached"
      agentStatusState={{ isLocked: false } as AgentStatusState}
      setAgentStatusState={() => {}}
      idleTasks={[]}
      openTask={() => {}}
      handleDismissIdle={() => {}}
      columnsByProjectId={new Map()}
    />
  )
}

afterEach(cleanup)

describe("the global agent panel runs on the project's own hub", () => {
  it("another hub's project: the panel's terminal is scoped to that hub", async () => {
    renderPanels('hub:wss://remote')
    const panel = await screen.findByTestId('global-agent')
    expect(screen.getByTestId('hub-hub:wss://remote').contains(panel)).toBe(true)
    expect(panel.textContent).toBe('/home/ci/proj')
  })
})
