import { HubsSettingsTab } from './HubsSettingsTab'
import { SettingsTabIntro } from './SettingsTabIntro'

/**
 * Connections — one settings tab for how this client is wired to backends.
 *
 * Hubs and computers used to be two sibling tables here, which represented a strict
 * containment as a foreign key: a computer belongs to exactly ONE hub, fixed when
 * its enrollment token is minted. They are now ONE list — each hub's computers are
 * listed inside that hub's row — so the enrollment affordance's position is the
 * hub choice, and no picker is needed.
 *
 * This file is the intro plus that list; the hub rows (and the nested computer
 * blocks) live in `HubsSettingsTab`.
 */
export function ConnectionsSettingsTab() {
  return (
    <div className="space-y-6">
      <SettingsTabIntro
        title="Connections"
        description="Where SlayZone's backend runs, and which machines execute its work. Each hub owns its own projects and tasks, shown together in one rail — pick a default for new projects. Computers are the machines a hub dials work out to; enroll them on the hub they belong to, then bind a project or task to one to run its work there."
      />
      <HubsSettingsTab />
    </div>
  )
}
