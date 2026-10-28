import { Inbox, CircleDashed, Circle, CircleDot, CircleCheck, CircleX } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { WorkflowCategory } from '@slayzone/projects-contracts'

export const CATEGORY_META: Record<WorkflowCategory, { label: string; icon: LucideIcon }> = {
  triage: { label: 'Triage', icon: Inbox },
  backlog: { label: 'Backlog', icon: CircleDashed },
  unstarted: { label: 'Unstarted', icon: Circle },
  started: { label: 'Started', icon: CircleDot },
  completed: { label: 'Completed', icon: CircleCheck },
  canceled: { label: 'Canceled', icon: CircleX }
}

export const STATUS_COLOR_BADGE: Record<string, string> = {
  gray: 'bg-gray-500/20 text-gray-300',
  slate: 'bg-slate-500/20 text-slate-300',
  blue: 'bg-blue-500/20 text-blue-300',
  yellow: 'bg-yellow-500/20 text-yellow-300',
  purple: 'bg-purple-500/20 text-purple-300',
  green: 'bg-green-500/20 text-green-300',
  red: 'bg-red-500/20 text-red-300',
  orange: 'bg-orange-500/20 text-orange-300'
}

export function SettingsTabIntro({ title, description }: { title: string; description: string }) {
  return (
    <div className="space-y-1">
      <h3 className="text-base font-semibold">{title}</h3>
      <p className="max-w-[80%] text-sm text-muted-foreground" style={{ textWrap: 'balance' }}>
        {description}
      </p>
    </div>
  )
}
