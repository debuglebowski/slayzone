import { useState, useEffect, useCallback } from 'react'
import { Lock } from 'lucide-react'
import { Button } from '@slayzone/ui'
import type { Project } from '@slayzone/projects/shared'
import { isScheduleLocked, overrideScheduleLock } from './useProjectLockGuard'

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

export function ProjectLockScreen({ project, lockedUntil, schedule, onUnlocked }: ProjectLockScreenProps) {
  const hasDuration = lockedUntil && new Date(lockedUntil).getTime() > Date.now()
  const [remaining, setRemaining] = useState(() =>
    hasDuration ? new Date(lockedUntil).getTime() - Date.now() : 0
  )

  // Duration countdown (1s interval)
  useEffect(() => {
    if (!hasDuration) return
    const id = setInterval(() => {
      const r = new Date(lockedUntil).getTime() - Date.now()
      setRemaining(r)
      if (r <= 0) clearInterval(id)
    }, 1000)
    return () => clearInterval(id)
  }, [lockedUntil, hasDuration])

  // Schedule recheck (60s interval)
  useEffect(() => {
    if (hasDuration || !schedule) return
    const id = setInterval(() => {
      if (!isScheduleLocked(project)) {
        // Schedule window ended — notify parent to re-render
        onUnlocked(project)
      }
    }, 60_000)
    return () => clearInterval(id)
  }, [hasDuration, schedule, project, onUnlocked])

  const handleUnlockEarly = useCallback(async () => {
    if (hasDuration) {
      // Duration = one-shot → clear from DB
      const updated = await window.api.db.updateProject({
        id: project.id,
        lockConfig: {
          ...project.lock_config!,
          locked_until: null,
        },
      })
      onUnlocked(updated as unknown as Project)
    } else if (schedule) {
      // Schedule = recurring → session-only override (no DB write)
      overrideScheduleLock(project.id)
      onUnlocked(project)
    }
  }, [project, hasDuration, schedule, onUnlocked])

  // Auto-unlock when duration timer expires
  useEffect(() => {
    if (hasDuration && remaining <= 0) handleUnlockEarly()
  }, [remaining, hasDuration, handleUnlockEarly])

  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="text-center space-y-4">
        <Lock className="h-16 w-16 text-muted-foreground mx-auto" />
        <p className="text-2xl font-bold">Project Locked</p>
        {hasDuration ? (
          <p className="text-4xl font-mono tabular-nums text-muted-foreground">
            {formatRemaining(remaining)}
          </p>
        ) : schedule ? (
          <p className="text-lg text-muted-foreground">
            Available at {schedule.to}
          </p>
        ) : null}
        <Button variant="ghost" size="sm" className="text-xs text-muted-foreground" onClick={handleUnlockEarly}>
          Unlock early
        </Button>
      </div>
    </div>
  )
}
