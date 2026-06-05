import { CommandShortcut, useShortcutDisplay } from '@slayzone/ui'

export function ActionShortcut({ shortcutId }: { shortcutId?: string }) {
  const display = useShortcutDisplay(shortcutId ?? '')
  if (!shortcutId || !display) return null
  return <CommandShortcut>{display}</CommandShortcut>
}
