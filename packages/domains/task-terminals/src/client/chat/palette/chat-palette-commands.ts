import {
  ArrowRightLeft,
  Brain,
  ClipboardCopy,
  CornerUpLeft,
  Cpu,
  FileDiff,
  FoldVertical,
  GitFork,
  History,
  MessagesSquare,
  Minimize2,
  RotateCcw,
  Search,
  Shield,
  Square
} from 'lucide-react'
import { agentEffortOptions, agentModeLabel, type PaletteCommand } from '@slayzone/ui'
import { chatModesForMode, modelsForMode } from '@slayzone/terminal-contracts'
import type { RewindPickerKind } from '../RewindPicker'

/** What the chat offers the palette right now (absent = not now / not this provider). */
export interface ChatPaletteInput {
  mode: string
  inFlight: boolean
  canRewind: boolean
  canFork: boolean
  /** Esc Esc's message list (`edit`), or the fork one. */
  openRewind: (kind: RewindPickerKind) => void
  /** `/compact` (the CLI runs it). */
  compact?: () => void
  /** The task's Sessions picker. */
  showSessions?: () => void
  model?: { current: string; change: (id: string) => void }
  permissionMode?: { current: string; change: (mode: string) => void; autoAvailable: boolean }
  effort?: { current: string; change: (effort: string) => void }
  /** "Continue in terminal". */
  handoff?: () => void
  filesChanged?: { count: number; open: () => void }
  find: () => void
  collapseAll: () => void
  copyLastResponse: () => void
  copyConversation: () => void
  /** A turn is running: stop it. */
  stop?: () => void
  reset: () => void
  /** Commands other parts of the chat add (e.g. the turn outline). */
  extra?: PaletteCommand[]
}

/** One picker page: the options, the current one checked. */
function pickerPage(
  id: string,
  title: string,
  options: Array<{ id: string; label: string }>,
  current: string,
  change: (id: string) => void
): PaletteCommand['page'] {
  return {
    kind: 'list',
    title,
    items: options.map((o) => ({
      id: `${id}-${o.id}`,
      label: o.label,
      checked: o.id === current,
      run: () => change(o.id)
    }))
  }
}

/**
 * The chat's entry in the app's Cmd+K palette: one featured "Chat…" page with
 * its actions (searchable from the palette's root too). Only what can be done
 * now is listed.
 */
export function chatPaletteCommands(input: ChatPaletteInput): PaletteCommand[] {
  const items: PaletteCommand[] = []
  if (input.stop) {
    items.push({ id: 'chat-stop', label: 'Stop the turn', icon: Square, run: input.stop })
  }
  if (input.canRewind) {
    items.push({
      id: 'chat-rewind',
      label: 'Rewind…',
      keywords: 'esc esc edit resend undo restore message',
      icon: CornerUpLeft,
      takesFocus: true,
      run: () => input.openRewind('edit')
    })
  }
  if (input.canFork) {
    items.push({
      id: 'chat-fork',
      label: 'Fork from a message…',
      keywords: 'branch',
      icon: GitFork,
      takesFocus: true,
      run: () => input.openRewind('fork')
    })
  }
  if (input.compact) {
    items.push({
      id: 'chat-compact',
      label: 'Compact conversation',
      keywords: '/compact summarize context',
      icon: Minimize2,
      run: input.compact
    })
  }
  if (input.filesChanged && input.filesChanged.count > 0) {
    items.push({
      id: 'chat-files',
      label: `Files changed (${input.filesChanged.count})`,
      keywords: 'diff changes',
      icon: FileDiff,
      takesFocus: true,
      run: input.filesChanged.open
    })
  }
  if (input.showSessions) {
    items.push({
      id: 'chat-sessions',
      label: 'Sessions…',
      keywords: 'resume conversations history',
      icon: History,
      run: input.showSessions
    })
  }
  if (input.model) {
    items.push({
      id: 'chat-model',
      label: 'Model…',
      icon: Cpu,
      page: pickerPage(
        'chat-model',
        'Model',
        modelsForMode(input.mode),
        input.model.current,
        input.model.change
      )
    })
  }
  if (input.permissionMode) {
    const { autoAvailable } = input.permissionMode
    const modes = chatModesForMode(input.mode).filter((m) => m !== 'auto' || autoAvailable)
    items.push({
      id: 'chat-mode',
      label: 'Permission mode…',
      keywords: 'plan ask accept bypass',
      icon: Shield,
      page: pickerPage(
        'chat-mode',
        'Permission mode',
        modes.map((m) => ({ id: m, label: agentModeLabel(m) })),
        input.permissionMode.current,
        input.permissionMode.change
      )
    })
  }
  if (input.effort) {
    items.push({
      id: 'chat-effort',
      label: 'Effort…',
      keywords: 'reasoning thinking',
      icon: Brain,
      page: pickerPage(
        'chat-effort',
        'Effort',
        agentEffortOptions(),
        input.effort.current,
        input.effort.change
      )
    })
  }
  if (input.handoff) {
    items.push({
      id: 'chat-handoff',
      label: 'Continue in terminal',
      keywords: 'tui hand off',
      icon: ArrowRightLeft,
      run: input.handoff
    })
  }
  items.push(
    ...(input.extra ?? []),
    { id: 'chat-find', label: 'Find in chat', icon: Search, takesFocus: true, run: input.find },
    {
      id: 'chat-collapse',
      label: 'Collapse all expanded blocks',
      icon: FoldVertical,
      run: input.collapseAll
    },
    {
      id: 'chat-copy-last',
      label: 'Copy last response',
      icon: ClipboardCopy,
      run: input.copyLastResponse
    },
    {
      id: 'chat-copy-all',
      label: 'Copy entire conversation',
      icon: MessagesSquare,
      run: input.copyConversation
    },
    { id: 'chat-reset', label: 'Reset chat', keywords: 'clear', icon: RotateCcw, run: input.reset }
  )
  return [
    {
      id: 'chat',
      label: 'Chat…',
      keywords: 'claude conversation',
      icon: MessagesSquare,
      featured: true,
      page: { kind: 'list', title: 'Chat', items }
    }
  ]
}
