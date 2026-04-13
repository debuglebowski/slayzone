import { useCallback, useEffect, useState } from 'react'
import { Plus, Trash2, Lock, Server } from 'lucide-react'
import { Button, Input } from '@slayzone/ui'
import { PROVIDER_LABELS } from '../shared/provider-registry'
import type { CliProvider, McpConfigFileResult } from '../shared'

export function ComputerMcpView() {
  const [configs, setConfigs] = useState<McpConfigFileResult[]>([])
  const [loading, setLoading] = useState(true)
  const [addingTo, setAddingTo] = useState<CliProvider | null>(null)
  const [newServerKey, setNewServerKey] = useState('')
  const [newServerCommand, setNewServerCommand] = useState('')
  const [newServerArgs, setNewServerArgs] = useState('')

  const loadConfigs = useCallback(async () => {
    setLoading(true)
    try {
      setConfigs(await window.api.aiConfig.discoverComputerMcpConfigs())
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void loadConfigs() }, [loadConfigs])

  const handleAddServer = useCallback(async (provider: CliProvider) => {
    if (!newServerKey.trim() || !newServerCommand.trim()) return
    await window.api.aiConfig.writeComputerMcpServer({
      provider,
      serverKey: newServerKey.trim(),
      config: {
        command: newServerCommand.trim(),
        args: newServerArgs.trim() ? newServerArgs.split(/\s+/) : [],
      },
    })
    setAddingTo(null)
    setNewServerKey('')
    setNewServerCommand('')
    setNewServerArgs('')
    void loadConfigs()
  }, [newServerKey, newServerCommand, newServerArgs, loadConfigs])

  const handleRemoveServer = useCallback(async (provider: CliProvider, serverKey: string) => {
    await window.api.aiConfig.removeComputerMcpServer({ provider, serverKey })
    void loadConfigs()
  }, [loadConfigs])

  if (loading) {
    return <p className="text-xs text-muted-foreground">Loading computer MCP configs...</p>
  }

  return (
    <div className="space-y-4 max-w-3xl">
      <div>
        <h3 className="text-sm font-semibold">Computer MCP Servers</h3>
        <p className="text-xs text-muted-foreground">
          MCP servers configured in your home directory. These apply to every project on this computer.
        </p>
      </div>

      {configs.map((config) => {
        const serverEntries = Object.entries(config.servers).sort(([a], [b]) => a.localeCompare(b))
        const isAdding = addingTo === config.provider

        return (
          <div key={config.provider} className="rounded-lg border bg-surface-3">
            <div className="flex items-center gap-2 border-b px-3 py-2">
              <Server className="size-3.5 text-muted-foreground" />
              <span className="text-sm font-medium">
                {PROVIDER_LABELS[config.provider as CliProvider] ?? config.provider}
              </span>
              {!config.writable && (
                <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                  <Lock className="size-2.5" /> Read-only
                </span>
              )}
              {!config.exists && (
                <span className="text-[10px] text-muted-foreground">(no config file)</span>
              )}
              {config.writable && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto h-6 text-xs"
                  onClick={() => setAddingTo(isAdding ? null : config.provider as CliProvider)}
                >
                  <Plus className="size-3 mr-1" />
                  Add
                </Button>
              )}
            </div>

            <div className="divide-y">
              {serverEntries.map(([key, srv]) => (
                <div key={key} className="flex items-center gap-3 px-3 py-2">
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium">{key}</p>
                    <p className="text-[10px] text-muted-foreground font-mono truncate">
                      {srv.command} {srv.args?.join(' ')}
                    </p>
                  </div>
                  {config.writable && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
                      onClick={() => handleRemoveServer(config.provider as CliProvider, key)}
                    >
                      <Trash2 className="size-3" />
                    </Button>
                  )}
                </div>
              ))}
              {serverEntries.length === 0 && (
                <p className="px-3 py-2 text-xs text-muted-foreground">No servers configured</p>
              )}
            </div>

            {isAdding && (
              <div className="border-t p-3 space-y-2">
                <Input
                  value={newServerKey}
                  onChange={(e) => setNewServerKey(e.target.value)}
                  placeholder="Server name"
                  className="h-7 text-xs"
                />
                <Input
                  value={newServerCommand}
                  onChange={(e) => setNewServerCommand(e.target.value)}
                  placeholder="Command (e.g., npx)"
                  className="h-7 text-xs"
                />
                <Input
                  value={newServerArgs}
                  onChange={(e) => setNewServerArgs(e.target.value)}
                  placeholder="Args (space-separated)"
                  className="h-7 text-xs"
                />
                <div className="flex gap-2">
                  <Button size="sm" className="h-7 text-xs" onClick={() => handleAddServer(config.provider as CliProvider)}>
                    Add Server
                  </Button>
                  <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setAddingTo(null)}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
