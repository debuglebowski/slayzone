import { useState, useEffect } from 'react'
import { Input, Label, Tooltip, TooltipTrigger, TooltipContent } from '@slayzone/ui'
import { SettingsTabIntro } from './SettingsTabIntro'

export function GeneralSettingsTab() {
  const [worktreeBasePath, setWorktreeBasePath] = useState('')
  const [autoCreateWorktreeOnTaskCreate, setAutoCreateWorktreeOnTaskCreate] = useState(false)
  const [mcpPort, setMcpPort] = useState('45678')

  useEffect(() => {
    window.api.settings.get('worktree_base_path').then(val => setWorktreeBasePath(val ?? ''))
    window.api.settings.get('auto_create_worktree_on_task_create').then(val => setAutoCreateWorktreeOnTaskCreate(val === '1'))
    window.api.settings.get('mcp_server_port').then(val => setMcpPort(val ?? '45678'))
  }, [])

  return (
    <>
      <SettingsTabIntro
        title="General"
        description="Configure workspace-level behavior such as git worktree defaults and MCP server settings used by local tooling."
      />
      <div className="space-y-3">
        <Label className="text-base font-semibold">Git</Label>
        <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-sm cursor-default">Worktree base path</span>
            </TooltipTrigger>
            <TooltipContent side="right" className="max-w-64">
              Where git worktrees are created when starting a task on a new branch. Use {'{project}'} as a placeholder for the project directory.
            </TooltipContent>
          </Tooltip>
          <Input
            className="w-full max-w-lg"
            placeholder="{project}/.."
            value={worktreeBasePath}
            onChange={(e) => setWorktreeBasePath(e.target.value)}
            onBlur={() => {
              window.api.settings.set('worktree_base_path', worktreeBasePath.trim())
            }}
          />
        </div>
        <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
          <span className="text-sm">Auto-create worktree</span>
          <label className="inline-flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={autoCreateWorktreeOnTaskCreate}
              onChange={(e) => {
                const enabled = e.target.checked
                setAutoCreateWorktreeOnTaskCreate(enabled)
                window.api.settings.set(
                  'auto_create_worktree_on_task_create',
                  enabled ? '1' : '0'
                )
              }}
            />
            <span>Create worktree for every new task</span>
          </label>
        </div>
        <p className="text-xs text-muted-foreground">
          Use {'{project}'} as a token. Leave empty to use {'{project}/..'}.
          Project settings can override auto-create behavior.
        </p>
      </div>

      <div className="space-y-3">
        <Label className="text-base font-semibold">MCP Server</Label>
        <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
          <span className="text-sm">Port</span>
          <Input
            className="w-full max-w-[120px]"
            type="number"
            placeholder="45678"
            value={mcpPort}
            onChange={(e) => setMcpPort(e.target.value)}
            onBlur={() => {
              const port = parseInt(mcpPort, 10)
              if (port >= 1024 && port <= 65535) {
                window.api.settings.set('mcp_server_port', String(port))
              }
            }}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          Restart required after changing. Default: 45678
        </p>
      </div>
    </>
  )
}
