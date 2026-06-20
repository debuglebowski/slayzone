import { useEffect, useCallback } from 'react'
import { normalizeHotkeyString } from '@slayzone/shortcuts'

const MODIFIER_KEYS = new Set(['Meta', 'Control', 'Shift', 'Alt'])
const isMac = navigator.platform.startsWith('Mac')

/**
 * Normalizes a keyboard event into canonical react-hotkeys-hook format.
 * Modifiers in fixed order: mod+shift+alt+ctrl+{key}, all lowercase.
 */
function normalizeKeyEvent(e: KeyboardEvent): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null // bare modifier press

  const parts: string[] = []
  if (e.metaKey || (!isMac && e.ctrlKey)) parts.push('mod')
  if (e.shiftKey) parts.push('shift')
  if (e.altKey) parts.push('alt')
  if (isMac && e.ctrlKey) parts.push('ctrl')

  parts.push(e.key.toLowerCase())
  return normalizeHotkeyString(parts.join('+'))
}

export interface KeyRecorderProps {
  active: boolean
  onCapture: (keys: string) => void
  onCancel: () => void
}

export function KeyRecorder({ active, onCapture, onCancel }: KeyRecorderProps) {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()

      if (e.key === 'Escape') {
        onCancel()
        return
      }

      const normalized = normalizeKeyEvent(e)
      if (normalized) onCapture(normalized)
    },
    [onCapture, onCancel]
  )

  useEffect(() => {
    if (!active) return
    // Use capture phase to intercept before react-hotkeys-hook
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [active, handleKeyDown])

  return null // renderless — just a keydown listener
}
