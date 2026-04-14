import { useState } from 'react'
import { Lock, LockOpen, Timer, Clock } from 'lucide-react'
import {
  Button,
  Popover,
  PopoverTrigger,
  PopoverContent,
  Switch,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  Input
} from '@slayzone/ui'
import type { Project } from '@slayzone/projects/shared'

interface ProjectLockPopoverProps {
  project: Project
  onUpdated: (project: Project) => void
  onCloseProjectTabs: (projectId: string) => void
}

const DURATION_UNITS = [
  { value: 'minutes', label: 'Minutes' },
  { value: 'hours', label: 'Hours' },
]

const WINDOW_OPTIONS = [
  { value: '5', label: '5 min' },
  { value: '15', label: '15 min' },
  { value: '30', label: '30 min' },
  { value: '60', label: '1 hour' },
]

export function ProjectLockPopover({ project, onUpdated, onCloseProjectTabs }: ProjectLockPopoverProps) {
  const config = project.lock_config
  const hasAnyLock = !!(config?.locked_until || config?.rate_limit || config?.schedule)

  const [durationEnabled, setDurationEnabled] = useState(false)
  const [durationValue, setDurationValue] = useState(30)
  const [durationUnit, setDurationUnit] = useState<'minutes' | 'hours'>('minutes')

  const [rateLimitEnabled, setRateLimitEnabled] = useState(!!config?.rate_limit)
  const [maxTasks, setMaxTasks] = useState(config?.rate_limit?.max_tasks ?? 3)
  const [perMinutes, setPerMinutes] = useState(String(config?.rate_limit?.per_minutes ?? 60))

  const [scheduleEnabled, setScheduleEnabled] = useState(!!config?.schedule)
  const [scheduleFrom, setScheduleFrom] = useState(config?.schedule?.from ?? '18:00')
  const [scheduleTo, setScheduleTo] = useState(config?.schedule?.to ?? '09:00')

  const [open, setOpen] = useState(false)

  async function handleLockNow() {
    const ms = durationUnit === 'hours' ? durationValue * 3_600_000 : durationValue * 60_000
    const locked_until = new Date(Date.now() + ms).toISOString()
    const updated = await window.api.db.updateProject({
      id: project.id,
      lockConfig: {
        locked_until,
        rate_limit: config?.rate_limit ?? null,
        schedule: config?.schedule ?? null,
      }
    })
    onUpdated(updated as unknown as Project)
    onCloseProjectTabs(project.id)
    setOpen(false)
  }

  async function handleRateLimitChange(enabled: boolean, tasks?: number, minutes?: string) {
    const newMaxTasks = tasks ?? maxTasks
    const newPerMinutes = minutes ?? perMinutes
    if (enabled !== undefined) setRateLimitEnabled(enabled)
    if (tasks !== undefined) setMaxTasks(tasks)
    if (minutes !== undefined) setPerMinutes(minutes)

    const rate_limit = enabled
      ? { max_tasks: newMaxTasks, per_minutes: parseInt(newPerMinutes, 10) }
      : null
    const updated = await window.api.db.updateProject({
      id: project.id,
      lockConfig: {
        locked_until: config?.locked_until ?? null,
        rate_limit,
        schedule: config?.schedule ?? null,
      }
    })
    onUpdated(updated as unknown as Project)
  }

  async function handleScheduleChange(enabled: boolean, from?: string, to?: string) {
    const newFrom = from ?? scheduleFrom
    const newTo = to ?? scheduleTo
    if (enabled !== undefined) setScheduleEnabled(enabled)
    if (from !== undefined) setScheduleFrom(from)
    if (to !== undefined) setScheduleTo(to)

    const schedule = enabled ? { from: newFrom, to: newTo } : null
    const updated = await window.api.db.updateProject({
      id: project.id,
      lockConfig: {
        locked_until: config?.locked_until ?? null,
        rate_limit: config?.rate_limit ?? null,
        schedule,
      }
    })
    onUpdated(updated as unknown as Project)
  }

  async function handleClear() {
    const updated = await window.api.db.updateProject({
      id: project.id,
      lockConfig: null,
    })
    onUpdated(updated as unknown as Project)
    setRateLimitEnabled(false)
    setDurationEnabled(false)
    setScheduleEnabled(false)
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={`h-7 gap-1.5 px-2 text-xs font-medium ${hasAnyLock ? 'text-foreground' : 'text-muted-foreground'}`}
        >
          {hasAnyLock ? <Lock className="size-3.5" /> : <LockOpen className="size-3.5" />}
          Lock
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-3" align="end">
        <div className="space-y-3">
          {/* Duration Lock Card */}
          <div className="rounded-lg border border-border bg-surface-1 p-3 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Lock className="size-3.5 text-muted-foreground" />
                <span className="text-xs font-medium">Duration Lock</span>
              </div>
              <Switch checked={durationEnabled} onCheckedChange={setDurationEnabled} />
            </div>
            {durationEnabled && (
              <>
                <p className="text-[11px] text-muted-foreground leading-relaxed">
                  Block all access for a set period of time
                </p>
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    min={1}
                    value={durationValue}
                    onChange={(e) => setDurationValue(Math.max(1, parseInt(e.target.value, 10) || 1))}
                    className="h-8 w-16 text-xs"
                  />
                  <Select value={durationUnit} onValueChange={(v) => setDurationUnit(v as 'minutes' | 'hours')}>
                    <SelectTrigger size="sm" className="w-24 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {DURATION_UNITS.map((u) => (
                        <SelectItem key={u.value} value={u.value}>{u.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button size="sm" className="h-8 text-xs ml-auto" onClick={handleLockNow}>
                    Lock
                  </Button>
                </div>
              </>
            )}
          </div>

          {/* Rate Limit Card */}
          <div className="rounded-lg border border-border bg-surface-1 p-3 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Timer className="size-3.5 text-muted-foreground" />
                <span className="text-xs font-medium">Rate Limit</span>
              </div>
              <Switch
                checked={rateLimitEnabled}
                onCheckedChange={(checked) => handleRateLimitChange(checked)}
              />
            </div>
            {rateLimitEnabled && (
              <>
                <p className="text-[11px] text-muted-foreground leading-relaxed">
                  Limit how many tasks can be opened per time window
                </p>
                <div className="flex items-center gap-2 text-xs">
                  <Input
                    type="number"
                    min={1}
                    value={maxTasks}
                    onChange={(e) => {
                      const v = Math.max(1, parseInt(e.target.value, 10) || 1)
                      handleRateLimitChange(true, v)
                    }}
                    className="h-8 w-16 text-xs"
                  />
                  <span className="text-muted-foreground whitespace-nowrap">tasks per</span>
                  <Select value={perMinutes} onValueChange={(v) => handleRateLimitChange(true, undefined, v)}>
                    <SelectTrigger size="sm" className="flex-1 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {WINDOW_OPTIONS.map((w) => (
                        <SelectItem key={w.value} value={w.value}>{w.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </>
            )}
          </div>

          {/* Schedule Card */}
          <div className="rounded-lg border border-border bg-surface-1 p-3 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Clock className="size-3.5 text-muted-foreground" />
                <span className="text-xs font-medium">Schedule</span>
              </div>
              <Switch
                checked={scheduleEnabled}
                onCheckedChange={(checked) => handleScheduleChange(checked)}
              />
            </div>
            {scheduleEnabled && (
              <>
                <p className="text-[11px] text-muted-foreground leading-relaxed">
                  Lock this project between set hours daily
                </p>
                <div className="flex items-center gap-2 text-xs">
                  <Input
                    type="time"
                    value={scheduleFrom}
                    onChange={(e) => handleScheduleChange(true, e.target.value)}
                    className="h-8 w-[5.5rem] text-xs"
                  />
                  <span className="text-muted-foreground">to</span>
                  <Input
                    type="time"
                    value={scheduleTo}
                    onChange={(e) => handleScheduleChange(true, undefined, e.target.value)}
                    className="h-8 w-[5.5rem] text-xs"
                  />
                </div>
              </>
            )}
          </div>

          {/* Clear */}
          {hasAnyLock && (
            <Button variant="ghost" size="sm" className="w-full h-7 text-xs text-muted-foreground" onClick={handleClear}>
              Clear all locks
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
