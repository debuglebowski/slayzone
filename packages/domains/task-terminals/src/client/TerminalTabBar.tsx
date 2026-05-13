import { useState, useRef, useEffect, useCallback, forwardRef, useImperativeHandle, Fragment } from 'react'
import { Plus, X, Columns2, Terminal as TerminalIcon, MessageSquare, TerminalSquare } from 'lucide-react'
import ClaudeColor from '@lobehub/icons/es/Claude/components/Color'
import CodexColor from '@lobehub/icons/es/Codex/components/Color'
import GeminiColor from '@lobehub/icons/es/Gemini/components/Color'
import CopilotColor from '@lobehub/icons/es/Copilot/components/Color'
import CursorMono from '@lobehub/icons/es/Cursor/components/Mono'
import OpenCodeMono from '@lobehub/icons/es/OpenCode/components/Mono'
import { cn, useShortcutDisplay, withShortcut, Tooltip, TooltipTrigger, TooltipContent, ContextMenu, ContextMenuTrigger, ContextMenuContent } from '@slayzone/ui'
import type { TerminalTab, TerminalGroup, TabDisplayMode } from '../shared/types'
import type { TerminalMode } from '@slayzone/terminal/shared'
import { isChatSupported } from '../shared/chat-modes'

type IconComponent = React.ComponentType<{ className?: string }>

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
  /** Replaces the main tab's static label with caller-rendered content (provider
   *  dropdown trigger + flags popover trigger). Click events inside this slot
   *  are stopped from bubbling so they don't toggle group selection. */
  mainTabAccessories?: React.ReactNode
  /** Right-click context menu items for the main tab group. ContextMenuItem
   *  nodes rendered inside a Radix ContextMenuContent. */
  mainTabContextMenu?: React.ReactNode
  onMainDisplayModeToggle?: (current: TabDisplayMode) => void
}

export const MODE_ICONS: Partial<Record<TerminalMode, IconComponent>> = {
  'claude-code': ClaudeColor as IconComponent,
  'codex': CodexColor as IconComponent,
  'cursor-agent': CursorMono as IconComponent,
  'gemini': GeminiColor as IconComponent,
  'opencode': OpenCodeMono as IconComponent,
  'copilot': CopilotColor as IconComponent,
  'ccs': ClaudeColor as IconComponent,
  'terminal': TerminalIcon
}

import { getTabLabel, numberDuplicateLabels } from './get-tab-label'

export interface TerminalTabBarHandle {
  startRename: (tabId: string) => void
}

const DRAG_TYPE = 'application/x-slayzone-pane'

export const TerminalTabBar = forwardRef<TerminalTabBarHandle, TerminalTabBarProps>(function TerminalTabBar({
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
  rightContent,
  mainTabAccessories,
  mainTabContextMenu,
  onMainDisplayModeToggle
}: TerminalTabBarProps, ref: React.Ref<TerminalTabBarHandle>) {
  const terminalSplitShortcut = useShortcutDisplay('terminal-split')
  const [editingTabId, setEditingTabId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [dragOverGroupId, setDragOverGroupId] = useState<string | null>(null)
  const [dragOverNewGroup, setDragOverNewGroup] = useState(false)
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useImperativeHandle(ref, () => ({
    startRename: (tabId: string) => {
      const tab = groups.flatMap(g => g.tabs).find(t => t.id === tabId)
      if (!tab || tab.isMain) return
      setEditingTabId(tabId)
      setEditValue(tab.label || '')
    }
  }))

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
          const mainTab = group.isMain ? group.tabs.find(t => t.isMain) : undefined
          const showDisplayModeToggle =
            !!mainTab && isChatSupported(mainTab.mode) && !!onMainDisplayModeToggle
          const displayMode: TabDisplayMode = mainTab?.displayMode ?? 'xterm'
          const DisplayModeIcon = displayMode === 'chat' ? TerminalSquare : MessageSquare

          return (
            <Fragment key={group.id}>
            {showDisplayModeToggle && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    data-testid="main-tab-display-mode-toggle"
                    aria-label={displayMode === 'chat' ? 'Switch to terminal view' : 'Switch to chat view (beta)'}
                    onClick={(e) => {
                      e.stopPropagation()
                      onMainDisplayModeToggle?.(displayMode)
                    }}
                    className="flex items-center justify-center h-7 w-7 rounded-md text-muted-foreground hover:text-foreground transition-colors shrink-0"
                  >
                    <DisplayModeIcon className="size-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="flex items-center gap-1.5">
                  <span>{displayMode === 'chat' ? 'Switch to terminal' : 'Switch to chat'}</span>
                  {displayMode !== 'chat' && (
                    <span className="text-[9px] uppercase tracking-wide leading-none px-1 py-0.5 rounded-full bg-amber-400/20 text-amber-300 dark:bg-amber-500/20 dark:text-amber-700">
                      beta
                    </span>
                  )}
                </TooltipContent>
              </Tooltip>
            )}
            {(() => {
              const tabBody = (
                <div
                  data-testid={`terminal-tab-${group.id}`}
                  data-tab-id={group.id}
                  data-tab-main={group.isMain ? 'true' : 'false'}
                  data-tab-active={isActive ? 'true' : 'false'}
                  className={cn(
                    'group flex items-center h-7 rounded-md cursor-pointer transition-all select-none shrink-0',
                    'bg-surface-2 dark:bg-surface-2/50 hover:bg-accent/80 dark:hover:bg-accent/50',
                    isActive
                      ? 'bg-tab-active border border-border'
                      : 'text-muted-foreground dark:text-muted-foreground',
                    isDragOver && 'bg-tab-active shadow-[inset_0_-2px_0_0_var(--border)]'
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
                          <div className="w-px h-3.5 bg-accent dark:bg-accent shrink-0" />
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
                          ) : tab.isMain && mainTabAccessories ? (
                            mainTabAccessories
                          ) : (
                            <span className="truncate text-sm">{displayLabels.get(tab.id)}</span>
                          )}
                          {!tab.isMain && (
                            <button
                              data-testid={`terminal-pane-close-${tab.id}`}
                              className="h-4 w-4 rounded hover:bg-accent/50 dark:hover:bg-accent/50 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
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
              return group.isMain && mainTabContextMenu ? (
                <ContextMenu>
                  <ContextMenuTrigger asChild>{tabBody}</ContextMenuTrigger>
                  <ContextMenuContent>{mainTabContextMenu}</ContextMenuContent>
                </ContextMenu>
              ) : tabBody
            })()}
            </Fragment>
          )
        })}
        <button
          data-testid="terminal-tab-split"
          className="flex items-center justify-center h-7 w-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/50 dark:text-muted-foreground dark:hover:text-foreground dark:hover:bg-surface-2/50 shrink-0"
          onClick={() => onGroupSplit(activeGroupId)}
          title={withShortcut('Split terminal', terminalSplitShortcut)}
        >
          <Columns2 className="size-4" />
        </button>
        {/* Drop zone for creating a new standalone group */}
        <div
          className={cn(
            'flex items-center justify-center h-7 w-7 rounded-md shrink-0 transition-colors',
            dragOverNewGroup
              ? 'bg-tab-active text-foreground shadow-[inset_0_-2px_0_0_var(--border)]'
              : 'text-muted-foreground hover:text-foreground hover:bg-accent/50 dark:text-muted-foreground dark:hover:text-foreground dark:hover:bg-surface-2/50'
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
})
