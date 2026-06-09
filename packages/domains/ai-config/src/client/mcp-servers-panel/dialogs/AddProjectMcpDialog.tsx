import { useEffect, useState } from 'react'
import { useTRPCClient } from '@slayzone/transport/client'
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Label
} from '@slayzone/ui'
import type { McpTarget } from '../../../shared'
import { buildConfig, loadCustomServers, PROVIDER_LABELS, saveCustomServers } from '../mcp-helpers'
import type { CustomMcpServer, EditTarget } from '../types'
import { McpServerFormFields } from './McpServerFormFields'

interface AddProjectMcpDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectPath: string
  availableProviders: McpTarget[]
  onAdded: () => void
  editTarget?: EditTarget | null
  editProviders?: McpTarget[]
}

export function AddProjectMcpDialog({
  open,
  onOpenChange,
  projectPath,
  availableProviders,
  onAdded,
  editTarget,
  editProviders
}: AddProjectMcpDialogProps) {
  const trpcClient = useTRPCClient()
  const [serverKey, setServerKey] = useState('')
  const [description, setDescription] = useState('')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [envVars, setEnvVars] = useState<Array<{ key: string; value: string }>>([])
  const [providers, setProviders] = useState<Partial<Record<McpTarget, boolean>>>({})
  const [saving, setSaving] = useState(false)

  const reset = () => {
    setServerKey('')
    setDescription('')
    setCommand('')
    setArgs('')
    setEnvVars([])
    const flags: Partial<Record<McpTarget, boolean>> = {}
    for (const p of availableProviders) flags[p] = true
    setProviders(flags)
  }

  useEffect(() => {
    if (!open) return
    if (editTarget) {
      setServerKey(editTarget.server.id)
      setDescription(editTarget.server.description ?? '')
      setCommand(editTarget.server.config.command)
      setArgs(editTarget.server.config.args?.join(' ') ?? '')
      setEnvVars(
        Object.entries(editTarget.server.config.env ?? {}).map(([key, value]) => ({ key, value }))
      )
      const flags: Partial<Record<McpTarget, boolean>> = {}
      for (const p of availableProviders) flags[p] = editProviders?.includes(p) ?? false
      setProviders(flags)
    } else {
      reset()
    }
  }, [open, editTarget])

  const handleSave = async () => {
    if (!serverKey.trim() || !command.trim()) return
    setSaving(true)
    try {
      const config = buildConfig(command, args, envVars)
      const keyChanged = editTarget && editTarget.originalKey !== serverKey.trim()

      if (keyChanged && editProviders) {
        for (const provider of editProviders) {
          await trpcClient.aiConfig.removeMcpServer.mutate({
            projectPath,
            provider,
            serverKey: editTarget.originalKey
          })
        }
      }

      for (const [provider, enabled] of Object.entries(providers)) {
        if (!enabled) continue
        await trpcClient.aiConfig.writeMcpServer.mutate({
          projectPath,
          provider: provider as McpTarget,
          serverKey: serverKey.trim(),
          config
        })
      }

      // Persist metadata (description) to computer custom servers list
      let existing = await loadCustomServers(trpcClient)
      if (keyChanged && editTarget) {
        existing = existing.filter((s) => s.id !== editTarget.originalKey)
      }
      const entry: CustomMcpServer = {
        id: serverKey.trim(),
        name: serverKey.trim(),
        description: description.trim() || undefined,
        config
      }
      await saveCustomServers(trpcClient, [...existing.filter((s) => s.id !== entry.id), entry])

      reset()
      onAdded()
      onOpenChange(false)
    } finally {
      setSaving(false)
    }
  }

  const canSubmit = serverKey.trim() && command.trim() && Object.values(providers).some(Boolean)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {editTarget ? 'Edit Custom MCP Server' : 'Add Custom MCP Server'}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <McpServerFormFields
            serverKey={serverKey}
            setServerKey={setServerKey}
            description={description}
            setDescription={setDescription}
            command={command}
            setCommand={setCommand}
            args={args}
            setArgs={setArgs}
            envVars={envVars}
            setEnvVars={setEnvVars}
          />
          <div className="space-y-1.5">
            <Label className="text-xs">Write to providers</Label>
            <div className="flex items-center gap-4">
              {availableProviders.map((p) => (
                <label key={p} className="flex items-center gap-1.5 text-xs cursor-pointer">
                  <input
                    type="checkbox"
                    checked={providers[p]}
                    onChange={(e) => setProviders({ ...providers, [p]: e.target.checked })}
                  />
                  {PROVIDER_LABELS[p] ?? p}
                </label>
              ))}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={!canSubmit || saving}>
            {saving ? 'Saving...' : editTarget ? 'Save Changes' : 'Add Server'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
