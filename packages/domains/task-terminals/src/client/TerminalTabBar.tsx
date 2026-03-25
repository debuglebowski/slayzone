import { useState, useRef, useEffect, useCallback } from 'react'
import { Plus, X, Columns2, Terminal as TerminalIcon, Bot, Command, MousePointerClick, Sparkles, Code } from 'lucide-react'
import { cn, useShortcutDisplay } from '@slayzone/ui'
import type { TerminalTab, TerminalGroup } from '../shared/types'
import type { TerminalMode } from '@slayzone/terminal/shared'

interface TerminalTabBarProps {
  groups: TerminalGroup[]
  activeGroupId: string
  onGroupSelect: (groupId: string) => void
  onGroupCreate: () => void
  onGroupClose: (groupId: string) => void
  onGroupSplit: (groupId: string) => void
  onPaneClose: (tabId: string) => void
  onPaneMove: (tabId: string, targetGroupId: string | null) => void
  onGroupRename: (tabId: string, label: string | null) => void
  terminalTitles?: Map<string, string>
  rightContent?: React.ReactNode
}

const MODE_ICONS: Partial<Record<TerminalMode, typeof TerminalIcon>> = {
  'claude-code': Bot,
  'codex': Command,
  'cursor-agent': MousePointerClick,
  'gemini': Sparkles,
  'opencode': Code,
  'ccs': Bot,
  'terminal': TerminalIcon
}

import { getTabLabel, numberDuplicateLabels } from './get-tab-label'

const DRAG_TYPE = 'application/x-slayzone-pane'

