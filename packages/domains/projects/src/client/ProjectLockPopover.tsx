import { useState, useEffect, useMemo } from 'react'
import { Lock, LockOpen, Timer, Clock, AlertTriangle } from 'lucide-react'
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
  Input,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from '@slayzone/ui'
import type { Project, ProjectLockConfig } from '@slayzone/projects/shared'

interface ProjectLockPopoverProps {
  project: Project
  onUpdated: (project: Project) => void
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

export function ProjectLockPopover({ project, onUpdated }: ProjectLockPopoverProps) {
  const config = project.lock_config
  const hasAnyLock = !!(config?.locked_until || config?.rate_limit || config?.schedule)

  const [open, setOpen] = useState(false)
  const [whyOpen, setWhyOpen] = useState(false)
  const [confirmDisableOpen, setConfirmDisableOpen] = useState(false)

  // Local pending state — reset to persisted config when popover opens
  const [durationEnabled, setDurationEnabled] = useState(false)
  const [durationValue, setDurationValue] = useState(30)
  const [durationUnit, setDurationUnit] = useState<'minutes' | 'hours'>('minutes')

  const [rateLimitEnabled, setRateLimitEnabled] = useState(false)
  const [maxTasks, setMaxTasks] = useState(3)
  const [perMinutes, setPerMinutes] = useState('60')

  const [scheduleEnabled, setScheduleEnabled] = useState(false)
  const [scheduleFrom, setScheduleFrom] = useState('18:00')
  const [scheduleTo, setScheduleTo] = useState('09:00')

  const [disableUnlockEarly, setDisableUnlockEarly] = useState(false)

  // Reset local state from persisted config whenever popover opens
  useEffect(() => {
    if (!open) return
    setDurationEnabled(false)
    setDurationValue(30)
    setDurationUnit('minutes')
    setRateLimitEnabled(!!config?.rate_limit)
    setMaxTasks(config?.rate_limit?.max_tasks ?? 3)
    setPerMinutes(String(config?.rate_limit?.per_minutes ?? 60))
    setScheduleEnabled(!!config?.schedule)
    setScheduleFrom(config?.schedule?.from ?? '18:00')
    setScheduleTo(config?.schedule?.to ?? '09:00')
    setDisableUnlockEarly(config?.disable_unlock_early ?? false)
  }, [open, config])

  const isDirty = useMemo(() => {
    if (durationEnabled) return true
    if (rateLimitEnabled !== !!config?.rate_limit) return true
    if (rateLimitEnabled) {
      if (maxTasks !== config?.rate_limit?.max_tasks) return true
      if (parseInt(perMinutes, 10) !== config?.rate_limit?.per_minutes) return true
    }
    if (scheduleEnabled !== !!config?.schedule) return true
    if (scheduleEnabled) {
      if (scheduleFrom !== config?.schedule?.from) return true
      if (scheduleTo !== config?.schedule?.to) return true
    }
    if (disableUnlockEarly !== (config?.disable_unlock_early ?? false)) return true
    return false
  }, [config, durationEnabled, rateLimitEnabled, maxTasks, perMinutes, scheduleEnabled, scheduleFrom, scheduleTo, disableUnlockEarly])

  async function handleApply() {
    const locked_until = durationEnabled
      ? new Date(Date.now() + (durationUnit === 'hours' ? durationValue * 3_600_000 : durationValue * 60_000)).toISOString()
      : config?.locked_until ?? null
    const lockConfig: ProjectLockConfig = {
      locked_until,
      rate_limit: rateLimitEnabled
        ? { max_tasks: maxTasks, per_minutes: parseInt(perMinutes, 10) }
        : null,
      schedule: scheduleEnabled ? { from: scheduleFrom, to: scheduleTo } : null,
      disable_unlock_early: disableUnlockEarly,
    }
    const updated = await window.api.db.updateProject({ id: project.id, lockConfig })
    onUpdated(updated as unknown as Project)
    setOpen(false)
  }

  function handleClearLocal() {
    setDurationEnabled(false)
    setRateLimitEnabled(false)
    setScheduleEnabled(false)
    setDisableUnlockEarly(false)
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
      <PopoverContent
        className="w-80 p-3"
        align="end"
        onInteractOutside={(e) => {
          const target = e.target as HTMLElement | null
          if (target?.closest('[data-slot="alert-dialog-content"], [data-slot="alert-dialog-overlay"], [data-slot="dialog-content"], [data-slot="dialog-overlay"]')) {
            e.preventDefault()
          }
        }}
      >
        <div className="space-y-3">
          {/* Header */}
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold">Lock project</span>
            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground" onClick={() => setWhyOpen(true)}>
              Why?
            </Button>
          </div>

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
                    className="h-8 flex-1 min-w-0 text-xs"
                  />
                  <Select value={durationUnit} onValueChange={(v) => setDurationUnit(v as 'minutes' | 'hours')}>
                    <SelectTrigger size="sm" className="flex-1 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {DURATION_UNITS.map((u) => (
                        <SelectItem key={u.value} value={u.value}>{u.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
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
              <Switch checked={rateLimitEnabled} onCheckedChange={setRateLimitEnabled} />
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
                    onChange={(e) => setMaxTasks(Math.max(1, parseInt(e.target.value, 10) || 1))}
                    className="h-8 flex-1 min-w-0 text-xs"
                  />
                  <span className="text-muted-foreground whitespace-nowrap">tasks per</span>
                  <Select value={perMinutes} onValueChange={setPerMinutes}>
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
              <Switch checked={scheduleEnabled} onCheckedChange={setScheduleEnabled} />
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
                    onChange={(e) => setScheduleFrom(e.target.value)}
                    className="h-8 flex-1 min-w-0 text-xs"
                  />
                  <span className="text-muted-foreground">to</span>
                  <Input
                    type="time"
                    value={scheduleTo}
                    onChange={(e) => setScheduleTo(e.target.value)}
                    className="h-8 flex-1 min-w-0 text-xs"
                  />
                </div>
              </>
            )}
          </div>

          <div className="h-px bg-border mx-8 my-3" />

          {/* Disable unlock early */}
          <div className={`rounded-lg border p-3 ${disableUnlockEarly ? 'border-amber-500/50 bg-amber-500/10' : 'border-border bg-surface-1'}`}>
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs font-medium">Disable unlock early</p>
                <p className="text-[11px] text-muted-foreground leading-relaxed">
                  Hide "Unlock early" button on lockscreen
                </p>
              </div>
              <Switch
                checked={disableUnlockEarly}
                onCheckedChange={(v) => {
                  if (v) setConfirmDisableOpen(true)
                  else setDisableUnlockEarly(false)
                }}
              />
            </div>
            {disableUnlockEarly && (
              <div className="mt-2 flex items-start gap-1.5 text-[11px] text-amber-600 dark:text-amber-400">
                <AlertTriangle className="size-3.5 shrink-0 mt-px" />
                <span>No escape until lock expires. Locked sessions cannot be ended early. Use at your own risk.</span>
              </div>
            )}
          </div>

          {/* Footer: Clear + Apply */}
          <div className="flex items-center justify-between gap-2 pt-1">
            {hasAnyLock ? (
              <Button variant="ghost" size="sm" className="h-8 text-xs text-muted-foreground" onClick={handleClearLocal}>
                Clear all locks
              </Button>
            ) : (
              <span />
            )}
            <Button size="sm" className="h-8 text-xs" disabled={!isDirty} onClick={handleApply}>
              Apply
            </Button>
          </div>
        </div>
      </PopoverContent>

      <AlertDialog open={confirmDisableOpen} onOpenChange={setConfirmDisableOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="size-5 text-amber-500" />
              Disable unlock early?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Once locked, you will not be able to end the session early. The project will remain locked until the duration expires or the schedule window ends. Use at your own risk.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-amber-600 hover:bg-amber-700 text-white"
              onClick={() => setDisableUnlockEarly(true)}
            >
              Disable
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={whyOpen} onOpenChange={setWhyOpen}>
        <DialogContent>
          <DialogHeader className="gap-3">
            <DialogTitle>Why lock a project?</DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-3">
                <p>
                  A focus tool to enforce deep work, prevent context switching, and protect time blocks from yourself.
                </p>
                <p className="rounded-md border border-border bg-surface-1 p-3 text-xs italic">
                  Example: lock the side-project for 2 hours every weekday morning so the day job can't bleed in.
                </p>
              </div>
            </DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>
    </Popover>
  )
}
