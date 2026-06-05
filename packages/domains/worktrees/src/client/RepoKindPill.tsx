import type { DetectedRepo } from '@slayzone/projects/shared'

export function RepoKindPill({ kind }: { kind: NonNullable<DetectedRepo['kind']> }) {
  if (kind !== 'submodule') return null
  return (
    <span className="inline-flex items-center rounded-sm border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground leading-none">
      Submodule
    </span>
  )
}
