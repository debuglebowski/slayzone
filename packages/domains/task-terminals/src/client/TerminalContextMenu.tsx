import { useState, useCallback } from 'react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
  useShortcutDisplay,
  useAppearance,
  appearanceDefaults,
} from '@slayzone/ui'
import { ConfirmDisplayModeDialog } from './ConfirmDisplayModeDialog'
import {
  Copy, ClipboardPaste, TextSelect, Eraser, Search,
  Columns2, Plus, X, PenLine,
  ZoomIn, ZoomOut, RotateCw, ArrowDownToLine,
  Hash, Power, MessageSquare
} from 'lucide-react'
import type { TerminalHandle } from '@slayzone/terminal/client/Terminal'
import type { TabDisplayMode } from '../shared/types'
import { CHAT_SUPPORTED_MODES } from '../shared/chat-modes'

interface TerminalContextMenuProps {
  children: React.ReactNode
  terminalRef: React.RefObject<TerminalHandle | null>
  sessionId: string
  mode: string
  conversationId?: string | null
  onSplit: () => void
  onNewGroup: () => void
  onClose: (() => void) | null
  onRename: (() => void) | null
  onResetSession: (() => void) | null
  onSetDisplayMode?: (target: TabDisplayMode) => void
}

const FONT_SIZE_MIN = 8
const FONT_SIZE_MAX = 32

