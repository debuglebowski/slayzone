import type { Page } from '@playwright/test'
import { shortcutDefinitions } from '@slayzone/shortcuts'

function toPlaywrightKey(keys: string, isMac = process.platform === 'darwin'): string {
  return keys
    .split('+')
    .map(part => {
      if (part === 'mod') return isMac ? 'Meta' : 'Control'
      if (part === 'shift') return 'Shift'
      if (part === 'alt') return 'Alt'
      if (part === 'ctrl') return 'Control'
      return part.length === 1 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)
    })
    .join('+')
}

export function shortcutKey(id: string): string {
  const def = shortcutDefinitions.find(d => d.id === id)
  if (!def) throw new Error(`Unknown shortcut id: ${id}`)
  return toPlaywrightKey(def.defaultKeys)
}

export async function pressShortcut(page: Page, id: string): Promise<void> {
  await page.keyboard.press(shortcutKey(id))
}
