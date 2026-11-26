import type { ReactNode } from 'react'
import { useFederationOrNull } from '@slayzone/transport/client'
import { DEFAULT_LOCAL_COMPUTER_NAME } from '@slayzone/platform/computer-identity'
import { capabilityNote, computerRowStatus } from '@slayzone/computers/labels'
import type { SettingsRoute } from '../settings-route'
import { useSettingsViewStore } from '../settings-view-store'
import { ComputerActionsProvider } from '../tabs/ComputerActions'
import { ComputerBackupList } from '../tabs/ComputerChatBackups'
import { ComputerFaults } from '../tabs/ComputerFaults'
import { ComputerFolders } from '../tabs/ComputerFolders'
import { ComputerName } from '../tabs/ComputerName'
import { ComputerUnattachedSessions } from '../tabs/ComputerUnattachedSessions'
import { MachineLabel } from '../tabs/MachineLabel'
import { ComputerActionButtons, useHubComputers } from '../tabs/hub-computers'
import { PageTabs } from './SettingsPages'
import { StatusDot } from './StatusDot'
import { useSoloLocalHub } from './SettingsNav'

type ComputerRoute = Extract<SettingsRoute, { kind: 'computer' }>

/**
 * A computer's page, inside its hub's scope. Same data and actions as its row on the
 * Hubs page (`useHubComputers` / `ComputerActionButtons`). Enrolling new computers
 * stays on the Hubs page: it is about the hub, not about one computer.
 */
export function ComputerPage({ route }: { route: ComputerRoute }) {
  return (
    <ComputerActionsProvider>
      <ComputerPageBody route={route} />
    </ComputerActionsProvider>
  )
}

function ComputerPageBody({ route }: { route: ComputerRoute }) {
  const navigate = useSettingsViewStore((s) => s.navigate)
  // The only hub is local: its one computer is just "This machine" (see `useSoloLocalHub`).
  const solo = !!useSoloLocalHub()
  const federation = useFederationOrNull()
  // Outside a federation the one hub is this app's own.
  const isLocalHub = federation
    ? federation.hubs.find((h) => h.id === route.hubId)?.kind === 'local'
    : true
  const hub = useHubComputers({ hubId: route.hubId, isLocalHub })
  const computer = hub.computers.find((c) => c.id === route.computerId)
  if (!computer) {
    return hub.computersQuery.isPending ? null : (
      <p className="text-sm text-muted-foreground">This computer is no longer on the hub.</p>
    )
  }
  const status = computerRowStatus(computer)
  const tabs: Array<[string, string]> = [
    ['general', 'General'],
    ['folders', 'Folders'],
    ['backups', 'Chat backups']
  ]
  const tab = tabs.some(([k]) => k === route.tab) ? route.tab : 'general'
  const capabilities = capabilityNote(computer.capabilities)
  const renamable = !(
    isLocalHub &&
    (hub.isOwnComputer(computer) || computer.name === DEFAULT_LOCAL_COMPUTER_NAME)
  )
  return (
    <div className="space-y-6" data-testid="settings-computer-page">
      <div className="space-y-1">
        <div className="text-xs text-muted-foreground">{solo ? 'Workspace' : 'Computer'}</div>
        <h1 className="text-2xl font-semibold tracking-tight">
          {solo ? 'This machine' : computer.name}
        </h1>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <StatusDot tone={status.tone} />
          {status.label}
          {status.detail && <span>· {status.detail}</span>}
        </div>
      </div>
      <PageTabs
        tabs={tabs}
        active={tab}
        onSelect={(t) => navigate({ ...route, tab: t })}
        testIdPrefix="computer-tab"
      />
      {tab === 'general' && (
        <div className="space-y-6">
          <ComputerFaults computerId={computer.id} />
          <ComputerUnattachedSessions computerId={computer.id} />
          <div className="divide-y rounded-lg border">
            <Row label="Name">
              <ComputerName computer={computer} renamable={renamable} />
            </Row>
            <Row label="Machine">
              <MachineLabel machine={computer.machine ?? null} />
            </Row>
            <Row label="Platform">
              <span className="font-mono text-xs text-muted-foreground">{computer.platform}</span>
            </Row>
            {capabilities && (
              <Row label="Capabilities">
                <span className="text-xs text-muted-foreground">{capabilities}</span>
              </Row>
            )}
          </div>
          <ComputerActionButtons computer={computer} hub={hub} labels />
        </div>
      )}
      {tab === 'folders' && <ComputerFolders computer={computer} />}
      {tab === 'backups' && (
        <ComputerBackupList computerId={computer.id} usable={computer.usable} />
      )}
    </div>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[160px_minmax(0,1fr)] items-center gap-4 px-4 py-3">
      <span className="text-sm">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  )
}
