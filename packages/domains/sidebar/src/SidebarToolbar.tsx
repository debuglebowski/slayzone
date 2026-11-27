import type { ReactNode } from 'react'
import {
  BarChart3,
  Check,
  ChevronsDownUp,
  ChevronsUpDown,
  FolderPlus,
  Handshake,
  Keyboard,
  Megaphone,
  MessageSquare,
  MoreHorizontal,
  Plus,
  Search,
  Settings,
  Trophy,
  Eye
} from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  cn,
  useShortcutDisplay
} from '@slayzone/ui'
import { useDialogStore } from '@slayzone/dialogs'
import { useTabStore } from '@slayzone/tabs-state'
import type { Project } from '@slayzone/projects-contracts'
import { LensMenu, useActiveLens } from './lenses/LensMenu'
import { LensEditDialog } from './lenses/LensEditDialog'
import { LensIconView } from './lenses/lens-icons'
import { GettingStartedPopover } from './GettingStartedPopover'
import { viewRegistry } from './views/registry'
import type { OnboardingChecklistState, SidebarFooterSlot } from './types'

/**
 * The tree view's bottom toolbar: New, Search, Lens, Setup and More, evenly spaced.
 * Each button shows its label once the sidebar is wide enough (container query on
 * the footer). Everything the old footer icon row and its More menu offered lives
 * here; host-only entries (explode mode, agent panels, restart to update) come in
 * through `moreItems`.
 */
