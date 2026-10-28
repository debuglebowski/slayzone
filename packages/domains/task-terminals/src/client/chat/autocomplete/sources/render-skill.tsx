import type { SkillInfo } from '@slayzone/terminal-contracts'

const sourceLabel: Record<SkillInfo['source'], string> = {
  project: 'project',
  agents: 'agents',
  user: 'user'
}

export function renderSkillItem(skill: SkillInfo): React.JSX.Element {
  return (
    <div className="flex items-start gap-2">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs">/{skill.name}</span>
          <span className="text-[10px] text-muted-foreground uppercase tracking-wide">
            {sourceLabel[skill.source]}
          </span>
        </div>
        {skill.description && (
          <div className="text-xs text-muted-foreground truncate mt-0.5">
            {skill.description.split('\n')[0]}
          </div>
        )}
      </div>
    </div>
  )
}