export function TerminalTabBar({
  groups,
  activeGroupId,
  onGroupSelect,
  onGroupCreate,
  onGroupClose,
  onGroupSplit,
  onPaneClose,
  onPaneMove,
  onGroupRename,
  terminalTitles,
  rightContent
}: TerminalTabBarProps) {
  const terminalSplitShortcut = useShortcutDisplay('terminal-split')
  const [editingTabId, setEditingTabId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [dragOverGroupId, setDragOverGroupId] = useState<string | null>(null)
  const [dragOverNewGroup, setDragOverNewGroup] = useState(false)
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editingTabId && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editingTabId])

  const handleDoubleClick = (tab: TerminalTab) => {
    if (tab.isMain) return
    setEditingTabId(tab.id)
    setEditValue(tab.label || '')
  }

  const handleRenameSubmit = (tabId: string) => {
    onGroupRename(tabId, editValue.trim() || null)
    setEditingTabId(null)
  }

  // Drag handlers for panes
  const handleDragStart = useCallback((e: React.DragEvent, tab: TerminalTab) => {
    e.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ tabId: tab.id, sourceGroupId: tab.groupId }))
    e.dataTransfer.effectAllowed = 'move'
    setDraggingTabId(tab.id)
  }, [])

  const handleDragEnd = useCallback(() => {
    setDraggingTabId(null)
    setDragOverGroupId(null)
    setDragOverNewGroup(false)
  }, [])

  const handleGroupDragOver = useCallback((e: React.DragEvent, groupId: string) => {
    if (!e.dataTransfer.types.includes(DRAG_TYPE)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDragOverGroupId(groupId)
    setDragOverNewGroup(false)
  }, [])

  const handleGroupDragLeave = useCallback(() => {
    setDragOverGroupId(null)
  }, [])

  const handleGroupDrop = useCallback((e: React.DragEvent, targetGroupId: string) => {
    e.preventDefault()
    const raw = e.dataTransfer.getData(DRAG_TYPE)
    if (!raw) return
    const { tabId, sourceGroupId } = JSON.parse(raw) as { tabId: string; sourceGroupId: string }
    setDragOverGroupId(null)
    setDraggingTabId(null)
    if (sourceGroupId === targetGroupId) return // already in this group
    onPaneMove(tabId, targetGroupId)
  }, [onPaneMove])

  // Drop zone for creating a new group
  const handleNewGroupDragOver = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(DRAG_TYPE)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDragOverNewGroup(true)
    setDragOverGroupId(null)
  }, [])

  const handleNewGroupDragLeave = useCallback(() => {
    setDragOverNewGroup(false)
  }, [])

  const handleNewGroupDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    const raw = e.dataTransfer.getData(DRAG_TYPE)
    if (!raw) return
    const { tabId } = JSON.parse(raw) as { tabId: string }
    setDragOverNewGroup(false)
    setDraggingTabId(null)
    onPaneMove(tabId, null) // null = new standalone group
  }, [onPaneMove])

  // Pre-compute numbered labels for duplicate disambiguation
  const rawLabels = new Map<string, string>()
  for (const group of groups) {
    for (const tab of group.tabs) {
      rawLabels.set(tab.id, getTabLabel(tab, terminalTitles?.get(tab.id)))
    }
  }
  const displayLabels = numberDuplicateLabels(rawLabels)

  return (
    <div
      data-testid="terminal-tabbar"
      className="flex items-center h-10 px-2 bg-surface-1 border-b border-border"
    >
      <div className="flex items-center gap-1 min-w-0 overflow-x-auto scrollbar-hide">
        {groups.map(group => {
          const isActive = group.id === activeGroupId
          const isSinglePane = group.tabs.length === 1
          const isDragOver = dragOverGroupId === group.id

          return (
            <div
              key={group.id}
              data-testid={`terminal-tab-${group.id}`}
              data-tab-id={group.id}
              data-tab-main={group.isMain ? 'true' : 'false'}
              data-tab-active={isActive ? 'true' : 'false'}
              className={cn(
                'group flex items-center h-7 rounded-md cursor-pointer transition-all select-none shrink-0',
                'bg-neutral-100 dark:bg-neutral-800/50 hover:bg-neutral-200/80 dark:hover:bg-neutral-700/50',
                isActive
                  ? 'bg-neutral-200 dark:bg-neutral-700 border border-neutral-300 dark:border-neutral-600'
                  : 'text-neutral-500 dark:text-neutral-400',
                isDragOver && 'bg-neutral-200 dark:bg-neutral-600 shadow-[inset_0_-2px_0_0_theme(colors.neutral.400)] dark:shadow-[inset_0_-2px_0_0_theme(colors.neutral.400)]'
              )}
              onClick={() => onGroupSelect(group.id)}
              onDragOver={(e) => handleGroupDragOver(e, group.id)}
              onDragLeave={handleGroupDragLeave}
              onDrop={(e) => handleGroupDrop(e, group.id)}
            >
              {group.tabs.map((tab, i) => {
                const Icon = MODE_ICONS[tab.mode] ?? TerminalIcon
                const isEditing = editingTabId === tab.id
                const isDragging = draggingTabId === tab.id

                return (
                  <div key={tab.id} className={cn('flex items-center', isDragging && 'opacity-50')}>
                    {i > 0 && (
                      <div className="w-px h-3.5 bg-neutral-300 dark:bg-neutral-600 shrink-0" />
                    )}
                    <div
                      draggable
                      className="flex items-center gap-1.5 px-2.5 cursor-grab active:cursor-grabbing"
                      onDragStart={(e) => handleDragStart(e, tab)}
                      onDragEnd={handleDragEnd}
                      onDoubleClick={(e) => {
                        e.stopPropagation()
                        handleDoubleClick(tab)
                      }}
                    >
                      <Icon className="size-3.5 shrink-0" />
                      {isEditing ? (
                        <input
                          ref={inputRef}
                          value={editValue}
                          onChange={e => setEditValue(e.target.value)}
                          onBlur={() => handleRenameSubmit(tab.id)}
                          onKeyDown={e => {
                            if (e.key === 'Enter') handleRenameSubmit(tab.id)
                            if (e.key === 'Escape') setEditingTabId(null)
                          }}
                          className="w-20 bg-transparent border-none outline-none text-xs"
                          onClick={e => e.stopPropagation()}
                        />
                      ) : (
                        <span className="truncate text-sm">{displayLabels.get(tab.id)}</span>
                      )}
                      {tab.isMain && (
                        <span className="text-[10px] text-orange-300/80 bg-orange-400/10 px-1.5 rounded-full">main</span>
                      )}
                      {!tab.isMain && (
                        <button
                          data-testid={`terminal-pane-close-${tab.id}`}
                          className="h-4 w-4 rounded hover:bg-neutral-300/50 dark:hover:bg-neutral-600/50 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                          onClick={e => {
                            e.stopPropagation()
                            if (isSinglePane) {
                              onGroupClose(group.id)
                            } else {
                              onPaneClose(tab.id)
                            }
                          }}
                        >
                          <X className="size-3" />
                        </button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )
        })}
        <button
          data-testid="terminal-tab-split"
          className="flex items-center justify-center h-7 w-7 rounded-md text-neutral-500 hover:text-neutral-700 hover:bg-neutral-200/50 dark:text-neutral-400 dark:hover:text-neutral-200 dark:hover:bg-neutral-800/50 shrink-0"
          onClick={() => onGroupSplit(activeGroupId)}
          title={`Split terminal (${terminalSplitShortcut})`}
        >
          <Columns2 className="size-4" />
        </button>
        {/* Drop zone for creating a new standalone group */}
        <div
          className={cn(
            'flex items-center justify-center h-7 w-7 rounded-md shrink-0 transition-colors',
            dragOverNewGroup
              ? 'bg-neutral-200 dark:bg-neutral-600 text-neutral-700 dark:text-neutral-200 shadow-[inset_0_-2px_0_0_theme(colors.neutral.400)] dark:shadow-[inset_0_-2px_0_0_theme(colors.neutral.400)]'
              : 'text-neutral-500 hover:text-neutral-700 hover:bg-neutral-200/50 dark:text-neutral-400 dark:hover:text-neutral-200 dark:hover:bg-neutral-800/50'
          )}
          onDragOver={handleNewGroupDragOver}
          onDragLeave={handleNewGroupDragLeave}
          onDrop={handleNewGroupDrop}
        >
          <button
            data-testid="terminal-tab-add"
            className="h-full w-full flex items-center justify-center"
            onClick={onGroupCreate}
          >
            <Plus className="size-4" />
          </button>
        </div>
      </div>
      {rightContent && (
        <div className="ml-auto flex items-center shrink-0 pl-2">
          {rightContent}
        </div>
      )}
    </div>
  )
}
