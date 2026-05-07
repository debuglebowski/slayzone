import { useState, useEffect } from 'react'
import { getTrpcVanillaClient } from '@slayzone/transport/client'
import { Button, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@slayzone/ui'
import type { Project, TaskAutomationConfig } from '@slayzone/projects/shared'
import { resolveColumns } from '@slayzone/workflow'
import { SettingsTabIntro } from './project-settings-shared'

interface TasksGeneralTabProps {
  project: Project
  onUpdated: (project: Project) => void
}

export function TasksGeneralTab({ project, onUpdated }: TasksGeneralTabProps) {
  const columns = resolveColumns(project.columns_config)
  const [onActive, setOnActive] = useState<string>(
    () => project.task_automation_config?.on_terminal_active ?? 'none'
  )
  const [onIdle, setOnIdle] = useState<string>(
    () => project.task_automation_config?.on_terminal_idle ?? 'none'
  )
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    const cfg = project.task_automation_config
    setOnActive(cfg?.on_terminal_active ?? 'none')
    setOnIdle(cfg?.on_terminal_idle ?? 'none')
  }, [project])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    try {
      const config: TaskAutomationConfig = {
        on_terminal_active: onActive === 'none' ? null : onActive,
        on_terminal_idle: onIdle === 'none' ? null : onIdle
      }
      const hasValue = config.on_terminal_active || config.on_terminal_idle
      const updated = await getTrpcVanillaClient().projects.update.mutate({
        id: project.id,
        taskAutomationConfig: hasValue ? config : null
      })
      onUpdated(updated)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="w-full space-y-6">
      <SettingsTabIntro
        title="General"
        description="Configure automatic task behavior based on agent activity."
      />
      <form onSubmit={handleSubmit} className="space-y-6">
        <div className="space-y-1">
          <Label htmlFor="on-terminal-active">When Agent starts working</Label>
          <Select value={onActive} onValueChange={setOnActive}>
            <SelectTrigger id="on-terminal-active" className="max-w-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Do nothing</SelectItem>
              {columns.map((col) => (
                <SelectItem key={col.id} value={col.id}>{col.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Automatically move a task to this status when its agent becomes active.
          </p>
        </div>

        <div className="space-y-1">
          <Label htmlFor="on-terminal-idle">When Agent becomes idle</Label>
          <Select value={onIdle} onValueChange={setOnIdle}>
            <SelectTrigger id="on-terminal-idle" className="max-w-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Do nothing</SelectItem>
              {columns.map((col) => (
                <SelectItem key={col.id} value={col.id}>{col.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Automatically move a task to this status when its agent stops and waits for input.
          </p>
        </div>

        <Button type="submit" disabled={loading}>
          {loading ? 'Saving…' : 'Save'}
        </Button>
      </form>
    </div>
  )
}
