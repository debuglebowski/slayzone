import type React from 'react'
import {
  GitPullRequest,
  GitMerge,
  CircleDot,
  CircleX,
  CheckCircle2,
  XCircle,
  Clock,
  ShieldCheck,
  ShieldAlert,
  ShieldQuestion,
  FilePlus2,
  FileX2,
  File
} from 'lucide-react'
import { cn } from '@slayzone/ui'
import type { GhPullRequest } from '../shared/types'
import type { FileDiff } from './parse-diff'

export function PrStateIcon({
  state,
  isDraft
}: {
  state: GhPullRequest['state']
  isDraft: boolean
}) {
  if (isDraft) return <GitPullRequest className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
  if (state === 'MERGED') return <GitMerge className="h-4 w-4 text-purple-500 shrink-0 mt-0.5" />
  if (state === 'CLOSED') return <CircleX className="h-4 w-4 text-red-500 shrink-0 mt-0.5" />
  return <CircleDot className="h-4 w-4 text-green-500 shrink-0 mt-0.5" />
}

export function PrStateBadge({
  state,
  isDraft
}: {
  state: GhPullRequest['state']
  isDraft: boolean
}) {
  if (isDraft) {
    return (
      <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-muted text-muted-foreground">
        Draft
      </span>
    )
  }
  const styles: Record<string, string> = {
    OPEN: 'bg-green-500/10 text-green-500',
    MERGED: 'bg-purple-500/10 text-purple-500',
    CLOSED: 'bg-red-500/10 text-red-500'
  }
  return (
    <span className={cn('px-2 py-0.5 rounded-full text-[10px] font-medium', styles[state] ?? '')}>
      {state.charAt(0) + state.slice(1).toLowerCase()}
    </span>
  )
}

export function ChecksBadge({ status }: { status: GhPullRequest['statusCheckRollup'] }) {
  if (!status) return null
  const config: Record<string, { icon: React.ReactNode; label: string; className: string }> = {
    SUCCESS: {
      icon: <CheckCircle2 className="h-3 w-3" />,
      label: 'Checks pass',
      className: 'text-green-500 bg-green-500/10'
    },
    FAILURE: {
      icon: <XCircle className="h-3 w-3" />,
      label: 'Checks failing',
      className: 'text-red-500 bg-red-500/10'
    },
    PENDING: {
      icon: <Clock className="h-3 w-3" />,
      label: 'Checks running',
      className: 'text-yellow-500 bg-yellow-500/10'
    }
  }
  const c = config[status]
  if (!c) return null
  return (
    <span
      className={cn(
        'flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium',
        c.className
      )}
    >
      {c.icon} {c.label}
    </span>
  )
}

export function ReviewBadge({ decision }: { decision: GhPullRequest['reviewDecision'] }) {
  if (!decision) return null
  const config: Record<string, { icon: React.ReactNode; label: string; className: string }> = {
    APPROVED: {
      icon: <ShieldCheck className="h-3 w-3" />,
      label: 'Approved',
      className: 'text-green-500 bg-green-500/10'
    },
    CHANGES_REQUESTED: {
      icon: <ShieldAlert className="h-3 w-3" />,
      label: 'Changes requested',
      className: 'text-red-500 bg-red-500/10'
    },
    REVIEW_REQUIRED: {
      icon: <ShieldQuestion className="h-3 w-3" />,
      label: 'Review required',
      className: 'text-yellow-500 bg-yellow-500/10'
    }
  }
  const c = config[decision]
  if (!c) return null
  return (
    <span
      className={cn(
        'flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium',
        c.className
      )}
    >
      {c.icon} {c.label}
    </span>
  )
}

export function ReviewInlineBadge({ state }: { state: string }) {
  const config: Record<string, { label: string; className: string }> = {
    APPROVED: {
      label: 'Approved',
      className: 'text-green-500 bg-green-500/10 border-green-500/20'
    },
    CHANGES_REQUESTED: {
      label: 'Changes requested',
      className: 'text-red-500 bg-red-500/10 border-red-500/20'
    },
    COMMENTED: { label: 'Reviewed', className: 'text-muted-foreground bg-muted border-border' }
  }
  const c = config[state]
  if (!c) return null
  return (
    <span className={cn('px-1.5 py-px rounded text-[9px] font-medium border', c.className)}>
      {c.label}
    </span>
  )
}

export function reviewActionLabel(state?: string): string {
  switch (state) {
    case 'APPROVED':
      return 'approved these changes'
    case 'CHANGES_REQUESTED':
      return 'requested changes'
    case 'COMMENTED':
      return 'left a review'
    case 'DISMISSED':
      return 'dismissed a review'
    default:
      return 'reviewed'
  }
}

export function DiffFileIcon({ file }: { file: FileDiff }) {
  if (file.isNew) return <FilePlus2 className="h-3 w-3 text-green-500 shrink-0" />
  if (file.isDeleted) return <FileX2 className="h-3 w-3 text-red-500 shrink-0" />
  return <File className="h-3 w-3 text-muted-foreground shrink-0" />
}
