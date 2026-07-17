import { HubsSettingsTab } from './HubsSettingsTab'
import { RunnersSettingsTab } from './RunnersSettingsTab'

/**
 * Connections — one settings tab for how this client is wired to backends:
 *  - Hubs: run a local hub and/or connect to remote full-data hubs (each owns
 *    its own data); pick the default hub; sign in to authed hubs. This absorbs
 *    the former Server tab — "Run a local hub" is the old Local/Remote choice,
 *    and restarting the embedded backend lives here too.
 *  - Runner: enroll runner exec nodes that a hub dials work out to (a different
 *    axis — runners belong to a hub; they are not hubs).
 *
 * A composition, not a merge — each pane keeps its own component + logic,
 * separated by a divider.
 */
export function ConnectionsSettingsTab() {
  return (
    <div className="space-y-10">
      <HubsSettingsTab />
      <div className="border-border border-t" />
      <RunnersSettingsTab />
    </div>
  )
}
