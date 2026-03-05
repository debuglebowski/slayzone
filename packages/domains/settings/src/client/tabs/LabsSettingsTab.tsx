import { useState, useEffect } from 'react'
import { Label, Switch } from '@slayzone/ui'
import { SettingsTabIntro } from './SettingsTabIntro'

export function LabsSettingsTab() {
  const [leaderboardEnabled, setLeaderboardEnabled] = useState(false)

  useEffect(() => {
    window.api.settings.get('leaderboard_enabled').then(val => setLeaderboardEnabled(val === '1'))
  }, [])

  return (
    <div className="space-y-6">
      <SettingsTabIntro
        title="Labs"
        description="Try in-progress features before they are fully released. Expect behavior and UI details to evolve over time."
      />
      <div className="space-y-3">
        <Label className="text-base font-semibold">Experimental Features</Label>
        <p className="text-sm text-muted-foreground">These features are in development and may change.</p>
      </div>
      <div className="rounded-lg border p-4 space-y-4">
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label htmlFor="leaderboard-toggle">Leaderboard</Label>
            <p className="text-xs text-muted-foreground">Show leaderboard tab with token usage stats</p>
          </div>
          <Switch
            id="leaderboard-toggle"
            checked={leaderboardEnabled}
            onCheckedChange={async (checked) => {
              setLeaderboardEnabled(checked)
              await window.api.settings.set('leaderboard_enabled', checked ? '1' : '0')
            }}
          />
        </div>
      </div>
    </div>
  )
}
