import { useCallback, useMemo, useState } from 'react'
import { Settings, Keyboard, ChevronDown, Megaphone, Check, CheckCheck, Trophy, BarChart3, MoreHorizontal } from 'lucide-react'
import { FaRegHandshake } from 'react-icons/fa'
import * as Collapsible from '@radix-ui/react-collapsible'
import { isConvexConfigured } from '@/lib/convexAuth'
import { FeedbackDialog } from '../feedback/FeedbackDialog'
import { TerminalStatusPopover } from '@slayzone/terminal'
import {
  IconButton,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  Popover,
  PopoverTrigger,
  PopoverContent,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  cn,
  shortcutDefinitions,
  formatKeysForDisplay,
  useShortcutStore,
  type ShortcutDefinition
} from '@slayzone/ui'
import { useDialogStore } from '@slayzone/settings'
import type { Task } from '@slayzone/task/shared'
import type { OnboardingChecklistState } from '@/hooks/useOnboardingChecklist'
import { KeyRecorder } from '@/components/KeyRecorder'

interface SidebarFooterIconsProps {
  layout: 'vertical' | 'horizontal'
  tasks: Task[]
  onTaskClick?: (taskId: string) => void
  onSettings: () => void
  onUsageAnalytics: () => void
  onLeaderboard: () => void
  onboardingChecklist: OnboardingChecklistState
  trailing?: React.ReactNode
  actions?: React.ReactNode
}

function ShortcutRow({
  def,
  effectiveKeys,
  isRecordingThis,
  onStartRecording,
  onCancelRecording,
  onClear,
  conflictAction,
  shadowAction,
  onConfirmReassign,
  onCancelConflict,
  onDismissShadow,
}: {
  def: ShortcutDefinition
  effectiveKeys: string | null
  isRecordingThis: boolean
  onStartRecording: () => void
  onCancelRecording: () => void
  onClear: () => void
  conflictAction: ShortcutDefinition | null
  shadowAction: ShortcutDefinition | null
  onConfirmReassign: () => void
  onCancelConflict: () => void
  onDismissShadow: () => void
}) {
  const customizable = def.customizable !== false
  const isBound = effectiveKeys !== null

  return (
    <div>
      <div className="flex items-center justify-between px-3 py-2 gap-2">
        <span className="text-sm">{def.label}</span>
        {isRecordingThis ? (
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground bg-primary/10 border border-primary/30 px-2.5 py-0.5 rounded-md font-[system-ui] animate-pulse">
              Press keys...
            </span>
            <button
              type="button"
              onClick={onCancelRecording}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              ✕
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-1.5">
            {effectiveKeys !== null ? (
              <span
                className={cn(
                  'text-base text-muted-foreground bg-muted border px-2.5 py-0.5 rounded-md font-[system-ui] shadow-[0_1px_0_0_rgba(0,0,0,0.05)]',
                  customizable && 'cursor-pointer'
                )}
                onClick={customizable ? onStartRecording : undefined}
              >
                {formatKeysForDisplay(effectiveKeys)}
              </span>
            ) : (
              <span
                className={cn(
                  'text-xs italic text-muted-foreground/60 px-2.5 py-0.5 rounded-md border border-dashed',
                  customizable && 'cursor-pointer hover:text-muted-foreground'
                )}
                onClick={customizable ? onStartRecording : undefined}
              >
                Unbound
              </span>
            )}
            {isBound && (
              customizable ? (
                <button
                  type="button"
                  onClick={onClear}
                  aria-label={`Clear shortcut for ${def.label}`}
                  title="Clear shortcut"
                  className="text-xs text-muted-foreground/60 hover:text-foreground px-1"
                >
                  ✕
                </button>
              ) : (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      aria-disabled="true"
                      className="text-xs text-muted-foreground/30 px-1 cursor-not-allowed"
                    >
                      ✕
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="left">This shortcut cannot be removed</TooltipContent>
                </Tooltip>
              )
            )}
          </div>
        )}
      </div>
      {conflictAction && (
        <div className="flex items-center justify-between px-3 pb-2 gap-2">
          <span className="text-xs text-amber-400">
            Already bound to <strong>{conflictAction.label}</strong> — it will be swapped
          </span>
          <div className="flex gap-1.5 shrink-0">
            <button
              type="button"
              onClick={onCancelConflict}
              className="text-xs px-2 py-0.5 rounded border border-border bg-muted text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onConfirmReassign}
              className="text-xs px-2 py-0.5 rounded bg-primary text-primary-foreground hover:bg-primary/90"
            >
              Reassign
            </button>
          </div>
        </div>
      )}
      {shadowAction && !conflictAction && (
        <div className="flex items-center justify-between px-3 pb-2 gap-2">
          <span className="text-xs text-muted-foreground">
            Also used by <strong>{shadowAction.label}</strong> ({shadowAction.group})
          </span>
          <button
            type="button"
            onClick={onDismissShadow}
            className="text-xs px-2 py-0.5 rounded border border-border bg-muted text-muted-foreground hover:text-foreground shrink-0"
          >
            OK
          </button>
        </div>
      )}
    </div>
  )
}

