import { useState, useEffect } from 'react'
import { Input, Label } from '@slayzone/ui'
import { SettingsTabIntro } from './SettingsTabIntro'

export function McpSettingsTab() {
  const [preferredPort, setPreferredPort] = useState('')
  const [actualPort, setActualPort] = useState('')

  useEffect(() => {
    window.api.settings.get('mcp_preferred_port').then(val => setPreferredPort(val ?? ''))
    window.api.settings.get('mcp_server_port').then(val => setActualPort(val ?? ''))
  }, [])

  return (
    <>
      <SettingsTabIntro
        title="MCP"
        description="Configure the MCP server used by local tooling."
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
    </>
  )
}
