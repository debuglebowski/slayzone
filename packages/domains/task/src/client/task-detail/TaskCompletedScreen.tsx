import React from 'react'
import {
  Check,
  Eye,
  Shuffle,
  Trophy,
  Swords,
  PartyPopper,
  Sparkles,
  CheckCircle2,
  Flame,
  Circle
} from 'lucide-react'
import { cn, getColumnStatusStyle } from '@slayzone/ui'
import { resolveColumns } from '@slayzone/projects/shared'
import type { Project } from '@slayzone/projects/shared'
import type { Task } from '@slayzone/task/shared'

export interface TaskCompletedScreenProps {
  task: Task
  project: Project | null
  completedVariant: number
  setCompletedVariant: React.Dispatch<React.SetStateAction<number>>
  onCloseTab: (taskId: string) => void
  onShowDetails: () => void
  onTaskUpdate: (task: Task) => void
}

/** Celebratory "task completed" screen with selectable visual variants. Presentational. */
export function TaskCompletedScreen({
  task,
  project,
  completedVariant,
  setCompletedVariant,
  onCloseTab,
  onShowDetails,
  onTaskUpdate
}: TaskCompletedScreenProps): React.JSX.Element {
  const actionButtonClass =
    'inline-flex items-center justify-center gap-1.5 rounded-md border border-border bg-surface-1/80 backdrop-blur px-3 py-1.5 text-sm cursor-pointer hover:bg-accent'
  const actionButtons = (
    <div className="mt-6 grid grid-cols-2 gap-2 w-full max-w-sm mx-auto">
      <button type="button" className={actionButtonClass} onClick={() => onCloseTab(task.id)}>
        <Check className="size-4 text-emerald-400" strokeWidth={3} />
        Close task
      </button>
      <button type="button" className={actionButtonClass} onClick={() => onShowDetails()}>
        <Eye className="size-4 text-sky-400" strokeWidth={3} />
        Show details
      </button>
      {resolveColumns(project?.columns_config)
        .filter((col) => col.category === 'started')
        .map((col) => {
          const optStyle = getColumnStatusStyle(col.id, project?.columns_config)
          const OptIcon = optStyle?.icon ?? Circle
          return (
            <button
              key={col.id}
              type="button"
              className={actionButtonClass}
              onClick={async () => {
                const updated = await window.api.db.updateTask({
                  id: task.id,
                  status: col.id
                })
                onTaskUpdate(updated)
              }}
            >
              <OptIcon className={cn('size-4', optStyle?.iconClass)} strokeWidth={3} />
              Move to {col.label}
            </button>
          )
        })}
    </div>
  )
  const variantLabels = ['Trophy hero', 'Sword slash', 'Confetti light', 'Medallion', 'Stamp']
  const switcher = (
    <div className="absolute top-3 right-3 z-10 flex items-center gap-1.5 rounded-md border border-border bg-surface-1/80 backdrop-blur px-2 py-1 text-xs text-muted-foreground">
      <Shuffle className="size-3" strokeWidth={2.5} />
      <select
        value={completedVariant}
        onChange={(e) => setCompletedVariant(Number(e.target.value))}
        className="bg-transparent outline-none cursor-pointer text-foreground"
      >
        {variantLabels.map((label, i) => (
          <option key={i} value={i} className="bg-surface-1 text-foreground">
            {i + 1}. {label}
          </option>
        ))}
      </select>
    </div>
  )
  const variants = [
    // V1: Trophy hero — soft glow bg, big trophy
    <div
      key="v1"
      className="flex-1 flex flex-col items-center justify-center relative overflow-hidden"
    >
      {switcher}
      <div className="absolute inset-0 bg-[radial-gradient(circle_closest-side_at_50%_50%,_rgba(245,158,11,0.12)_25%,_transparent_100%)] pointer-events-none" />
      <div className="relative flex flex-col items-center text-center">
        <div className="size-20 rounded-full bg-amber-500/15 flex items-center justify-center mb-5 ring-4 ring-amber-500/10">
          <Trophy className="size-10 text-amber-500" strokeWidth={2} />
        </div>
        <p className="text-5xl font-bold tracking-tight">Slayed!</p>
        <p className="mt-3 text-base text-muted-foreground">Task wrapped. Take the win.</p>
        {actionButtons}
      </div>
    </div>,
    // V2: Sword slash — angled accent line + sword icon
    <div
      key="v2"
      className="flex-1 flex flex-col items-center justify-center relative overflow-hidden"
    >
      {switcher}
      <div className="absolute inset-x-0 top-1/2 h-px bg-gradient-to-r from-transparent via-rose-500/40 to-transparent -rotate-6 pointer-events-none" />
      <div className="absolute inset-x-0 top-1/2 h-px bg-gradient-to-r from-transparent via-rose-500/20 to-transparent rotate-3 translate-y-3 pointer-events-none" />
      <div className="relative flex flex-col items-center text-center">
        <Swords className="size-12 text-rose-500 mb-4 -rotate-12" strokeWidth={2} />
        <p className="text-5xl font-bold tracking-tight">Task slayed</p>
        <p className="mt-3 text-base text-muted-foreground">Clean cut. Onto the next.</p>
        {actionButtons}
      </div>
    </div>,
    // V3: Confetti light — few tasteful pieces, big check
    <div
      key="v3"
      className="flex-1 flex flex-col items-center justify-center relative overflow-hidden"
    >
      {switcher}
      <PartyPopper className="absolute top-[18%] left-[22%] size-6 text-fuchsia-400/60 -rotate-12" />
      <Sparkles className="absolute top-[24%] right-[24%] size-5 text-amber-400/60" />
      <Sparkles className="absolute bottom-[26%] left-[28%] size-5 text-emerald-400/60" />
      <PartyPopper className="absolute bottom-[20%] right-[22%] size-6 text-sky-400/60 rotate-12" />
      <div className="relative flex flex-col items-center text-center">
        <div className="size-20 rounded-full bg-emerald-500/15 flex items-center justify-center mb-5 ring-4 ring-emerald-500/10">
          <CheckCircle2 className="size-11 text-emerald-500" strokeWidth={2.25} />
        </div>
        <p className="text-5xl font-bold tracking-tight">You slayed it!</p>
        <p className="mt-3 text-base text-muted-foreground">Another one in the books.</p>
        {actionButtons}
      </div>
    </div>,
    // V4: Medallion — gradient circle badge
    <div key="v4" className="flex-1 flex flex-col items-center justify-center relative">
      {switcher}
      <div className="flex flex-col items-center text-center">
        <div className="relative mb-5">
          <div className="size-24 rounded-full bg-gradient-to-br from-emerald-400/40 via-emerald-500/30 to-emerald-700/40 flex items-center justify-center ring-2 ring-emerald-500/50 shadow-[0_0_40px_rgba(16,185,129,0.25)]">
            <Flame
              className="size-12 text-emerald-400"
              strokeWidth={2}
              fill="currentColor"
              fillOpacity={0.2}
            />
          </div>
        </div>
        <p className="text-[11px] uppercase tracking-[0.4em] text-emerald-500 font-bold">Slayer</p>
        <p className="mt-2 text-4xl font-bold tracking-tight">Task slayed</p>
        <p className="mt-3 text-base text-muted-foreground">Earned. Want to peek inside?</p>
        {actionButtons}
      </div>
    </div>,
    // V5: Stamp — visible rotated SLAYED banner
    <div
      key="v5"
      className="flex-1 flex flex-col items-center justify-center relative overflow-hidden"
    >
      {switcher}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none select-none">
        <span className="text-emerald-500/[0.08] font-black tracking-[0.2em] text-[clamp(5rem,15vw,13rem)] leading-none -rotate-12">
          SLAYED
        </span>
      </div>
      <div className="relative flex flex-col items-center text-center">
        <div className="-rotate-6 inline-flex items-center gap-2 rounded-md border-2 border-emerald-500/70 bg-emerald-500/10 px-4 py-1.5 mb-5">
          <CheckCircle2 className="size-5 text-emerald-500" strokeWidth={2.5} />
          <span className="text-emerald-500 font-bold tracking-[0.25em] uppercase text-sm">
            Slayed
          </span>
        </div>
        <p className="text-4xl font-bold tracking-tight">Stamped & done</p>
        <p className="mt-3 text-base text-muted-foreground">Locked in the win column.</p>
        {actionButtons}
      </div>
    </div>
  ]
  return variants[completedVariant] ?? variants[0]
}
