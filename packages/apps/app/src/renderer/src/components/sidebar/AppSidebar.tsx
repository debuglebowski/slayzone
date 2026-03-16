import { useState } from 'react'
import { Settings, Keyboard, ChevronDown, Megaphone, Check, CheckCheck, Trophy, BarChart3 } from 'lucide-react'
import { isConvexConfigured } from '@/lib/convexAuth'
import { FeedbackDialog } from '../feedback/FeedbackDialog'
import { FaRegHandshake } from 'react-icons/fa'
import * as Collapsible from '@radix-ui/react-collapsible'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuItem
} from '@slayzone/ui'
import { IconButton } from '@slayzone/ui'
import { Tooltip, TooltipTrigger, TooltipContent, Popover, PopoverTrigger, PopoverContent } from '@slayzone/ui'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription
} from '@slayzone/ui'
import { ProjectItem } from './ProjectItem'
import { TerminalStatusPopover } from '@slayzone/terminal'
import { cn, useAppearance } from '@slayzone/ui'
import { useTabStore } from '@slayzone/settings'
import type { Task } from '@slayzone/task/shared'
import type { Project } from '@slayzone/projects/shared'
import type { OnboardingChecklistState } from '@/hooks/useOnboardingChecklist'

interface AppSidebarProps {
  projects: Project[]
  tasks: Task[]
  selectedProjectId: string
  onSelectProject: (id: string) => void
  onAddProject: () => void
  onProjectSettings: (project: Project) => void
  onProjectDelete: (project: Project) => void
  onSettings: () => void
  onChangelog: () => void
  onUsageAnalytics: () => void
  onLeaderboard: () => void
  onTaskClick?: (taskId: string) => void
  zenMode?: boolean
  onboardingChecklist: OnboardingChecklistState
  attentionByProject: Map<string, number>
}

const isMac = navigator.platform.startsWith('Mac')

const shortcutGroups = [
  { heading: 'General', items: [
    { label: 'New Task', keys: isMac ? '⌘ N' : 'Ctrl N' },
    { label: 'Search', keys: isMac ? '⌘ K' : 'Ctrl K' },
    { label: 'Complete & Close Tab', keys: isMac ? '⌘ ⇧ D' : 'Ctrl ⇧ D' },
    { label: 'Zen Mode', keys: isMac ? '⌘ J' : 'Ctrl J' },
    { label: 'Explode Mode', keys: isMac ? '⌘ ⇧ E' : 'Ctrl ⇧ E' },
    { label: 'Exit Zen / Explode', keys: 'Esc' },
    { label: 'Global Settings', keys: isMac ? '⌘ ,' : 'Ctrl ,' },
    { label: 'Project Settings', keys: isMac ? '⌘ ⇧ ,' : 'Ctrl ⇧ ,' },
    ...(isMac ? [{ label: 'Go Home', keys: '⌘ §' }] : []),
  ]},
  { heading: 'Tabs', items: [
    { label: 'Close Sub-panel / Tab', keys: isMac ? '⌘ W' : 'Ctrl W' },
    { label: 'Close Task', keys: isMac ? '⌘ ⇧ W' : 'Ctrl ⇧ W' },
    { label: 'Switch Tab 1–9', keys: isMac ? '⌘ 1–9' : 'Ctrl 1–9' },
    { label: 'Next Tab', keys: '^ Tab' },
    { label: 'Previous Tab', keys: '^ ⇧ Tab' },
    { label: 'Reopen Closed Tab', keys: isMac ? '⌘ ⇧ T' : 'Ctrl ⇧ T' },
    { label: 'New Temporary Task', keys: isMac ? '⌘ ⇧ N' : 'Ctrl ⇧ N' },
  ]},
  { heading: 'Task Panels', items: [
    { label: 'Terminal', keys: '⌘ T' },
    { label: 'Browser', keys: '⌘ B' },
    { label: 'Editor', keys: '⌘ E' },
    { label: 'Quick Open File', keys: '⌘ P' },
    { label: 'Git', keys: '⌘ G' },
    { label: 'Git Diff', keys: '⌘ ⇧ G' },
    { label: 'Settings', keys: '⌘ S' },
  ]},
  { heading: 'Terminal', items: [
    { label: 'Inject Title', keys: '⌘ I' },
    { label: 'Inject Description', keys: '⌘ ⇧ I' },
    { label: 'Screenshot', keys: '⌘ ⇧ S' },
    { label: 'Search', keys: '⌘ F' },
    { label: 'Clear Buffer', keys: '⌘ ⇧ K' },
    { label: 'New Group', keys: '⌘ T' },
    { label: 'Split', keys: '⌘ D' },
  ]},
]

