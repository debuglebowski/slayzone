import { useState } from 'react'
import { Settings, Keyboard, ChevronDown, Sun, Moon, Megaphone } from 'lucide-react'
import { IoCompassSharp } from 'react-icons/io5'
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
import { Button } from '@slayzone/ui'
import { toast } from '@slayzone/ui'
import { Tooltip, TooltipTrigger, TooltipContent } from '@slayzone/ui'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription
} from '@slayzone/ui'
import { ProjectItem } from './ProjectItem'
import { TerminalStatusPopover } from '@slayzone/terminal'
import { cn } from '@slayzone/ui'
import { useTheme } from '@slayzone/settings'
import type { Task } from '@slayzone/task/shared'
import type { Project } from '@slayzone/projects/shared'

interface AppSidebarProps {
  projects: Project[]
  tasks: Task[]
  selectedProjectId: string | null
  onSelectProject: (id: string | null) => void
  onAddProject: () => void
  onProjectSettings: (project: Project) => void
  onProjectDelete: (project: Project) => void
  onSettings: () => void
  onOnboarding: () => void
  onTutorial: () => void
  onChangelog: () => void
  onTaskClick?: (taskId: string) => void
  zenMode?: boolean
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

const footerActionClassName =
  'rounded-lg text-muted-foreground hover:text-foreground hover:bg-sidebar-accent/80 focus-visible:ring-2 focus-visible:ring-sidebar-ring'

export function AppSidebar({
  projects,
  tasks,
  selectedProjectId,
  onSelectProject,
  onAddProject,
  onProjectSettings,
  onProjectDelete,
  onSettings,
  onOnboarding,
  onTutorial,
  onChangelog,
  onTaskClick,
  zenMode,
}: AppSidebarProps) {
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const { theme, setPreference } = useTheme()
  const isDarkTheme = theme === 'dark'
  const nextThemeLabel = isDarkTheme ? 'Switch to light theme' : 'Switch to dark theme'

  return (
    <Sidebar
      collapsible="none"
      className={cn(
        zenMode ? '!w-0 min-h-svh overflow-hidden' : 'w-16 min-h-svh',
        'bg-sidebar'
      )}
    >
      {/* Draggable region for window movement - clears traffic lights */}
      <div className="h-11 bg-surface-1 window-drag-region" />
      <SidebarContent className="py-4 pt-0">
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu className="flex flex-col items-center gap-2">
              {/* All projects button */}
              <SidebarMenuItem>
                <button
                  onClick={() => onSelectProject(null)}
                  className={cn(
                    'w-10 h-10 rounded-lg flex items-center justify-center border border-transparent',
                    'text-xs font-semibold transition-colors focus-visible:outline-none',
                    'focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar',
                    selectedProjectId === null
                      ? 'bg-card text-foreground border-sidebar-border shadow-sm'
                      : 'bg-sidebar-accent/75 text-sidebar-foreground hover:bg-sidebar-accent'
                  )}
                  title="All projects"
                >
                  All
                </button>
              </SidebarMenuItem>

              {/* Project blobs */}
              {projects.map((project) => (
                <SidebarMenuItem key={project.id}>
                  <ProjectItem
                    project={project}
                    selected={selectedProjectId === project.id}
                    onClick={() => onSelectProject(project.id)}
                    onSettings={() => onProjectSettings(project)}
                    onDelete={() => onProjectDelete(project)}
                  />
                </SidebarMenuItem>
              ))}

              {/* Add project button */}
              <SidebarMenuItem>
                <button
                  onClick={onAddProject}
                  className={cn(
                    'w-10 h-10 rounded-lg flex items-center justify-center',
                    'text-lg border-2 border-dashed transition-colors focus-visible:outline-none',
                    'focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar',
                    'text-muted-foreground border-sidebar-border hover:border-sidebar-primary hover:text-sidebar-primary hover:bg-sidebar-accent/70'
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
      <SidebarFooter className="py-4 border-t border-sidebar-border/80">
        <SidebarMenu>
          <SidebarMenuItem className="flex flex-col items-center gap-2">
            <TerminalStatusPopover tasks={tasks} onTaskClick={onTaskClick} />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-lg"
                  onClick={onTutorial}
                  className={footerActionClassName}
                >
                  <IoCompassSharp className="size-6" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">Take a Tour</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-lg"
                  onClick={onChangelog}
                  className={footerActionClassName}
                >
                  <Megaphone className="size-5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">What's New</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-lg"
                  onClick={onOnboarding}
                  className={footerActionClassName}
                >
                  <FaRegHandshake className="size-5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">Onboarding</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-lg"
                  onClick={() => setShortcutsOpen(true)}
                  className={footerActionClassName}
                >
                  <Keyboard className="size-5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">Keyboard Shortcuts</TooltipContent>
            </Tooltip>
            <Dialog open={shortcutsOpen} onOpenChange={setShortcutsOpen}>
              <DialogContent className="max-h-[80vh] flex flex-col border-border/80">
                <DialogHeader>
                  <DialogTitle>Keyboard Shortcuts</DialogTitle>
                  <DialogDescription className="sr-only">List of keyboard shortcuts</DialogDescription>
                </DialogHeader>
                <div className="space-y-1 overflow-y-auto scrollbar-thin">
                  {shortcutGroups.map((group, i) => (
                    <Collapsible.Root key={group.heading} defaultOpen={i === 0}>
                      <Collapsible.Trigger className="flex w-full items-center justify-between px-3 py-2 rounded-lg border border-sidebar-border/70 bg-sidebar-accent/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring transition-colors group/trigger">
                        <p className="text-[11px] uppercase tracking-wider font-semibold text-muted-foreground group-hover/trigger:text-foreground">{group.heading}</p>
                        <ChevronDown className="size-3.5 text-muted-foreground transition-transform duration-200 group-hover/trigger:text-foreground group-data-[state=open]/trigger:rotate-180" />
                      </Collapsible.Trigger>
                      <Collapsible.Content className="data-[state=closed]:hidden">
                        <div className="rounded-lg border border-border/80 divide-y mb-3 bg-card/70">
                          {group.items.map((s) => (
                            <div key={s.label} className="flex items-center justify-between px-3 py-2">
                              <span className="text-sm">{s.label}</span>
                              <span className="text-base text-foreground bg-sidebar-accent border border-sidebar-border/70 px-2.5 py-0.5 rounded-md font-[system-ui] shadow-xs">{s.keys}</span>
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
                <Button
                  variant="ghost"
                  size="icon-lg"
                  onClick={() => {
                    void setPreference(isDarkTheme ? 'light' : 'dark').catch((error) => {
                      toast(error instanceof Error ? error.message : 'Failed to update theme')
                    })
                  }}
                  aria-label={nextThemeLabel}
                  title={nextThemeLabel}
                  className={footerActionClassName}
                >
                  {isDarkTheme ? <Sun className="size-5" /> : <Moon className="size-5" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">{nextThemeLabel}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-lg"
                  onClick={onSettings}
                  className={footerActionClassName}
                >
                  <Settings className="size-5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">Settings</TooltipContent>
            </Tooltip>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  )
}