export function SidebarFooterIcons({
  layout,
  tasks,
  onTaskClick,
  onSettings,
  onUsageAnalytics,
  onLeaderboard,
  onboardingChecklist,
  trailing,
  actions,
}: SidebarFooterIconsProps) {
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [openShortcutGroup, setOpenShortcutGroup] = useState<string | null>(() => shortcutDefinitions[0]?.group ?? null)
  const [checklistOpen, setChecklistOpen] = useState(false)
  const [recordingId, setRecordingId] = useState<string | null>(null)
  const [pendingKeys, setPendingKeys] = useState<string | null>(null)
  const [pendingConflict, setPendingConflict] = useState<ShortcutDefinition | null>(null)
  const [shadowWarning, setShadowWarning] = useState<{ defId: string; shadow: ShortcutDefinition } | null>(null)

  const overrides = useShortcutStore((s) => s.overrides)
  const { getKeys, findConflict, findShadow, setOverride, batchSetOverrides, resetAll, setRecording } = useShortcutStore()

  const effectiveKeysMap = useMemo(() => {
    const map: Record<string, string | null> = {}
    for (const def of shortcutDefinitions) {
      map[def.id] = def.id in overrides ? overrides[def.id] : def.defaultKeys
    }
    return map
  }, [overrides])

  const shortcutGroups = useMemo(() => {
    const groups: { heading: string; items: ShortcutDefinition[] }[] = []
    for (const def of shortcutDefinitions) {
      let group = groups.find((g) => g.heading === def.group)
      if (!group) {
        group = { heading: def.group, items: [] }
        groups.push(group)
      }
      group.items.push(def)
    }
    return groups
  }, [])

  const handleCapture = useCallback((keys: string) => {
    if (!recordingId) return
    const def = shortcutDefinitions.find((d) => d.id === recordingId)
    if (!def) return

    const conflict = findConflict(keys, def.scope)
    if (conflict && conflict.id !== recordingId) {
      setPendingKeys(keys)
      setPendingConflict(conflict)
      return
    }

    const shadow = findShadow(keys, def.scope)

    setOverride(recordingId, keys)
    setRecording(false)
    setPendingKeys(null)
    setPendingConflict(null)

    if (shadow && shadow.id !== recordingId) {
      setShadowWarning({ defId: recordingId, shadow })
      setRecordingId(null)
    } else {
      setRecordingId(null)
    }
  }, [recordingId, findConflict, findShadow, setOverride, setRecording])

  const handleCancelRecording = useCallback(() => {
    setRecordingId(null)
    setRecording(false)
    setPendingKeys(null)
    setPendingConflict(null)
    setShadowWarning(null)
  }, [setRecording])

  const handleConfirmReassign = useCallback(async () => {
    if (!recordingId || !pendingKeys || !pendingConflict) return
    const previousKeys = getKeys(recordingId)
    await batchSetOverrides({ [pendingConflict.id]: previousKeys, [recordingId]: pendingKeys })
    setRecordingId(null)
    setRecording(false)
    setPendingKeys(null)
    setPendingConflict(null)
  }, [recordingId, pendingKeys, pendingConflict, getKeys, batchSetOverrides, setRecording])

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

      <Popover open={checklistOpen} onOpenChange={setChecklistOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label="Getting Started"
                className={cn(
                  'relative inline-flex items-center justify-center rounded-lg transition-colors',
                  layout === 'horizontal' ? 'size-10' : 'h-11 w-11',
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
          <TooltipContent side={tooltipSide}>Getting Started</TooltipContent>
        </Tooltip>
        <PopoverContent side={tooltipSide} align="end" sideOffset={12} className="w-[320px] p-3">
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
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <IconButton
                aria-label="More"
                variant="ghost"
                size="icon-lg"
                className="rounded-lg text-muted-foreground"
              >
                <MoreHorizontal className="size-5" />
              </IconButton>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side={tooltipSide}>More</TooltipContent>
        </Tooltip>
        <DropdownMenuContent side="top" align="start" className="min-w-[200px]">
          {isConvexConfigured && (
            <DropdownMenuItem onSelect={onLeaderboard} className="cursor-pointer">
              <Trophy className="size-4" />
              <span>Leaderboard</span>
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={onUsageAnalytics} className="cursor-pointer">
            <BarChart3 className="size-4" />
            <span>Usage Analytics</span>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => useDialogStore.getState().openChangelog()} className="cursor-pointer">
            <Megaphone className="size-4" />
            <span>What's New</span>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setShortcutsOpen(true)} className="cursor-pointer">
            <Keyboard className="size-4" />
            <span>Keyboard Shortcuts</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {isConvexConfigured && <FeedbackDialog />}
      <Dialog open={shortcutsOpen} onOpenChange={(open) => {
        setShortcutsOpen(open)
        if (!open) handleCancelRecording()
      }}>
        <DialogContent className="max-h-[80vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>Keyboard Shortcuts</DialogTitle>
            <DialogDescription className="sr-only">List of keyboard shortcuts</DialogDescription>
          </DialogHeader>
          <KeyRecorder
            active={recordingId !== null && !pendingConflict}
            onCapture={handleCapture}
            onCancel={handleCancelRecording}
          />
          <div className="space-y-1 overflow-y-auto scrollbar-thin">
            {shortcutGroups.map((group) => (
              <Collapsible.Root
                key={group.heading}
                open={openShortcutGroup === group.heading}
                onOpenChange={(open) => setOpenShortcutGroup(open ? group.heading : null)}
              >
                <Collapsible.Trigger className="flex w-full items-center justify-between px-3 py-2 rounded-lg bg-muted hover:bg-accent hover:text-accent-foreground transition-colors group/trigger">
                  <p className="text-[11px] uppercase tracking-wider font-semibold text-muted-foreground">{group.heading}</p>
                  <ChevronDown className="size-3.5 text-muted-foreground transition-transform duration-200 group-data-[state=open]/trigger:rotate-180" />
                </Collapsible.Trigger>
                <Collapsible.Content className="data-[state=closed]:hidden">
                  <div className="rounded-lg border divide-y mb-3">
                    {group.items.map((def) => (
                      <ShortcutRow
                        key={def.id}
                        def={def}
                        effectiveKeys={effectiveKeysMap[def.id]}
                        isRecordingThis={recordingId === def.id}
                        onStartRecording={() => {
                          handleCancelRecording()
                          setRecordingId(def.id)
                          setRecording(true)
                        }}
                        onCancelRecording={handleCancelRecording}
                        onClear={() => setOverride(def.id, '')}
                        conflictAction={recordingId === def.id ? pendingConflict : null}
                        shadowAction={shadowWarning?.defId === def.id ? shadowWarning.shadow : null}
                        onConfirmReassign={handleConfirmReassign}
                        onCancelConflict={handleCancelRecording}
                        onDismissShadow={() => setShadowWarning(null)}
                      />
                    ))}
                  </div>
                </Collapsible.Content>
              </Collapsible.Root>
            ))}
          </div>
          <div className="flex justify-center pt-2 pb-1">
            <button
              type="button"
              onClick={resetAll}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              Reset to Defaults
            </button>
          </div>
        </DialogContent>
      </Dialog>
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