export function AppSidebar({
  projects,
  tasks,
  selectedProjectId,
  onSelectProject,
  onAddProject,
  onProjectSettings,
  onProjectDelete,
  onSettings,
  onChangelog,
  onUsageAnalytics,
  onLeaderboard,
  onTaskClick,
  zenMode,
  onboardingChecklist,
  attentionByProject,
}: AppSidebarProps) {
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [checklistOpen, setChecklistOpen] = useState(false)
  const { sidebarBadgeMode } = useAppearance()
  const activeTabType = useTabStore((s) => s.tabs[s.activeTabIndex]?.type)

  return (
    <Sidebar collapsible="none" className={zenMode ? "!w-0 h-svh overflow-hidden" : "w-18 h-svh"}>
      {/* Draggable region for window movement - clears traffic lights */}
      <div className="h-10 window-drag-region" />
      <SidebarContent className="py-4 pt-0 scrollbar-hide">
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu className="flex flex-col items-center gap-2">
              {/* Project blobs */}
              {projects.map((project) => (
                <SidebarMenuItem key={project.id}>
                  <ProjectItem
                    project={project}
                    selected={selectedProjectId === project.id}
                    onClick={() => onSelectProject(project.id)}
                    onSettings={() => onProjectSettings(project)}
                    onDelete={() => onProjectDelete(project)}
                    attentionCount={attentionByProject.get(project.id) ?? 0}
                    badgeMode={sidebarBadgeMode}
                  />
                </SidebarMenuItem>
              ))}

              {/* Add project button */}
              <SidebarMenuItem>
                <button
                  onClick={onAddProject}
                  className={cn(
                    'w-10 h-10 rounded-lg flex items-center justify-center',
                    'text-lg text-muted-foreground border-2 border-dashed',
                    'hover:border-primary hover:text-primary transition-colors'
                  )}
                  title="Add project"
                >
                  +
                </button>
              </SidebarMenuItem>

            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="py-4">
        <SidebarMenu>
          <SidebarMenuItem className="flex flex-col items-center gap-2">
            <TerminalStatusPopover tasks={tasks} onTaskClick={onTaskClick} />

            {isConvexConfigured && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <IconButton
                    aria-label="Leaderboard"
                    variant="ghost"
                    size="icon-lg"
                    onClick={onLeaderboard}
                    className={cn('rounded-lg', activeTabType === 'leaderboard' ? 'bg-primary text-primary-foreground shadow-md ring-1 ring-primary/30 hover:!bg-primary hover:!text-primary-foreground' : 'text-muted-foreground')}
                  >
                    <Trophy className="size-5" />
                  </IconButton>
                </TooltipTrigger>
                <TooltipContent side="right">Leaderboard</TooltipContent>
              </Tooltip>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <IconButton
                  aria-label="Usage Analytics"
                  variant="ghost"
                  size="icon-lg"
                  onClick={onUsageAnalytics}
                  className={cn('rounded-lg', activeTabType === 'usage-analytics' ? 'bg-primary text-primary-foreground shadow-md ring-1 ring-primary/30 hover:!bg-primary hover:!text-primary-foreground' : 'text-muted-foreground')}
                >
                  <BarChart3 className="size-5" />
                </IconButton>
              </TooltipTrigger>
              <TooltipContent side="right">Usage</TooltipContent>
            </Tooltip>
            <Popover open={checklistOpen} onOpenChange={setChecklistOpen}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      aria-label="Getting Started"
                      className={cn(
                        'relative inline-flex h-11 w-11 items-center justify-center rounded-lg transition-colors',
                        'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                        onboardingChecklist.dismissed && 'opacity-80'
                      )}
                    >
                      <FaRegHandshake className="size-5" />
                      {onboardingChecklist.hasRemaining && !onboardingChecklist.dismissed && (
                        <span className="absolute -top-1 -right-1 min-w-4 rounded-full bg-primary px-1 text-[10px] font-semibold leading-4 text-primary-foreground">
                          {onboardingChecklist.remainingCount}
                        </span>
                      )}
                    </button>
                  </PopoverTrigger>
                </TooltipTrigger>
                <TooltipContent side="right">Getting Started</TooltipContent>
              </Tooltip>
              <PopoverContent side="right" align="end" sideOffset={12} className="w-[320px] p-3">
                <div className="mb-5 flex items-center justify-between gap-2">
                  <p className="pt-0.5 text-base font-semibold">Getting started</p>
                  {onboardingChecklist.hasRemaining && !onboardingChecklist.dismissed && (
                    <button
                      type="button"
                      aria-label="Complete all items"
                      onClick={() => {
                        onboardingChecklist.onDismiss()
                        setChecklistOpen(false)
                      }}
                      className="mr-1 inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                    >
                      <CheckCheck className="size-4" />
                    </button>
                  )}
                </div>
                <div className="space-y-2">
                  {onboardingChecklist.steps.map((step, index) => {
                    const disabled = step.disabled || (step.completed && !step.allowWhenCompleted)

                    return (
                      <button
                        key={step.id}
                        type="button"
                        onClick={() => {
                          step.onClick()
                          setChecklistOpen(false)
                        }}
                        disabled={disabled}
                        className={cn(
                          'group flex w-full items-center justify-between rounded-lg px-2.5 py-2.5 text-left text-sm transition-colors',
                          step.completed
                            ? disabled
                              ? 'text-muted-foreground'
                              : 'text-muted-foreground hover:bg-muted/35'
                            : step.disabled
                              ? 'cursor-not-allowed border border-border/60 bg-muted/25 text-muted-foreground/50 shadow-[0_1px_0_rgba(255,255,255,0.03)]'
                              : 'border border-border/70 bg-muted/35 shadow-[0_1px_0_rgba(255,255,255,0.03)] hover:border-border hover:bg-muted/55'
                        )}
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          <span
                            className={cn(
                              'inline-flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold',
                              step.disabled
                                ? 'border-border bg-muted text-muted-foreground/60'
                                : 'border-border bg-background text-muted-foreground group-hover:bg-muted'
                            )}
                          >
                            {index + 1}
                          </span>
                          <span
                            className={cn(
                              'truncate',
                              step.completed && 'line-through decoration-muted-foreground/70'
                            )}
                          >
                            {step.label}
                          </span>
                        </div>
                        {step.completed ? (
                          <Check className="size-4 text-green-500" />
                        ) : (
                          <span className="h-4 w-4 rounded-full border border-border" />
                        )}
                      </button>
                    )
                  })}
                </div>
              </PopoverContent>
            </Popover>
            <Tooltip>
              <TooltipTrigger asChild>
                <IconButton
                  aria-label="What's New"
                  variant="ghost"
                  size="icon-lg"
                  onClick={onChangelog}
                  className="rounded-lg text-muted-foreground"
                >
                  <Megaphone className="size-5" />
                </IconButton>
              </TooltipTrigger>
              <TooltipContent side="right">What's New</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <IconButton
                  aria-label="Keyboard Shortcuts"
                  variant="ghost"
                  size="icon-lg"
                  onClick={() => setShortcutsOpen(true)}
                  className="rounded-lg text-muted-foreground"
                >
                  <Keyboard className="size-5" />
                </IconButton>
              </TooltipTrigger>
              <TooltipContent side="right">Keyboard Shortcuts</TooltipContent>
            </Tooltip>
            {isConvexConfigured && <FeedbackDialog />}
            <Dialog open={shortcutsOpen} onOpenChange={setShortcutsOpen}>
              <DialogContent className="max-h-[80vh] flex flex-col">
                <DialogHeader>
                  <DialogTitle>Keyboard Shortcuts</DialogTitle>
                  <DialogDescription className="sr-only">List of keyboard shortcuts</DialogDescription>
                </DialogHeader>
                <div className="space-y-1 overflow-y-auto scrollbar-thin">
                  {shortcutGroups.map((group, i) => (
                    <Collapsible.Root key={group.heading} defaultOpen={i === 0}>
                      <Collapsible.Trigger className="flex w-full items-center justify-between px-3 py-2 rounded-lg bg-muted hover:bg-accent hover:text-accent-foreground transition-colors group/trigger">
                        <p className="text-[11px] uppercase tracking-wider font-semibold text-muted-foreground">{group.heading}</p>
                        <ChevronDown className="size-3.5 text-muted-foreground transition-transform duration-200 group-data-[state=open]/trigger:rotate-180" />
                      </Collapsible.Trigger>
                      <Collapsible.Content className="data-[state=closed]:hidden">
                        <div className="rounded-lg border divide-y mb-3">
                          {group.items.map((s) => (
                            <div key={s.label} className="flex items-center justify-between px-3 py-2">
                              <span className="text-sm">{s.label}</span>
                              <span className="text-base text-muted-foreground bg-muted border px-2.5 py-0.5 rounded-md font-[system-ui] shadow-[0_1px_0_0_rgba(0,0,0,0.05)]">{s.keys}</span>
                            </div>
                          ))}
                        </div>
                      </Collapsible.Content>
                    </Collapsible.Root>
                  ))}
                </div>
              </DialogContent>
            </Dialog>
            <Tooltip>
              <TooltipTrigger asChild>
                <IconButton
                  aria-label="Settings"
                  variant="ghost"
                  size="icon-lg"
                  onClick={onSettings}
                  className="rounded-lg text-muted-foreground"
                >
                  <Settings className="size-5" />
                </IconButton>
              </TooltipTrigger>
              <TooltipContent side="right">Settings</TooltipContent>
            </Tooltip>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  )
}
