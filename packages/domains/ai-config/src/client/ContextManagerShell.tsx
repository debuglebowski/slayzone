import { useState, useCallback } from 'react'
import { ArrowLeft, FileText, Server, Settings2, Sparkles, Monitor, FolderGit2, Library, ChevronRight } from 'lucide-react'
import { cn, Collapsible, CollapsibleTrigger, CollapsibleContent } from '@slayzone/ui'
import { ProviderSyncSection } from './ProviderSyncSection'
import { InstructionsSection } from './InstructionsSection'
import { SkillsSection } from './SkillsSection'
import { McpSection } from './McpSection'
import type { ConfigLevel } from '../shared'

export interface ContextManagerShellProps {
  selectedProjectId: string | null
  projectPath?: string | null
  projectName?: string
  onBack: () => void
}

type Section = 'provider-sync' | 'instructions' | 'skills' | 'mcps'

type ActiveItem =
  | { type: 'providers' }
  | { type: 'content'; level: ConfigLevel; section: Section }

const SECTION_ITEMS: { id: Section; label: string; icon: typeof Sparkles }[] = [
  { id: 'instructions', label: 'Instructions', icon: FileText },
  { id: 'skills', label: 'Skills', icon: Sparkles },
  { id: 'mcps', label: 'MCPs', icon: Server },
]

const LEVELS: { id: ConfigLevel; label: string; icon: typeof Monitor }[] = [
  { id: 'computer', label: 'Computer', icon: Monitor },
  { id: 'project', label: 'Project', icon: FolderGit2 },
  { id: 'library', label: 'Library', icon: Library },
]

export function ContextManagerShell({
  selectedProjectId,
  projectPath,
  projectName,
  onBack,
}: ContextManagerShellProps) {
  const hasProject = !!selectedProjectId && !!projectPath

  const [active, setActive] = useState<ActiveItem>(
    () => ({ type: 'content', level: hasProject ? 'project' : 'computer', section: 'instructions' })
  )

  const handleSectionClick = useCallback((level: ConfigLevel, section: Section) => {
    setActive({ type: 'content', level, section })
  }, [])

  const renderContent = () => {
    if (active.type === 'providers') {
      return (
        <ProviderSyncSection
          projectId={selectedProjectId}
          projectName={projectName}
        />
      )
    }

    const { level, section } = active

    if (section === 'instructions') {
      return (
        <InstructionsSection
          level={level}
          projectId={selectedProjectId}
          projectPath={projectPath}
        />
      )
    }

    if (section === 'skills') {
      return (
        <SkillsSection
          level={level}
          projectId={selectedProjectId}
          projectPath={projectPath}
        />
      )
    }

    if (section === 'mcps') {
      return (
        <McpSection
          level={level}
          projectId={selectedProjectId}
          projectPath={projectPath}
        />
      )
    }

    return null
  }

  return (
    <div className="flex h-full flex-col bg-surface-0">
      <header className="flex shrink-0 items-center gap-4 border-b px-4 py-2.5">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
        </button>
        <h1 className="text-base font-semibold">Context Manager</h1>
      </header>

      <div className="flex flex-1 min-h-0">
        {/* Sidebar */}
        <nav className="w-56 shrink-0 border-r border-border/50 p-3 space-y-1 overflow-y-auto">
          {/* Providers — standalone item */}
          <button
            onClick={() => setActive({ type: 'providers' })}
            className={cn(
              'flex w-full items-center gap-3 rounded-lg px-4 py-2.5 text-sm transition-colors',
              active.type === 'providers'
                ? 'bg-surface-2 font-medium text-foreground ring-1 ring-border'
                : 'text-muted-foreground hover:bg-surface-1 hover:text-foreground'
            )}
          >
            <Settings2 className="size-4" />
            Providers
          </button>

          <div className="h-px bg-border/50 my-2" />

          {/* Level groups */}
          {LEVELS.map(({ id: levelId, label: levelLabel, icon: LevelIcon }) => {
            const isDisabled = levelId === 'project' && !hasProject
            const isExpanded = active.type === 'content' && active.level === levelId

            return (
              <Collapsible
                key={levelId}
                open={isExpanded}
                onOpenChange={(open) => {
                  if (open && !isDisabled) {
                    const section = active.type === 'content' ? active.section : 'instructions'
                    setActive({ type: 'content', level: levelId, section })
                  }
                }}
              >
                <CollapsibleTrigger
                  disabled={isDisabled}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors',
                    isExpanded
                      ? 'text-foreground'
                      : 'text-muted-foreground hover:bg-surface-1 hover:text-foreground',
                    isDisabled && 'pointer-events-none opacity-40'
                  )}
                >
                  <ChevronRight className={cn('size-3 transition-transform', isExpanded && 'rotate-90')} />
                  <LevelIcon className="size-4" />
                  {levelLabel}
                </CollapsibleTrigger>

                <CollapsibleContent>
                  <div className="ml-5 space-y-0.5 py-0.5">
                    {SECTION_ITEMS.map(({ id: sectionId, label: sectionLabel, icon: SectionIcon }) => {
                      const isActive = active.type === 'content' && active.level === levelId && active.section === sectionId
                      return (
                        <button
                          key={sectionId}
                          onClick={() => handleSectionClick(levelId, sectionId)}
                          className={cn(
                            'flex w-full items-center gap-2.5 rounded-md px-3 py-1.5 text-xs transition-colors',
                            isActive
                              ? 'bg-surface-2 font-medium text-foreground ring-1 ring-border'
                              : 'text-muted-foreground hover:bg-surface-1 hover:text-foreground'
                          )}
                        >
                          <SectionIcon className="size-3.5" />
                          {sectionLabel}
                        </button>
                      )
                    })}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            )
          })}
        </nav>

        {/* Main content */}
        <div className="flex-1 min-h-0 min-w-0 overflow-y-auto p-6">
          {renderContent()}
        </div>
      </div>
    </div>
  )
}
