import { useCallback } from 'react'
import { ArrowLeft, FileText, FolderOpen, Server, Settings2, Sparkles, Store } from 'lucide-react'
import { cn } from '@slayzone/ui'
import { ProviderSyncSection } from './ProviderSyncSection'
import { InstructionsSection } from './InstructionsSection'
import { SkillsSection } from './SkillsSection'
import { McpSection } from './McpSection'
import { ComputerFilesView } from './ComputerFilesView'
import { SkillMarketplace } from './SkillMarketplace'
import { useContextManagerStore } from './useContextManagerStore'
import type { ConfigLevel } from '../shared'

export interface ContextManagerShellProps {
  selectedProjectId: string | null
  projectPath?: string | null
  projectName?: string
  onBack: () => void
}

type Section = 'provider-sync' | 'instructions' | 'skills' | 'mcps' | 'files' | 'marketplace'

const STANDARD_SECTIONS: { id: Section; label: string; icon: typeof Sparkles }[] = [
  { id: 'instructions', label: 'Instructions', icon: FileText },
  { id: 'skills', label: 'Skills', icon: Sparkles },
  { id: 'mcps', label: 'MCPs', icon: Server },
]

const LEVEL_SECTIONS: Record<ConfigLevel, { id: Section; label: string; icon: typeof Sparkles }[]> = {
  computer: [{ id: 'files', label: 'Files', icon: FolderOpen }],
  project: STANDARD_SECTIONS,
  library: STANDARD_SECTIONS,
}

const EXTERNAL_SECTIONS: { id: Section; label: string; icon: typeof Sparkles }[] = [
  { id: 'marketplace', label: 'Marketplace', icon: Store },
]

const LEVELS: { id: ConfigLevel; label: string }[] = [
  { id: 'computer', label: 'Computer' },
  { id: 'project', label: 'Project' },
  { id: 'library', label: 'Library' },
]

export function ContextManagerShell({
  selectedProjectId,
  projectPath,
  projectName,
  onBack,
}: ContextManagerShellProps) {
  const hasProject = !!selectedProjectId && !!projectPath

  const activeLevel = useContextManagerStore((s) => s.activeLevel)
  const activeSection = useContextManagerStore((s) => s.activeSection)
  const setActive = useContextManagerStore((s) => s.setActive)

  // "providers" is a special view, track it locally (not worth persisting)
  const isProviders = activeSection === 'provider-sync'

  const handleSectionClick = useCallback((level: ConfigLevel, section: string) => {
    setActive(level, section)
  }, [setActive])

  const renderContent = () => {
    if (isProviders) {
      return (
        <ProviderSyncSection
          projectId={selectedProjectId}
          projectName={projectName}
        />
      )
    }

    const level = activeLevel
    const section = activeSection

    if (section === 'files') {
      return <ComputerFilesView />
    }

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

    if (section === 'marketplace') {
      return <SkillMarketplace projectId={selectedProjectId} projectPath={projectPath} />
    }

    return null
  }

  return (
    <div className="flex h-full bg-surface-0">
      {/* Sidebar */}
      <nav className="mr-3 w-56 shrink-0 rounded-xl border border-border/50 bg-surface-2 flex flex-col overflow-y-auto">
        <header className="flex items-center gap-3 px-4 py-3">
          <button
            onClick={onBack}
            className="text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="size-4" />
          </button>
          <h1 className="text-sm font-semibold">Context Manager</h1>
        </header>

        <div className="h-px bg-border/50 mx-3" />

        <div className="flex-1 p-3 space-y-4">
          {/* Level groups */}
          {LEVELS.map(({ id: levelId, label: levelLabel }) => {
            const isDisabled = levelId === 'project' && !hasProject

            return (
              <div key={levelId} className={cn(isDisabled && 'pointer-events-none opacity-40')}>
                <div className="px-4 py-1 text-[11px] uppercase tracking-widest text-muted-foreground/60">
                  {levelLabel}
                </div>
                <div className="space-y-0.5">
                  {LEVEL_SECTIONS[levelId].map(({ id: sectionId, label: sectionLabel, icon: SectionIcon }) => {
                    const isActive = !isProviders && activeLevel === levelId && activeSection === sectionId
                    return (
                      <button
                        key={sectionId}
                        onClick={() => handleSectionClick(levelId, sectionId)}
                        className={cn(
                          'flex w-full items-center gap-2.5 rounded-md px-4 py-1.5 text-xs transition-colors',
                          isActive
                            ? 'bg-surface-3 font-medium text-foreground ring-1 ring-border'
                            : 'text-muted-foreground hover:bg-surface-3 hover:text-foreground'
                        )}
                      >
                        <SectionIcon className="size-3.5" />
                        {sectionLabel}
                      </button>
                    )
                  })}
                </div>
              </div>
            )
          })}

          {/* External */}
          <div>
            <div className="px-4 py-1 text-[11px] uppercase tracking-widest text-muted-foreground/60">
              External
            </div>
            <div className="space-y-0.5">
              {EXTERNAL_SECTIONS.map(({ id: sectionId, label: sectionLabel, icon: SectionIcon }) => {
                const isActive = !isProviders && activeSection === sectionId
                return (
                  <button
                    key={sectionId}
                    onClick={() => handleSectionClick(activeLevel, sectionId)}
                    className={cn(
                      'flex w-full items-center gap-2.5 rounded-md px-4 py-1.5 text-xs transition-colors',
                      isActive
                        ? 'bg-surface-3 font-medium text-foreground ring-1 ring-border'
                        : 'text-muted-foreground hover:bg-surface-3 hover:text-foreground'
                    )}
                  >
                    <SectionIcon className="size-3.5" />
                    {sectionLabel}
                  </button>
                )
              })}
            </div>
          </div>
        </div>

        {/* Providers — pinned to bottom */}
        <div className="shrink-0 border-t border-border/50 mx-3" />
        <div className="shrink-0 p-3">
          <button
            onClick={() => setActive(activeLevel, 'provider-sync')}
            className={cn(
              'flex w-full items-center gap-3 rounded-lg px-4 py-2.5 text-sm transition-colors',
              isProviders
                ? 'bg-surface-3 font-medium text-foreground ring-1 ring-border'
                : 'text-muted-foreground hover:bg-surface-3 hover:text-foreground'
            )}
          >
            <Settings2 className="size-4" />
            Providers
          </button>
        </div>
      </nav>

      {/* Main content */}
      <div className="flex-1 min-h-0 min-w-0 rounded-xl border border-border/50 bg-surface-2 flex flex-col overflow-hidden p-6">
        {activeSection === 'marketplace' && !isProviders ? (
          <div className="flex-1 min-h-0 flex flex-col">
            {renderContent()}
          </div>
        ) : (
          <>
            <div className="shrink-0 flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">
                {isProviders
                  ? 'Providers'
                  : `${LEVELS.find((l) => l.id === activeLevel)!.label} — ${LEVEL_SECTIONS[activeLevel].find((s) => s.id === activeSection)?.label ?? activeSection}`}
              </h2>
              <div id="context-manager-header-actions" />
            </div>
            <div className="flex-1 min-h-0">
              {renderContent()}
            </div>
          </>
        )}
      </div>

      {/* Drag handle — populated via portal from SkillsSection */}
      <div id="context-manager-resize-handle" className="flex items-center" />

      {/* Editor panel — populated via portal from SkillsSection */}
      <div id="context-manager-editor-panel" className="shrink-0 empty:hidden rounded-xl border border-border/50 bg-surface-2 overflow-y-auto p-6 flex flex-col" />
    </div>
  )
}
