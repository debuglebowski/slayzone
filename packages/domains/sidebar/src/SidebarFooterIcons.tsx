import { useState } from 'react'
import { Settings, Keyboard, Megaphone, Trophy, BarChart3 } from 'lucide-react'
import { TerminalStatusPopover } from '@slayzone/terminal'
import {
  IconButton,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  cn
} from '@slayzone/ui'
import { useDialogStore } from '@slayzone/settings'
import type { ReactNode } from 'react'
import type { Task } from '@slayzone/task/shared'
import type { OnboardingChecklistState, KeyRecorderComponent } from './types'
import { GettingStartedPopover } from './GettingStartedPopover'
import { ShortcutsDialog } from './ShortcutsDialog'

interface SidebarFooterIconsProps {
  layout: 'vertical' | 'horizontal'
  tasks: Task[]
  onTaskClick?: (taskId: string) => void
  onSettings: () => void
  onUsageAnalytics: () => void
  onLeaderboard: () => void
  onboardingChecklist: OnboardingChecklistState
  /** Convex backend configured — gates the leaderboard + feedback entry points. */
  convexConfigured?: boolean
  /** App-supplied feedback entry (rendered when convex is configured). */
  feedbackSlot?: ReactNode
  /** App-supplied renderless KeyRecorder (threaded to the shortcuts dialog). */
  keyRecorder: KeyRecorderComponent
  trailing?: React.ReactNode
  actions?: React.ReactNode
}

export function SidebarFooterIcons({
  layout,
  tasks,
  onTaskClick,
  onSettings,
  onUsageAnalytics,
  onLeaderboard,
  onboardingChecklist,
  convexConfigured = false,
  feedbackSlot = null,
  keyRecorder,
  trailing,
  actions
}: SidebarFooterIconsProps) {
  const [shortcutsOpen, setShortcutsOpen] = useState(false)

  const tooltipSide: 'top' | 'right' = layout === 'horizontal' ? 'top' : 'right'

  const containerClass = cn(
    layout === 'vertical'
      ? 'flex flex-col items-center gap-2'
      : 'grid [grid-template-columns:repeat(auto-fill,2.5rem)] gap-1 py-1 px-2 justify-start'
  )

  return (
    <div className={containerClass}>
      {actions}
      <TerminalStatusPopover tasks={tasks} onTaskClick={onTaskClick} side={tooltipSide} />

      <GettingStartedPopover
        layout={layout}
        tooltipSide={tooltipSide}
        onboardingChecklist={onboardingChecklist}
      />
      {convexConfigured && (
        <Tooltip>
          <TooltipTrigger asChild>
            <IconButton
              aria-label="Leaderboard"
              variant="ghost"
              size="icon-lg"
              onClick={onLeaderboard}
              className="rounded-lg text-muted-foreground"
            >
              <Trophy className="size-5" />
            </IconButton>
          </TooltipTrigger>
          <TooltipContent side={tooltipSide}>Leaderboard</TooltipContent>
        </Tooltip>
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <IconButton
            aria-label="Usage Analytics"
            variant="ghost"
            size="icon-lg"
            onClick={onUsageAnalytics}
            className="rounded-lg text-muted-foreground"
          >
            <BarChart3 className="size-5" />
          </IconButton>
        </TooltipTrigger>
        <TooltipContent side={tooltipSide}>Usage Analytics</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <IconButton
            aria-label="What's New"
            variant="ghost"
            size="icon-lg"
            onClick={() => useDialogStore.getState().openChangelog()}
            className="rounded-lg text-muted-foreground"
          >
            <Megaphone className="size-5" />
          </IconButton>
        </TooltipTrigger>
        <TooltipContent side={tooltipSide}>What's New</TooltipContent>
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
        <TooltipContent side={tooltipSide}>Keyboard Shortcuts</TooltipContent>
      </Tooltip>
      {convexConfigured && feedbackSlot}
      <ShortcutsDialog
        open={shortcutsOpen}
        onOpenChange={setShortcutsOpen}
        keyRecorder={keyRecorder}
      />
      {trailing}
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
        <TooltipContent side={tooltipSide}>Settings</TooltipContent>
      </Tooltip>
    </div>
  )
}
