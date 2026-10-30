import { ArrowDown, ArrowUp, ListOrdered } from 'lucide-react'
import type { PaletteCommand } from '@slayzone/ui'
import type { RevealTimelineItem } from './timeline-reveal'
import type { TurnEntry } from './turn-outline'

/**
 * The turn outline in the app's Cmd+K palette (the chat page's `extra`):
 * "Go to turn…" with every user turn, and previous / next turn.
 */
export function turnOutlinePaletteCommands({
  turns,
  reveal,
  jump
}: {
  turns: readonly TurnEntry[]
  reveal: RevealTimelineItem
  jump: (dir: -1 | 1) => void
}): PaletteCommand[] {
  if (turns.length === 0) return []
  return [
    {
      id: 'chat-turn-goto',
      label: 'Go to turn…',
      keywords: 'outline jump message prompt',
      icon: ListOrdered,
      page: {
        kind: 'list',
        title: 'Go to turn',
        // A long session has hundreds: root search shows a few, the page all.
        searchLimit: 8,
        items: turns.map((t, i) => ({
          id: `chat-turn-${String(t.key)}`,
          label: `${i + 1}. ${t.title}`,
          run: () => reveal(t.key, { align: 'start' })
        }))
      }
    },
    {
      id: 'chat-turn-prev',
      label: 'Previous turn',
      keywords: 'outline jump up',
      icon: ArrowUp,
      run: () => jump(-1)
    },
    {
      id: 'chat-turn-next',
      label: 'Next turn',
      keywords: 'outline jump down',
      icon: ArrowDown,
      run: () => jump(1)
    }
  ]
}
