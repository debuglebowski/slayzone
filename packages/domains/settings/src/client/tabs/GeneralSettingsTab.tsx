import { useState, useEffect } from 'react'
import { Input, Label, Switch } from '@slayzone/ui'
import { SettingsTabIntro } from './SettingsTabIntro'
import { useTabStore } from '../useTabStore'

export function GeneralSettingsTab() {
  const [preferredPort, setPreferredPort] = useState('')
  const [actualPort, setActualPort] = useState('')
  const [leaderboardEnabled, setLeaderboardEnabled] = useState(true)

  useEffect(() => {
    window.api.settings.get('mcp_preferred_port').then(val => setPreferredPort(val ?? ''))
    window.api.settings.get('mcp_server_port').then(val => setActualPort(val ?? ''))
    window.api.settings.get('leaderboard_enabled').then(val => setLeaderboardEnabled(val !== '0'))
  }, [])

  return (
    <>
      <SettingsTabIntro
        title="General"
        description="Configure workspace-level behavior such as MCP server settings used by local tooling."
      />

      <div className="space-y-3">
        <Label className="text-base font-semibold">MCP Server</Label>
        <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
          <span className="text-sm">Preferred port</span>
          <Input
            className="w-full max-w-[120px]"
            type="number"
            placeholder="auto"
            value={preferredPort}
            onChange={(e) => setPreferredPort(e.target.value)}
            onBlur={() => {
              const port = parseInt(preferredPort, 10)
              if (preferredPort === '' || (port >= 1024 && port <= 65535)) {
                window.api.settings.set('mcp_preferred_port', preferredPort === '' ? '' : String(port))
              }
            }}
          />
          <span className="text-sm">Active port</span>
          <span className="text-sm text-muted-foreground">{actualPort || 'not running'}</span>
        </div>
        <p className="text-xs text-muted-foreground">
          Leave empty for automatic. Restart required after changing.
        </p>
      </div>

      <div className="space-y-3">
        <Label className="text-base font-semibold">Other</Label>
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label htmlFor="leaderboard_enabled">Show leaderboard tab</Label>
            <p className="text-xs text-muted-foreground">Display the leaderboard tab in the sidebar</p>
          </div>
          <Switch
            id="leaderboard_enabled"
            checked={leaderboardEnabled}
            onCheckedChange={async (checked) => {
              setLeaderboardEnabled(checked)
              await window.api.settings.set('leaderboard_enabled', checked ? '1' : '0')
              if (!checked && useTabStore.getState().activeView === 'leaderboard') {
                useTabStore.getState().setActiveView('tabs')
              }
            }}
          />
        </div>
      </div>
    </>
  )
}
