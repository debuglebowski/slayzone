import type { AppearanceSettings } from '@slayzone/ui'

/** Conversation width; the composer keeps its own fixed maximum width. */
export function chatColumnClass(width: AppearanceSettings['chatWidth']): string {
  return width === 'wide' ? 'mx-auto w-full' : 'mx-auto w-full max-w-[60rem]'
}
