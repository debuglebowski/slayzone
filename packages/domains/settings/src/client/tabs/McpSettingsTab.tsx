import { useState, useEffect } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import { useTRPC } from '@slayzone/transport/client'
import { Input, Label } from '@slayzone/ui'
import { SettingsTabIntro } from './SettingsTabIntro'

export function McpSettingsTab() {
  const trpc = useTRPC()
  const [preferredPort, setPreferredPort] = useState('')
  const [actualPort, setActualPort] = useState('')

  const preferredPortQuery = useQuery(
    trpc.settings.get.queryOptions({ key: 'mcp_preferred_port' })
  )
  const actualPortQuery = useQuery(trpc.settings.get.queryOptions({ key: 'server_port' }))
  const setSettingMutation = useMutation(trpc.settings.set.mutationOptions())

  useEffect(() => {
    if (preferredPortQuery.data !== undefined) setPreferredPort(preferredPortQuery.data ?? '')
  }, [preferredPortQuery.data])

  useEffect(() => {
    if (actualPortQuery.data !== undefined) setActualPort(actualPortQuery.data ?? '')
  }, [actualPortQuery.data])

  return (
    <>
      <SettingsTabIntro title="MCP" description="Configure the MCP server used by local tooling." />

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
                setSettingMutation.mutate({
                  key: 'mcp_preferred_port',
                  value: preferredPort === '' ? '' : String(port)
                })
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
