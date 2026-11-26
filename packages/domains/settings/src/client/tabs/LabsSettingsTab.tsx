import { useState } from 'react'
import { getClientHost, useClientSettings } from '@slayzone/transport/client'
import type { LabFlag } from '@slayzone/platform/client-host'
import { Label, Switch } from '@slayzone/ui'
import { SettingsTabIntro } from './SettingsTabIntro'

const LABS_FEATURES: ReadonlyArray<{
  key: LabFlag
  /** Element id (kept from the hub-key era; e2e selects by it). */
  id: string
  label: string
  description: string
}> = [
  {
    key: 'testsPanel',
    id: 'labs_tests_panel',
    label: 'Tests Panel',
    description: 'Show test computer panel in the home tab'
  },
  {
    key: 'loopMode',
    id: 'labs_loop_mode',
    label: 'Loop Command',
    description: 'Repeat a prompt until acceptance criteria are met'
  }
]

export function LabsSettingsTab() {
  // Labs flags are this device's own (they gate native menu items built before any
  // hub exists): the client host keeps them in client.config.json, and every window
  // hears the change (`settings-changed`) — never a hub row.
  const labs = useClientSettings()?.labs
  // A local toggle shows at once; the host's next snapshot re-seeds it.
  const [pending, setPending] = useState<Partial<Record<LabFlag, boolean>>>({})
  const [seenLabs, setSeenLabs] = useState(labs)
  if (labs !== seenLabs) {
    setSeenLabs(labs)
    setPending({})
  }

  return (
    <div className="space-y-6">
      <SettingsTabIntro
        title="Labs"
        description="Try in-progress features before they are fully released. Expect behavior and UI details to evolve over time."
      />
      <div className="space-y-6">
        {LABS_FEATURES.map((f) => (
          <div key={f.key} className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor={f.id}>{f.label}</Label>
              <p className="text-xs text-muted-foreground">{f.description}</p>
            </div>
            <Switch
              id={f.id}
              checked={pending[f.key] ?? labs?.[f.key] ?? false}
              onCheckedChange={async (checked) => {
                setPending((prev) => ({ ...prev, [f.key]: checked }))
                await getClientHost().call('labs.set', f.key, checked)
              }}
            />
          </div>
        ))}
      </div>
    </div>
  )
}
