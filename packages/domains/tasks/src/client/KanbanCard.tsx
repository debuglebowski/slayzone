import { motion } from 'framer-motion'
import { useEffect, useRef, useState } from 'react'
import type { Task } from '@slayzone/task/shared'
import type { Tag } from '@slayzone/tags/shared'
import { TagSelector } from '@slayzone/tags/client'
import type { Project } from '@slayzone/projects/shared'
import type { ColumnConfig } from '@slayzone/projects/shared'
import { isTerminalStatus } from '@slayzone/projects/shared'
import type { TerminalState } from '@slayzone/terminal/shared'
import { Card, CardContent, Tooltip, TooltipContent, TooltipTrigger, Popover, PopoverContent, PopoverTrigger, cn, getTerminalStateStyle, PriorityIcon } from '@slayzone/ui'
import { useAppearance } from '@slayzone/settings/client'
import { todayISO } from './kanban'
import { priorityOptions } from '@slayzone/task/shared'
import { AlarmClockOff, GitMerge, Link2 } from 'lucide-react'
import { usePty } from '@slayzone/terminal'
import type { CardProperties } from './FilterState'

function formatTimeLeft(until: string): string {
  const ms = new Date(until).getTime() - Date.now()
  if (ms <= 0) return '0m'
  const mins = Math.floor(ms / 60_000)
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h`
  const days = Math.floor(hrs / 24)
  return `${days}d`
}

interface KanbanCardProps {
  task: Task
  columns?: ColumnConfig[] | null
  isDragging?: boolean
  isFocused?: boolean
  onClick?: (e: React.MouseEvent) => void
  project?: Project
  showProject?: boolean
  isBlocked?: boolean
  subTaskCount?: { done: number; total: number }
  cardProperties?: CardProperties
  taskTagIds?: string[]
  tags?: Tag[]
  onUpdateTask?: (taskId: string, updates: Partial<Task>) => void
  onTaskTagsChange?: (taskId: string, tagIds: string[]) => void
}


export function KanbanCard({
  task,
  columns,
  isDragging,
  isFocused,
  onClick,
  project,
  showProject,
  isBlocked,
  subTaskCount,
  cardProperties: cp,
  taskTagIds,
  tags,
  onUpdateTask,
  onTaskTagsChange
}: KanbanCardProps): React.JSX.Element {
  const resolvedTags = (cp?.tags ?? true) && tags && taskTagIds
    ? tags.filter((t) => taskTagIds.includes(t.id))
    : []
  const [prioOpen, setPrioOpen] = useState(false)
  const { reduceMotion } = useAppearance()
  const today = todayISO()
  const isOverdue = task.due_date && task.due_date < today && !isTerminalStatus(task.status, columns)
  const prevStatusRef = useRef(task.status)
  const [justCompleted, setJustCompleted] = useState(false)

  // Terminal state tracking - use main terminal sessionId format (taskId:taskId)
  const { getState, subscribeState } = usePty()
  const mainSessionId = `${task.id}:${task.id}`
  const [terminalState, setTerminalState] = useState<TerminalState>(() => getState(mainSessionId))

  useEffect(() => {
    setTerminalState(getState(mainSessionId))
    return subscribeState(mainSessionId, (newState) => setTerminalState(newState))
  }, [mainSessionId, getState, subscribeState])

  useEffect(() => {
    if (!isTerminalStatus(prevStatusRef.current, columns) && isTerminalStatus(task.status, columns)) {
      setJustCompleted(true)
      setTimeout(() => setJustCompleted(false), 1000)
    }
    prevStatusRef.current = task.status
  }, [task.status, columns])

  return (
    <motion.div
      whileTap={!isDragging && !reduceMotion ? { scale: 0.98 } : undefined}
      animate={
        justCompleted && !reduceMotion
          ? {
              scale: [1, 1.1, 1],
              rotate: [0, 5, -5, 0],
              transition: {
                duration: 0.1,
                ease: 'easeOut'
              }
            }
          : {}
      }
    >
      <Card
        className={cn(
          'cursor-grab transition-colors duration-[400ms] hover:duration-[100ms] select-none py-0 gap-0 hover:bg-muted/50',
          isDragging && 'opacity-50 shadow-lg',
          isFocused && 'ring-2 ring-primary bg-muted/50',
          isOverdue && 'border-destructive',
          task.linear_url && 'border-l-2 border-l-indigo-500'
        )}
        data-task-id={task.id}
        onClick={(e) => onClick?.(e)}
      >
      <CardContent className={cn("px-2.5 pt-5", resolvedTags.length > 0 || (subTaskCount && subTaskCount.total > 0) || ((cp?.dueDate ?? true) && task.due_date) ? "pb-3" : "pb-5")}>
        <div className="flex items-start gap-3">
          {/* Project color dot - shown in All view */}
          {showProject && project ? (
            <div
              className="h-1.5 w-1.5 rounded-full shrink-0 mt-1"
              style={{ backgroundColor: project.color }}
              title={project.name}
            />
          ) : showProject ? (
            <div className="h-1.5 w-1.5 rounded-full bg-muted-foreground/30 shrink-0 mt-1" />
          ) : null}
          <div className="flex-1 min-w-0">
            {/* Title row */}
            <div className="flex items-start gap-1.5">
              {(cp?.priority ?? true) && (
                <Popover open={prioOpen} onOpenChange={setPrioOpen}>
                  <PopoverTrigger asChild>
                    <button type="button" className="shrink-0 leading-tight text-xs inline-flex items-center h-[1em]" onClick={(e) => e.stopPropagation()}>
                      <PriorityIcon priority={task.priority} className="h-4 w-4" />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent className="w-[140px] p-1" align="start" onClick={(e) => e.stopPropagation()}>
                    {priorityOptions.map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        className={cn(
                          'flex items-center gap-2 w-full rounded px-2 py-1 text-xs hover:bg-muted/50',
                          task.priority === opt.value && 'bg-muted'
                        )}
                        onClick={() => { onUpdateTask?.(task.id, { priority: opt.value }); setPrioOpen(false) }}
                      >
                        <PriorityIcon priority={opt.value} className="h-3.5 w-3.5" />
                        {opt.label}
                      </button>
                    ))}
                  </PopoverContent>
                </Popover>
              )}
              <p className="text-xs font-medium line-clamp-3 flex-1 leading-tight whitespace-pre-wrap break-words">{task.title}</p>
              <div className="flex items-start gap-1.5 shrink-0">
              {(cp?.terminal ?? true) && (() => {
                const stateStyle = terminalState !== 'starting' ? getTerminalStateStyle(terminalState) : null
                return stateStyle ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className={cn('h-2 w-2 rounded-full shrink-0 ml-0.5', stateStyle.color)} />
                    </TooltipTrigger>
                    <TooltipContent>{stateStyle.label}</TooltipContent>
                  </Tooltip>
                ) : null
              })()}
              {(cp?.merge ?? true) && task.merge_state && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="shrink-0">
                      <GitMerge className="h-2.5 w-2.5 text-purple-400" />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>Merging</TooltipContent>
                </Tooltip>
              )}
              {(cp?.linear ?? true) && task.linear_url && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="shrink-0 h-2 w-2 rounded-full bg-indigo-500" />
                  </TooltipTrigger>
                  <TooltipContent>Linked to Linear</TooltipContent>
                </Tooltip>
              )}
              {(cp?.blocked ?? true) && isBlocked && (
                <span className="flex items-center text-amber-500 shrink-0" title="Blocked">
                  <Link2 className="h-2.5 w-2.5" />
                </span>
              )}
              {task.snoozed_until && new Date(task.snoozed_until) > new Date() && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="flex items-center gap-0.5 text-orange-500 shrink-0">
                      <AlarmClockOff className="h-2.5 w-2.5" />
                      <span className="text-[9px] font-medium">{formatTimeLeft(task.snoozed_until)}</span>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>Snoozed until {new Date(task.snoozed_until).toLocaleString()}</TooltipContent>
                </Tooltip>
              )}
              </div>
            </div>
            {/* Bottom row: subtasks + tags + due date */}
            {(resolvedTags.length > 0 || (subTaskCount && subTaskCount.total > 0) || ((cp?.dueDate ?? true) && task.due_date)) && (
              <div className="flex items-center gap-3 mt-3">
                {(cp?.subtasks ?? true) && subTaskCount && subTaskCount.total > 0 && (() => {
                  const pct = subTaskCount.done / subTaskCount.total
                  const r = 8
                  const circ = 2 * Math.PI * r
                  const isDone = subTaskCount.done === subTaskCount.total
                  return (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="h-5 shrink-0 flex items-center gap-1">
                          <svg viewBox="0 0 20 20" className="h-5 w-5">
                            <circle cx="10" cy="10" r={r} fill="none" strokeWidth="2"
                              className="stroke-muted-foreground/20" />
                            <circle cx="10" cy="10" r={r} fill="none" strokeWidth="2"
                              strokeDasharray={circ} strokeDashoffset={circ * (1 - pct)}
                              strokeLinecap="round"
                              className={isDone ? 'stroke-green-500' : 'stroke-current'}
                              transform="rotate(-90 10 10)" />
                          </svg>
                          <span className={cn(
                            "text-[9px] shrink-0",
                            isDone ? "text-green-500" : "text-muted-foreground"
                          )}>
                            {subTaskCount.done}/{subTaskCount.total}
                          </span>
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>{subTaskCount.done} of {subTaskCount.total} subtasks done</TooltipContent>
                    </Tooltip>
                  )
                })()}
                {resolvedTags.length > 0 && (
                  <Popover>
                    <PopoverTrigger asChild>
                      <button type="button" className="flex items-center h-5" onClick={(e) => e.stopPropagation()}>
                        {resolvedTags.length === 1 ? (
                          <span
                            className="h-5 rounded-full px-2 text-[10px] leading-none flex items-center truncate max-w-[80px]"
                            style={{ backgroundColor: resolvedTags[0].color, color: resolvedTags[0].text_color }}
                          >
                            {resolvedTags[0].name}
                          </span>
                        ) : (
                          <>
                            <span
                              className="h-5 rounded-full px-2 text-[10px] leading-none flex items-center truncate max-w-[70px] z-10"
                              style={{ backgroundColor: resolvedTags[0].color, color: resolvedTags[0].text_color }}
                            >
                              {resolvedTags[0].name}
                            </span>
                            {resolvedTags.slice(1).map((tag, i) => (
                              <span
                                key={tag.id}
                                className="h-5 w-5 rounded-full border-2 border-background shrink-0"
                                style={{ backgroundColor: tag.color, marginLeft: -10, zIndex: 9 - i }}
                              />
                            ))}
                          </>
                        )}
                      </button>
                    </PopoverTrigger>
                    <PopoverContent className="w-[200px] p-1.5" align="start" onClick={(e) => e.stopPropagation()}>
                      <TagSelector
                        tags={tags ?? []}
                        selectedTagIds={taskTagIds ?? []}
                        projectId={task.project_id}
                        onToggle={(tagId, checked) => {
                          const current = taskTagIds ?? []
                          const next = checked ? [...current, tagId] : current.filter((id) => id !== tagId)
                          onTaskTagsChange?.(task.id, next)
                        }}
                        onTagCreated={(tag) => {
                          window.dispatchEvent(new CustomEvent('slayzone:tag-created', { detail: tag }))
                        }}
                      />
                    </PopoverContent>
                  </Popover>
                )}
                {(cp?.dueDate ?? true) && task.due_date && (
                  <span className={cn(
                    "ml-auto shrink-0 h-5 rounded-full ring-1 px-2 text-[10px] font-medium leading-none flex items-center",
                    isOverdue
                      ? "text-destructive ring-destructive"
                      : "text-muted-foreground ring-border"
                  )}>
                    {task.due_date}
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
    </motion.div>
  )
}
