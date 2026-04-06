import { useState, useEffect } from 'react'
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
  const [onActive, setOnActive] = useState<string>('none')
  const [onIdle, setOnIdle] = useState<string>('none')
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
      const updated = await window.api.db.updateProject({
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
        description="Configure automatic task behavior based on terminal activity."
      />
      <form onSubmit={handleSubmit} className="space-y-6">
        <div className="space-y-1">
          <Label htmlFor="on-terminal-active">When terminal starts working</Label>
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
            Automatically move a task to this status when its terminal becomes active.
          </p>
        </div>

        <div className="space-y-1">
          <Label htmlFor="on-terminal-idle">When terminal becomes idle</Label>
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
            Automatically move a task to this status when its terminal stops and waits for input.
          </p>
        </div>

        <Button type="submit" disabled={loading}>
          {loading ? 'Saving…' : 'Save'}
        </Button>
      </form>
    </div>
  )
}
