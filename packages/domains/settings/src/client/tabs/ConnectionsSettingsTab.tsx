import { ServerSettingsTab } from './ServerSettingsTab'
import { HubsSettingsTab } from './HubsSettingsTab'
import { FleetSettingsTab } from './FleetSettingsTab'

/**
 * Connections — one settings tab combining everything about where SlayZone's
 * backend runs and what execution nodes it reaches:
 *  - Server: run the backend embedded (Local) or point this app at one remote
 *    hub (single-hub mode).
 *  - Hubs: connect to multiple full-data hubs at once (federation) + pick the
 *    default hub for new projects.
 *  - Fleet: enroll runner exec nodes that a hub dials work out to.
 *
 * They share the "how is this client wired to backends" concern, so they live in
 * one tab (per product decision). Each pane keeps its own component + logic —
 * this is a composition, not a merge — separated by labeled dividers so the
 * three distinct axes stay legible.
 */
export function ConnectionsSettingsTab() {
  return (
    <div className="space-y-10">
      <ServerSettingsTab />
      <div className="border-border border-t" />
      <HubsSettingsTab />
      <div className="border-border border-t" />
      <FleetSettingsTab />
    </div>
  )
}
