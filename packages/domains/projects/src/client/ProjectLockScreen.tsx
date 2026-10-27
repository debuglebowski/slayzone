import { useState, useCallback } from 'react'
import { Lock } from 'lucide-react'
import { Button, useVisibleInterval } from '@slayzone/ui'
import type { Project } from '@slayzone/projects/shared'
import { isScheduleLocked, overrideScheduleLock, overrideDurationLock } from './useProjectLockGuard'

interface ProjectLockScreenProps {
  project: Project
  lockedUntil?: string | null
  schedule?: { from: string; to: string } | null
  onUnlocked: (project: Project) => void
}

function formatRemaining(ms: number): string {
  if (ms <= 0) return '00:00'
  const totalSeconds = Math.ceil(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return hours > 0
    ? `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
    : `${pad(minutes)}:${pad(seconds)}`
}

export function ProjectLockScreen({
  project,
  lockedUntil,
  schedule,
  onUnlocked
}: ProjectLockScreenProps) {
  // Clock is sampled at mount and by the countdown tick — never during render.
  const [remaining, setRemaining] = useState(() =>
    lockedUntil ? new Date(lockedUntil).getTime() - Date.now() : 0
  )
  const hasDuration = Boolean(lockedUntil) && remaining > 0

  // Duration countdown (1s interval); unlocks on the tick the lock expires.
  useVisibleInterval(
    () => {
      const r = new Date(lockedUntil ?? 0).getTime() - Date.now()
      setRemaining(r)
      if (r <= 0) {
        overrideDurationLock(project.id, lockedUntil)
        onUnlocked(project)
      }
    },
    1000,
    { enabled: hasDuration }
  )

  // Schedule recheck (60s interval)
  useVisibleInterval(
    () => {
      if (!isScheduleLocked(project)) onUnlocked(project)
    },
    60_000,
    { enabled: !hasDuration && Boolean(schedule), runOnVisible: true }
  )

  const handleUnlockEarly = useCallback(() => {
    if (hasDuration) overrideDurationLock(project.id, lockedUntil)
    else if (schedule) overrideScheduleLock(project.id)
    onUnlocked(project)
  }, [project, hasDuration, schedule, onUnlocked])

  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="text-center space-y-4">
        <Lock className="h-16 w-16 text-muted-foreground mx-auto" />
        <p className="text-2xl font-bold">{project.name} locked</p>
        {hasDuration ? (
          <p className="text-4xl font-mono tabular-nums text-muted-foreground">
            {formatRemaining(remaining)}
          </p>
        ) : schedule ? (
          <p className="text-lg text-muted-foreground">Available at {schedule.to}</p>
        ) : null}
        {!project.lock_config?.disable_unlock_early && (
          <Button
            variant="ghost"
            size="sm"
            className="text-xs text-muted-foreground"
            onClick={handleUnlockEarly}
          >
            Unlock early
          </Button>
        )}
      </div>
    </div>
  )
}
