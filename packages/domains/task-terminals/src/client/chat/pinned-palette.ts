import { ArrowDown, ArrowUp, Pin } from 'lucide-react'
import type { PaletteCommand } from '@slayzone/ui'
import type { ChatPinnedMessage } from '@slayzone/terminal-contracts'

/**
 * Pinned messages in the app's Cmd+K palette (the chat page's `extra`):
 * "Go to pinned message…" with every pin, newest first, and previous / next pin.
 */
export function pinnedMessagePaletteCommands({
  pins,
  go,
  jump
}: {
  /** The conversation's pins, oldest first (as listed). */
  pins: readonly ChatPinnedMessage[]
  go: (pin: ChatPinnedMessage) => void
  jump: (dir: -1 | 1) => void
}): PaletteCommand[] {
  if (pins.length === 0) return []
  return [
    {
      id: 'chat-pinned-goto',
      label: 'Go to pinned message…',
      keywords: 'pin pinned bookmark saved jump message',
      icon: Pin,
      page: {
        kind: 'list',
        title: 'Go to pinned message',
        searchLimit: 8,
        items: [...pins].reverse().map((pin) => ({
          id: `chat-pinned-${pin.key}`,
          label: `${pin.target === 'answer' ? 'Answer' : 'You'}: ${pin.excerpt || '(empty message)'}`,
          run: () => go(pin)
        }))
      }
    },
    {
      id: 'chat-pinned-prev',
      label: 'Previous pinned message',
      keywords: 'pin bookmark jump up',
      icon: ArrowUp,
      run: () => jump(-1)
    },
    {
      id: 'chat-pinned-next',
      label: 'Next pinned message',
      keywords: 'pin bookmark jump down',
      icon: ArrowDown,
      run: () => jump(1)
    }
  ]
}
