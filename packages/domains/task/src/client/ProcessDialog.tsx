import { useState, useEffect, useRef, useCallback } from 'react'
import { useTRPCClient } from '@slayzone/transport/client'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
  Button, Input, Label, Tooltip, TooltipTrigger, TooltipContent, cn,
} from '@slayzone/ui'
import type { ProcessEntry } from './ProcessesPanel'

interface AddFormState {
  label: string
  command: string
  autoRestart: boolean
  scope: 'task' | 'project'
}

const EMPTY_FORM: AddFormState = { label: '', command: '', autoRestart: false, scope: 'project' }

interface ProcessDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  process: ProcessEntry | null
  taskId: string | null
  projectId: string | null
  cwd: string | null
  onSaved: () => void
  onSpawned: (id: string) => void
}

export function ProcessDialog({ open, onOpenChange, process, taskId, projectId, cwd, onSaved, onSpawned }: ProcessDialogProps) {
  const trpcClient = useTRPCClient()
  const [form, setForm] = useState<AddFormState>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const labelRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (process) {
      setForm({
        label: process.label,
        command: process.command,
        autoRestart: process.autoRestart,
        scope: process.taskId === null ? 'project' : 'task',
      })
    } else {
      setForm(EMPTY_FORM)
    }
    setSaveError(null)
    setSaving(false)
  }, [process, open])

  useEffect(() => {
    if (open) setTimeout(() => labelRef.current?.focus(), 50)
  }, [open])

  const isValid = form.label.trim() && form.command.trim()

  const resolveScope = useCallback(() => {
    const isProject = form.scope === 'project'
    return { tid: isProject ? null : taskId, pid: isProject ? projectId : null }
  }, [form.scope, taskId, projectId])

  const handleSave = useCallback(async () => {
    if (!isValid) return
    setSaving(true)
    setSaveError(null)
    try {
      const { tid, pid } = resolveScope()
      if (process) {
        await trpcClient.processes.update.mutate({ processId: process.id, updates: { label: form.label.trim(), command: form.command.trim(), autoRestart: form.autoRestart, taskId: tid, projectId: pid } })
      } else {
        await trpcClient.processes.create.mutate({ projectId: pid, taskId: tid, label: form.label.trim(), command: form.command.trim(), cwd: cwd ?? '', autoRestart: form.autoRestart })
      }
      onSaved()
      onOpenChange(false)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }, [isValid, form, process, cwd, resolveScope, onSaved, onOpenChange])

  const handleSpawn = useCallback(async () => {
    if (!isValid) return
    setSaving(true)
    setSaveError(null)
    try {
      const { tid, pid } = resolveScope()
      let id: string
      if (process) {
        await trpcClient.processes.update.mutate({ processId: process.id, updates: { label: form.label.trim(), command: form.command.trim(), autoRestart: form.autoRestart, taskId: tid, projectId: pid } })
        await trpcClient.processes.restart.mutate({ processId: process.id })
        id = process.id
      } else {
        id = await trpcClient.processes.spawn.mutate({ projectId: pid, taskId: tid, label: form.label.trim(), command: form.command.trim(), cwd: cwd ?? '', autoRestart: form.autoRestart })
      }
      onSpawned(id)
      onOpenChange(false)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }, [isValid, form, process, cwd, resolveScope, onSpawned, onOpenChange])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent style={{ maxWidth: 520 }}>
        <DialogHeader>
          <DialogTitle>{process ? 'Edit Process' : 'New Process'}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 max-h-[60vh] overflow-y-auto pr-1">
          {/* Scope */}
          <div className="space-y-1.5">
            <Label className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Scope</Label>
            <div className="flex gap-1 p-0.5 rounded-lg bg-muted/50 border border-border w-fit">
              {(['project', 'task'] as const).map(s => (
                <button
                  key={s}
                  onClick={() => setForm(f => ({ ...f, scope: s }))}
                  className={cn(
                    'px-3 py-1 rounded-md text-xs font-medium transition-colors',
                    form.scope === s
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  {s === 'task' ? 'This task' : 'Project'}
                </button>
              ))}
            </div>
            <p className="text-[10px] text-muted-foreground/60 leading-relaxed">
              {form.scope === 'task'
                ? 'Stopped when this task is closed or deleted.'
                : 'Shared across all tasks in this project.'}
            </p>
          </div>

          {/* Label */}
          <div className="space-y-1.5">
            <Label className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Label</Label>
            <Input
              ref={labelRef}
              placeholder="e.g. Frontend"
              value={form.label}
              onChange={e => setForm(f => ({ ...f, label: e.target.value }))}
            />
          </div>

          {/* Command */}
          <div className="space-y-1.5">
            <Label className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Command</Label>
            <Input
              placeholder="e.g. npm run dev"
              value={form.command}
              onChange={e => setForm(f => ({ ...f, command: e.target.value }))}
              onKeyDown={e => { if (e.key === 'Enter') void handleSpawn() }}
              className="font-mono"
            />
          </div>

          {/* Auto-restart */}
          <Tooltip>
            <TooltipTrigger asChild>
              <label className="flex items-center gap-2.5 text-xs text-muted-foreground cursor-pointer select-none w-fit">
                <input
                  type="checkbox"
                  checked={form.autoRestart}
                  onChange={e => setForm(f => ({ ...f, autoRestart: e.target.checked }))}
                  className="size-3.5 rounded"
                />
                Auto-restart on crash
              </label>
            </TooltipTrigger>
            <TooltipContent side="right" className="max-w-64">
              Automatically restarts the process if it exits with a non-zero code. Won't restart if you stop it manually.
            </TooltipContent>
          </Tooltip>

          {saveError && (
            <p className="text-[11px] text-red-500 bg-red-500/10 border border-red-500/20 rounded-md px-3 py-2">{saveError}</p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="outline" onClick={() => void handleSave()} disabled={saving || !isValid}>
            {saving ? '...' : process ? 'Update' : 'Save'}
          </Button>
          <Button onClick={() => void handleSpawn()} disabled={saving || !isValid}>
            {saving ? '...' : process ? 'Update & run' : 'Run'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
