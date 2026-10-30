/**
 * The chat's page in the app's Cmd+K palette (chat E, plan 4.6): one featured
 * "Chat…" entry whose items are the chat's actions — what the provider and the
 * moment allow (no Stop when idle, no model switch while a turn runs).
 */
import { describe, expect, test, vi } from 'vitest'
import { flattenPaletteCommands, type PaletteCommand } from '@slayzone/ui'
import { modelsForMode } from '@slayzone/terminal-contracts'
import { chatPaletteCommands, type ChatPaletteInput } from './chat-palette-commands'

function input(over: Partial<ChatPaletteInput> = {}): ChatPaletteInput {
  return {
    mode: 'claude-chat',
    inFlight: false,
    canRewind: true,
    canFork: true,
    openRewind: vi.fn(),
    compact: vi.fn(),
    showSessions: vi.fn(),
    model: { current: 'opus', options: modelsForMode('claude-chat'), change: vi.fn() },
    permissionMode: { current: 'auto-accept', change: vi.fn(), autoAvailable: false },
    effort: { current: 'high', change: vi.fn() },
    handoff: vi.fn(),
    filesChanged: { count: 2, open: vi.fn() },
    find: vi.fn(),
    collapseAll: vi.fn(),
    copyLastResponse: vi.fn(),
    copyConversation: vi.fn(),
    reset: vi.fn(),
    ...over
  }
}

const page = (commands: PaletteCommand[]) => {
  expect(commands).toHaveLength(1)
  const [chat] = commands
  expect(chat).toMatchObject({ id: 'chat', label: 'Chat…', featured: true })
  if (chat.page?.kind !== 'list') throw new Error('no list page')
  return chat.page.items
}
const item = (items: PaletteCommand[], id: string) => {
  const found = items.find((c) => c.id === id)
  if (!found) throw new Error(`no ${id} in ${items.map((c) => c.id).join(', ')}`)
  return found
}

describe('chatPaletteCommands', () => {
  test('idle Claude chat: every action, in order', () => {
    expect(page(chatPaletteCommands(input())).map((c) => c.label)).toEqual([
      'Rewind…',
      'Fork from a message…',
      'Compact conversation',
      'Files changed (2)',
      'Sessions…',
      'Model…',
      'Permission mode…',
      'Effort…',
      'Continue in terminal',
      'Find in chat',
      'Collapse all expanded blocks',
      'Copy last response',
      'Copy entire conversation',
      'Reset chat'
    ])
  })

  test('a turn running: Stop first; what is left out is left out', () => {
    const items = page(
      chatPaletteCommands(
        input({
          inFlight: true,
          stop: vi.fn(),
          model: undefined,
          effort: undefined,
          filesChanged: { count: 0, open: vi.fn() },
          canFork: false,
          compact: undefined
        })
      )
    )
    expect(items[0].label).toBe('Stop the turn')
    const ids = items.map((c) => c.id)
    expect(ids).not.toContain('chat-model')
    expect(ids).not.toContain('chat-effort')
    expect(ids).not.toContain('chat-files')
    expect(ids).not.toContain('chat-fork')
    expect(ids).not.toContain('chat-compact')
  })

  test('the items run the chat actions', () => {
    const i = input()
    const items = page(chatPaletteCommands(i))
    void item(items, 'chat-rewind').run?.()
    expect(i.openRewind).toHaveBeenCalledWith('edit')
    void item(items, 'chat-fork').run?.()
    expect(i.openRewind).toHaveBeenCalledWith('fork')
    void item(items, 'chat-compact').run?.()
    expect(i.compact).toHaveBeenCalled()
    void item(items, 'chat-files').run?.()
    expect(i.filesChanged?.open).toHaveBeenCalled()
  })

  test('model / mode / effort pages: the current one checked, picking changes it', () => {
    const i = input({ permissionMode: { current: 'plan', change: vi.fn(), autoAvailable: true } })
    const items = page(chatPaletteCommands(i))
    const models = item(items, 'chat-model').page
    if (models?.kind !== 'list') throw new Error('no model page')
    expect(models.items.find((m) => m.checked)?.label).toBe('Opus')
    void models.items.find((m) => m.label === 'Sonnet')?.run?.()
    expect(i.model?.change).toHaveBeenCalledWith('sonnet')

    const modes = item(items, 'chat-mode').page
    if (modes?.kind !== 'list') throw new Error('no mode page')
    expect(modes.items.map((m) => m.label)).toContain('Plan mode')
    expect(modes.items.find((m) => m.checked)?.label).toBe('Plan mode')
    expect(modes.items).toHaveLength(5)

    const efforts = item(items, 'chat-effort').page
    if (efforts?.kind !== 'list') throw new Error('no effort page')
    void efforts.items.find((e) => e.label === 'Low')?.run?.()
    expect(i.effort?.change).toHaveBeenCalledWith('low')
  })

  test('auto mode only when the account has it; ids unique across pages', () => {
    const modes = item(page(chatPaletteCommands(input())), 'chat-mode').page
    if (modes?.kind !== 'list') throw new Error('no mode page')
    expect(modes.items.map((m) => m.id)).not.toContain('chat-mode-auto')
    const ids = flattenPaletteCommands(chatPaletteCommands(input())).map((f) => f.command.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test("a later batch's commands (the outline) join the page", () => {
    const extra: PaletteCommand = { id: 'chat-outline', label: 'Turn outline', run: vi.fn() }
    expect(page(chatPaletteCommands(input({ extra: [extra] }))).map((c) => c.id)).toContain(
      'chat-outline'
    )
  })
})
