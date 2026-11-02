import type { AppearanceSettings } from '@slayzone/ui'

/** Conversation width; the composer keeps its own fixed maximum width. */
export function chatColumnClass(width: AppearanceSettings['chatWidth']): string {
  return width === 'wide' ? 'mx-auto w-full' : 'mx-auto w-full max-w-[60rem]'
}

/** Side gutter of the chat panel. */
export const CHAT_PANEL_GUTTER_CLASS = 'px-14'

/**
 * Timeline scroller bleeds through the panel gutter so its scrollbar sits at
 * the panel's right edge; the same padding back keeps content (and answer
 * hover insets) where they were. Must mirror CHAT_PANEL_GUTTER_CLASS.
 */
export const CHAT_SCROLLER_BLEED_CLASS = '-mx-14 px-14'
