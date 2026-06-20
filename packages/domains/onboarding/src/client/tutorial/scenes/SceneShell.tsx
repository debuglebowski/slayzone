import {
  Home,
  X,
  Terminal,
  FileCode,
  Globe,
  GitBranch,
  Zap,
  Settings,
  type LucideIcon
} from 'lucide-react'

const PROJECTS = [
  { abbr: 'SZ', color: '#3b82f6' },
  { abbr: 'BE', color: '#10b981' },
  { abbr: 'MB', color: '#8b5cf6' }
]

interface TabDef {
  label: string
  active?: boolean
  dot?: boolean
}

export interface PanelButton {
  icon: LucideIcon
  label: string
  active: boolean
}

export const ALL_PANEL_BUTTONS: PanelButton[] = [
  { icon: Terminal, label: 'Terminal', active: false },
  { icon: FileCode, label: 'Editor', active: false },
  { icon: Globe, label: 'Browser', active: false },
  { icon: GitBranch, label: 'Git', active: false },
  { icon: Zap, label: 'Processes', active: false },
  { icon: Settings, label: 'Settings', active: false }
]

/** Returns panel buttons with the given labels set to active */
export function panelButtons(...activeLabels: string[]): PanelButton[] {
  return ALL_PANEL_BUTTONS.map((b) => ({
    ...b,
    active: activeLabels.includes(b.label)
  }))
}

export function TaskHeader({
  title,
  panels
}: {
  title: string
  panels: PanelButton[]
}): React.JSX.Element {
  return (
    <div className="h-16 shrink-0 border-b flex items-center justify-between px-6">
      <h2 className="text-[20px] font-semibold truncate">{title}</h2>
      <div className="flex items-center gap-1">
        {panels.map(({ icon: Icon, label, active }) => (
          <div
            key={label}
            className={`h-10 px-3 rounded flex items-center gap-2 text-[16px] ${active ? 'bg-muted text-foreground' : 'text-muted-foreground/60'}`}
          >
            <Icon className="size-5" />
            <span>{label}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

interface SceneShellProps {
  /** Which project index is active (ring highlight). Default 0. */
  activeProject?: number
  /** Tabs to show after the Home icon tab. */
  tabs?: TabDef[]
  children: React.ReactNode
}

export function SceneShell({
  activeProject = 0,
  tabs,
  children
}: SceneShellProps): React.JSX.Element {
  return (
    <div className="w-full h-full flex rounded-2xl bg-surface-0 overflow-hidden relative">
      {/* Sidebar */}
      <div className="w-20 shrink-0 border-r flex flex-col items-center">
        <div className="flex flex-col items-center gap-3 pt-3 pb-4">
          <div className="w-14 h-14 rounded-xl bg-muted flex items-center justify-center text-[14px] font-semibold">
            All
          </div>

          {PROJECTS.map((p, i) => (
            <div
              key={p.abbr}
              className="w-14 h-14 rounded-xl flex items-center justify-center text-[14px] font-semibold text-white shrink-0"
              style={{
                backgroundColor: p.color,
                boxShadow:
                  i === activeProject
                    ? `0 0 0 4px var(--background), 0 0 0 8px ${p.color}`
                    : undefined
              }}
            >
              {p.abbr}
            </div>
          ))}

          <div className="w-14 h-14 rounded-xl border-4 border-dashed border-muted-foreground/30 flex items-center justify-center text-muted-foreground/50 text-2xl leading-none">
            +
          </div>
        </div>
      </div>

      {/* Right column */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Tab bar */}
        <div className="h-[72px] shrink-0 flex items-center gap-2 px-4 bg-neutral-100 dark:bg-neutral-900/80">
          <div className="h-12 px-4 rounded-lg flex items-center gap-2 bg-neutral-200 dark:bg-neutral-700 border border-neutral-300 dark:border-neutral-600 shrink-0">
            <Home className="size-6 text-neutral-600 dark:text-neutral-300" />
          </div>
          {tabs?.map((tab) => (
            <div
              key={tab.label}
              className={`h-12 px-5 rounded-lg flex items-center gap-3 shrink-0 ${
                tab.active
                  ? 'bg-neutral-200 dark:bg-neutral-700 border border-neutral-300 dark:border-neutral-600'
                  : 'bg-neutral-100 dark:bg-neutral-800/50 text-neutral-500 dark:text-neutral-400'
              }`}
            >
              {tab.dot && <span className="w-3 h-3 rounded-full bg-green-500 shrink-0" />}
              <span className="text-[18px] font-medium">{tab.label}</span>
              <X className="size-4 text-muted-foreground/60 shrink-0" />
            </div>
          ))}
        </div>

        {/* Scene content */}
        {children}
      </div>
    </div>
  )
}