export function SidebarToolbar({
  projects,
  onboardingChecklist,
  onSettings,
  onUsageAnalytics,
  onLeaderboard,
  onCreateProjectGroup,
  convexConfigured,
  moreItems,
  sharedSlot,
  onManageLenses
}: {
  projects: Project[]
  onboardingChecklist: OnboardingChecklistState | null
  onSettings: () => void
  onUsageAnalytics: () => void
  onLeaderboard: () => void
  onCreateProjectGroup?: (name?: string) => void
  convexConfigured?: boolean
  moreItems?: ReactNode
  /** App-supplied "Shared" entry (files shared with the user on their own); nothing while nothing is shared. */
  sharedSlot?: SidebarFooterSlot
  /** Open Settings › Lenses; absent = no "Manage lenses…" entry. */
  onManageLenses?: () => void
}): React.JSX.Element {
  const searchShortcut = useShortcutDisplay('search')
  const settingsShortcut = useShortcutDisplay('global-settings')
  const sidebarView = useTabStore((s) => s.sidebarView)
  const showAll = useTabStore((s) => s.treeShowAllProjects)
  const openProjects = useTabStore((s) => s.treeOpenProjects)
  const anyOpen = projects.some((p) => openProjects[p.id])
  const { lens, dirty } = useActiveLens()
  const setupPending =
    onboardingChecklist !== null &&
    onboardingChecklist.hasRemaining &&
    !onboardingChecklist.dismissed

  return (
    <div className="@container/toolbar w-full">
      <div className="flex items-center justify-between gap-1 px-1">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <ToolbarButton icon={<Plus />} label="New" title="New project or folder" />
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" className="min-w-[200px]">
            <DropdownMenuItem onSelect={() => useDialogStore.getState().openCreateProject()}>
              <Plus className="size-4" />
              <span>New project…</span>
            </DropdownMenuItem>
            {onCreateProjectGroup && (
              <DropdownMenuItem onSelect={() => onCreateProjectGroup()}>
                <FolderPlus className="size-4" />
                <span>New folder</span>
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        <ToolbarButton
          icon={<Search />}
          label="Search"
          title={searchShortcut ? `Search (${searchShortcut})` : 'Search'}
          onClick={() => useDialogStore.getState().openSearch()}
        />

        <LensMenu
          onManageLenses={onManageLenses}
          trigger={
            <ToolbarButton
              icon={<LensIconView icon={lens.icon} />}
              label={lens.name}
              ariaLabel="Lens"
              title={`Lens: ${lens.name}${dirty ? ' (unsaved changes)' : ''}`}
              dot={dirty}
              data-testid="lens-button"
              data-lens-id={lens.id}
            />
          }
        />
        <LensEditDialog />

        {onboardingChecklist && setupPending && (
          <GettingStartedPopover
            layout="horizontal"
            tooltipSide="top"
            onboardingChecklist={onboardingChecklist}
            trigger={
              <ToolbarButton
                icon={<Handshake />}
                label="Setup"
                title="Getting started"
                badge={onboardingChecklist.remainingCount}
              />
            }
          />
        )}

        {sharedSlot?.({ layout: 'horizontal', tooltipSide: 'top' })}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <ToolbarButton icon={<MoreHorizontal />} label="More" title="More" />
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="end" className="min-w-[250px]">
            <DropdownMenuItem
              onSelect={(e) => {
                e.preventDefault()
                useTabStore.getState().setTreeShowAllProjects(!showAll)
              }}
            >
              <Eye className="size-4" />
              <span>Show all projects</span>
              {showAll && <Check className="size-4 col-start-3" />}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() =>
                useTabStore.getState().setTreeProjectsOpen(
                  projects.map((p) => p.id),
                  !anyOpen
                )
              }
            >
              {anyOpen ? (
                <ChevronsDownUp className="size-4" />
              ) : (
                <ChevronsUpDown className="size-4" />
              )}
              <span>{anyOpen ? 'Collapse all' : 'Expand all'}</span>
            </DropdownMenuItem>
            <SidebarLayoutSubmenu current={sidebarView} />
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onSettings}>
              <Settings className="size-4" />
              <span>Settings</span>
              {settingsShortcut && <DropdownMenuShortcut>{settingsShortcut}</DropdownMenuShortcut>}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => useDialogStore.getState().openShortcuts()}>
              <Keyboard className="size-4" />
              <span>Keyboard Shortcuts</span>
            </DropdownMenuItem>
            {onboardingChecklist && !setupPending && (
              <GettingStartedPopover
                layout="horizontal"
                tooltipSide="top"
                onboardingChecklist={onboardingChecklist}
                trigger={
                  <DropdownMenuItem onSelect={(e) => e.preventDefault()}>
                    <Handshake className="size-4" />
                    <span>Getting started</span>
                  </DropdownMenuItem>
                }
              />
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => useDialogStore.getState().openChangelog()}>
              <Megaphone className="size-4" />
              <span>What's New</span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onUsageAnalytics}>
              <BarChart3 className="size-4" />
              <span>Usage Analytics</span>
            </DropdownMenuItem>
            {convexConfigured && (
              <DropdownMenuItem onSelect={onLeaderboard}>
                <Trophy className="size-4" />
                <span>Leaderboard</span>
              </DropdownMenuItem>
            )}
            {moreItems}
            {convexConfigured && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => useDialogStore.getState().openFeedback()}>
                  <MessageSquare className="size-4" />
                  <span>Send feedback</span>
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}

/** "Layout ›" submenu: switch the sidebar between Tree and Tabs, plus auto-hide. */
export function SidebarLayoutSubmenu({ current }: { current: string }): React.JSX.Element {
  const autoHide = useTabStore((s) => s.sidebarAutoHide)
  const autoHideShortcut = useShortcutDisplay('sidebar-auto-hide')
  const currentLabel = viewRegistry.find((v) => v.id === current)?.label ?? ''
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        {(() => {
          const Icon = viewRegistry.find((v) => v.id === current)?.icon
          return Icon ? <Icon className="size-4" /> : null
        })()}
        <span>
          Layout <span className="text-muted-foreground">· {currentLabel}</span>
        </span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="min-w-[200px]">
        {viewRegistry.map((v) => (
          <DropdownMenuItem key={v.id} onSelect={() => useTabStore.getState().setSidebarView(v.id)}>
            <v.icon className="size-4" />
            <span>{v.label}</span>
            {current === v.id && <Check className="size-4 col-start-3" />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={(e) => {
            e.preventDefault()
            useTabStore.getState().setSidebarAutoHide(!autoHide)
          }}
        >
          <span>Auto-hide sidebar</span>
          {autoHideShortcut && <DropdownMenuShortcut>{autoHideShortcut}</DropdownMenuShortcut>}
          {autoHide && <Check className="size-4 col-start-3" />}
        </DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

/**
 * One toolbar button: an icon, plus its label when the toolbar is at least 420px wide.
 * Forwards props so it can be a Radix trigger (`asChild`). `ariaLabel` names it when the
 * visible label varies (the Lens button shows the lens name); `dot` marks unsaved edits.
 */
function ToolbarButton({
  icon,
  label,
  ariaLabel,
  title,
  badge,
  dot,
  className,
  ...props
}: {
  icon: ReactNode
  label: string
  ariaLabel?: string
  title: string
  badge?: number
  dot?: boolean
} & React.ComponentProps<'button'>): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label={ariaLabel ?? label}
      title={title}
      className={cn(
        'relative inline-flex h-8 min-w-8 shrink-0 items-center justify-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground [&_svg]:size-4',
        className
      )}
      {...props}
    >
      {icon}
      <span className="hidden max-w-[120px] truncate @[420px]/toolbar:inline">{label}</span>
      {dot && (
        <span
          aria-hidden
          data-testid="toolbar-button-dot"
          className="absolute top-1 right-1 size-1.5 rounded-full bg-primary"
        />
      )}
      {badge != null && badge > 0 && (
        <span className="absolute -top-0.5 right-0 min-w-4 rounded-full bg-primary px-1 text-[10px] font-semibold leading-4 text-primary-foreground">
          {badge}
        </span>
      )}
    </button>
  )
}
