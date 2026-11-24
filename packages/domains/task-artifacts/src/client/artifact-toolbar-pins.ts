import { useSyncExternalStore } from 'react'
import type { RenderMode } from '@slayzone/task-contracts'

const actionIds = [
  'view',
  'device',
  'zoom',
  'theme',
  'display',
  'format',
  'download',
  'versions'
] as const
export type ArtifactToolbarActionId = (typeof actionIds)[number]

const builtInPins: Partial<Record<RenderMode, readonly ArtifactToolbarActionId[]>> = {
  'html-preview': ['view', 'device'],
  markdown: ['view']
}
const prefix = 'slayzone:artifact-toolbar:'
const changeEvent = 'slayzone:artifact-toolbar-change'
const unsaved = new Map<string, string | null>()

function read(key: string): string | null {
  if (unsaved.has(key)) return unsaved.get(key) ?? null
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function restorePins(raw: string | null): ArtifactToolbarActionId[] | null {
  if (raw === null) return null
  try {
    const saved: unknown = JSON.parse(raw)
    if (!Array.isArray(saved)) return null
    return Array.from(
      new Set(saved.filter((id): id is ArtifactToolbarActionId => actionIds.includes(id)))
    )
  } catch {
    return null
  }
}

function write(key: string, pins: readonly ArtifactToolbarActionId[] | null) {
  const raw = pins && JSON.stringify(pins)
  try {
    if (raw === null) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, raw)
    unsaved.delete(key)
  } catch {
    unsaved.set(key, raw)
  }
  window.dispatchEvent(new Event(changeEvent))
}

function subscribe(onChange: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === null) unsaved.clear()
    else if (event.key.startsWith(prefix)) unsaved.delete(event.key)
    else return
    onChange()
  }
  window.addEventListener('storage', onStorage)
  window.addEventListener(changeEvent, onChange)
  return () => {
    window.removeEventListener('storage', onStorage)
    window.removeEventListener(changeEvent, onChange)
  }
}

export function useArtifactToolbarPins(artifactId: string, mode: RenderMode) {
  const defaultKey = `${prefix}default:${mode}`
  const artifactKey = `${prefix}artifact:${artifactId}:${mode}`
  const storedDefault = useSyncExternalStore(
    subscribe,
    () => read(defaultKey),
    () => null
  )
  const storedOverride = useSyncExternalStore(
    subscribe,
    () => read(artifactKey),
    () => null
  )
  const override = restorePins(storedOverride)
  const pins = override ?? restorePins(storedDefault) ?? builtInPins[mode] ?? []

  function getCurrentPins() {
    return (
      restorePins(read(artifactKey)) ?? restorePins(read(defaultKey)) ?? builtInPins[mode] ?? []
    )
  }

  return {
    pins,
    hasOverride: override !== null,
    togglePin(id: ArtifactToolbarActionId) {
      const current = getCurrentPins()
      write(
        artifactKey,
        current.includes(id) ? current.filter((pin) => pin !== id) : [...current, id]
      )
    },
    saveDefault: () => write(defaultKey, getCurrentPins()),
    reset: () => write(artifactKey, null)
  }
}
