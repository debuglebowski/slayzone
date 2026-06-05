import { useEffect, useState } from 'react'
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@slayzone/ui'
import { buildConfig, loadCustomServers, saveCustomServers } from '../mcp-helpers'
import type { CustomMcpServer, EditTarget } from '../types'
import { McpServerFormFields } from './McpServerFormFields'

interface AddComputerMcpDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onAdded: () => void
  editTarget?: EditTarget | null
}

export function AddComputerMcpDialog({
  open,
  onOpenChange,
  onAdded,
  editTarget
}: AddComputerMcpDialogProps) {
  const [serverKey, setServerKey] = useState('')
  const [description, setDescription] = useState('')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [envVars, setEnvVars] = useState<Array<{ key: string; value: string }>>([])
  const [saving, setSaving] = useState(false)

  const reset = () => {
    setServerKey('')
    setDescription('')
    setCommand('')
    setArgs('')
    setEnvVars([])
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
    } else {
      reset()
    }
  }, [open, editTarget])

  const handleSave = async () => {
    if (!serverKey.trim() || !command.trim()) return
    setSaving(true)
    try {
      let existing = await loadCustomServers()
      if (editTarget && editTarget.originalKey !== serverKey.trim()) {
        existing = existing.filter((s) => s.id !== editTarget.originalKey)
      }
      const entry: CustomMcpServer = {
        id: serverKey.trim(),
        name: serverKey.trim(),
        description: description.trim() || undefined,
        config: buildConfig(command, args, envVars)
      }
      await saveCustomServers([...existing.filter((s) => s.id !== entry.id), entry])
      reset()
      onAdded()
      onOpenChange(false)
    } finally {
      setSaving(false)
    }
  }

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
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={!serverKey.trim() || !command.trim() || saving}>
            {saving ? 'Saving...' : editTarget ? 'Save Changes' : 'Add Server'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