export function TerminalContextMenu({
  children,
  terminalRef,
  sessionId,
  mode,
  conversationId,
  onSplit,
  onNewGroup,
  onClose,
  onRename,
  onResetSession,
  onSetDisplayMode
}: TerminalContextMenuProps) {
  const [hasSelection, setHasSelection] = useState(false)
  const [pendingChatEnable, setPendingChatEnable] = useState(false)
  const { terminalFontSize } = useAppearance()
  const chatSupported = CHAT_SUPPORTED_MODES.includes(mode)

  const searchShortcut = useShortcutDisplay('terminal-search')
  const clearShortcut = useShortcutDisplay('terminal-clear')
  const splitShortcut = useShortcutDisplay('terminal-split')
  const newGroupShortcut = useShortcutDisplay('terminal-new-group')

  const isAiMode = mode !== 'terminal'

  const handleOpenChange = useCallback((open: boolean) => {
    if (open) {
      setHasSelection(terminalRef.current?.hasSelection() ?? false)
    } else {
      terminalRef.current?.focus()
    }
  }, [terminalRef])

  const handleCopy = useCallback(() => {
    const sel = terminalRef.current?.getSelection()
    if (sel) void navigator.clipboard.writeText(sel)
  }, [terminalRef])

  const handlePaste = useCallback(() => {
    void navigator.clipboard.readText().then(text => {
      if (text) window.api.pty.write(sessionId, text)
    })
  }, [sessionId])

  const handleSelectAll = useCallback(() => {
    terminalRef.current?.selectAll()
  }, [terminalRef])

  const handleClearBuffer = useCallback(() => {
    void terminalRef.current?.clearBuffer()
  }, [terminalRef])

  const handleSearch = useCallback(() => {
    terminalRef.current?.openSearch()
  }, [terminalRef])

  const handleScrollToBottom = useCallback(() => {
    terminalRef.current?.scrollToBottom()
  }, [terminalRef])

  const handleCopyConversationId = useCallback(() => {
    if (conversationId) void navigator.clipboard.writeText(conversationId)
  }, [conversationId])

  const updateFontSize = useCallback((size: number) => {
    const clamped = Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, size))
    void window.api.settings.set('terminal_font_size', String(clamped))
    window.dispatchEvent(new CustomEvent('sz:settings-changed'))
  }, [])

  return (
    <ContextMenu onOpenChange={handleOpenChange}>
      <ContextMenuTrigger asChild>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent className="w-64">
        {/* Clipboard */}
        <ContextMenuItem disabled={!hasSelection} onSelect={handleCopy}>
          <Copy className="size-4" />
          Copy
          <ContextMenuShortcut>⌘C</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onSelect={handlePaste}>
          <ClipboardPaste className="size-4" />
          Paste
          <ContextMenuShortcut>⌘V</ContextMenuShortcut>
        </ContextMenuItem>

        <ContextMenuSeparator />

        {/* Buffer */}
        <ContextMenuItem onSelect={handleSelectAll}>
          <TextSelect className="size-4" />
          Select All
        </ContextMenuItem>
        <ContextMenuItem onSelect={handleClearBuffer}>
          <Eraser className="size-4" />
          Clear Buffer
          {clearShortcut && <ContextMenuShortcut>{clearShortcut}</ContextMenuShortcut>}
        </ContextMenuItem>
        <ContextMenuItem onSelect={handleSearch}>
          <Search className="size-4" />
          Search
          {searchShortcut && <ContextMenuShortcut>{searchShortcut}</ContextMenuShortcut>}
        </ContextMenuItem>

        <ContextMenuSeparator />

        {/* Pane management */}
        <ContextMenuItem onSelect={onSplit}>
          <Columns2 className="size-4" />
          Split Pane
          {splitShortcut && <ContextMenuShortcut>{splitShortcut}</ContextMenuShortcut>}
        </ContextMenuItem>
        <ContextMenuItem onSelect={onNewGroup}>
          <Plus className="size-4" />
          New Group
          {newGroupShortcut && <ContextMenuShortcut>{newGroupShortcut}</ContextMenuShortcut>}
        </ContextMenuItem>
        {onClose && (
          <ContextMenuItem onSelect={onClose}>
            <X className="size-4" />
            Close Pane
          </ContextMenuItem>
        )}
        {onRename && (
          <ContextMenuItem onSelect={onRename}>
            <PenLine className="size-4" />
            Rename Tab...
          </ContextMenuItem>
        )}

        <ContextMenuSeparator />

        {/* Display */}
        <ContextMenuItem disabled={terminalFontSize >= FONT_SIZE_MAX} onSelect={() => updateFontSize(terminalFontSize + 1)}>
          <ZoomIn className="size-4" />
          Zoom In
        </ContextMenuItem>
        <ContextMenuItem disabled={terminalFontSize <= FONT_SIZE_MIN} onSelect={() => updateFontSize(terminalFontSize - 1)}>
          <ZoomOut className="size-4" />
          Zoom Out
        </ContextMenuItem>
        <ContextMenuItem disabled={terminalFontSize === appearanceDefaults.terminalFontSize} onSelect={() => updateFontSize(appearanceDefaults.terminalFontSize)}>
          <RotateCw className="size-4" />
          Reset Zoom
        </ContextMenuItem>
        <ContextMenuItem onSelect={handleScrollToBottom}>
          <ArrowDownToLine className="size-4" />
          Scroll to Bottom
        </ContextMenuItem>

        {/* AI-specific */}
        {isAiMode && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem disabled={!conversationId} onSelect={handleCopyConversationId}>
              <Hash className="size-4" />
              Copy Conversation ID
            </ContextMenuItem>
            {onResetSession && (
              <ContextMenuItem variant="destructive" onSelect={onResetSession}>
                <Power className="size-4" />
                Reset Session
              </ContextMenuItem>
            )}
            {chatSupported && onSetDisplayMode && (
              <ContextMenuItem onSelect={() => setPendingChatEnable(true)}>
                <MessageSquare className="size-4" />
                Enable chat (beta)
              </ContextMenuItem>
            )}
          </>
        )}
      </ContextMenuContent>

      <ConfirmDisplayModeDialog
        open={pendingChatEnable}
        target="chat"
        onConfirm={() => {
          onSetDisplayMode?.('chat')
          setPendingChatEnable(false)
        }}
        onCancel={() => setPendingChatEnable(false)}
      />
    </ContextMenu>
  )
}
