import { useMemo, useSyncExternalStore } from 'react'
import { z } from 'zod'
import { MAX_DEVICE_VIEWPORT_SIZE, PREVIEW_DEVICES } from '@slayzone/platform/preview-devices'
import type { ArtifactDeviceSelection } from './ArtifactDevicePicker'

const storagePrefix = 'slayzone:artifact-device-preview:'
const changeEvent = 'slayzone:artifact-device-preview-change'
const legacyFrameKey = 'slayzone:artifact-device-frame'
const unsaved = new Map<string, string | null>()

const dimension = z.int().min(1).max(MAX_DEVICE_VIEWPORT_SIZE)
const selectionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('preset'),
    deviceId: z.string(),
    screen: z.int().nonnegative(),
    rotated: z.boolean(),
    showBoth: z.boolean().optional()
  }),
  z.object({
    kind: z.literal('custom'),
    width: dimension,
    height: dimension,
    angle: z.literal([0, 90])
  })
])
function readStorage(key: string): string | null {
  if (unsaved.has(key)) return unsaved.get(key) ?? null
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function restoreSelection(raw: string | null): ArtifactDeviceSelection {
  if (!raw) return null
  let stored: z.infer<typeof selectionSchema> | undefined
  try {
    stored = selectionSchema.safeParse(JSON.parse(raw)).data
  } catch {
    return null
  }
  if (!stored) return null
  if (stored.kind === 'custom') {
    const { width, height, angle } = stored
    return {
      kind: 'custom',
      viewport: { width, height, angle, mobile: false, deviceScaleFactor: 1 }
    }
  }
  const { deviceId, screen, rotated, showBoth } = stored
  const device = PREVIEW_DEVICES.find(({ id }) => id === deviceId)
  if (!device) return null
  return { kind: 'preset', device, screen: device.screens[screen] ? screen : 0, rotated, showBoth }
}

function subscribe(onChange: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === legacyFrameKey || event.key.startsWith(storagePrefix)) {
      if (event.key === null) unsaved.clear()
      else unsaved.delete(event.key)
      onChange()
    }
  }
  window.addEventListener('storage', onStorage)
  window.addEventListener(changeEvent, onChange)
  return () => {
    window.removeEventListener('storage', onStorage)
    window.removeEventListener(changeEvent, onChange)
  }
}

function writeStorage(key: string, raw: string | null) {
  try {
    if (raw === null) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, raw)
    unsaved.delete(key)
  } catch {
    unsaved.set(key, raw)
  }
  window.dispatchEvent(new Event(changeEvent))
}

export function useDevicePreviewPreferences(artifactId: string | undefined) {
  const key = artifactId ? storagePrefix + artifactId : null
  const frameKey = key ? key + ':frame' : null
  const raw = useSyncExternalStore(
    subscribe,
    () => (key ? readStorage(key) : null),
    () => null
  )
  const showDeviceFrame = useSyncExternalStore(
    subscribe,
    () => ((frameKey && readStorage(frameKey)) ?? readStorage(legacyFrameKey)) !== '0',
    () => true
  )
  const selection = useMemo(() => restoreSelection(raw), [raw])

  function setSelection(next: ArtifactDeviceSelection) {
    if (!key) return
    if (next?.kind === 'preset') {
      const { kind, device, screen, rotated, showBoth } = next
      writeStorage(key, JSON.stringify({ kind, deviceId: device.id, screen, rotated, showBoth }))
    } else if (next?.kind === 'custom') {
      const { width, height, angle } = next.viewport
      writeStorage(key, JSON.stringify({ kind: 'custom', width, height, angle }))
    } else {
      writeStorage(key, null)
    }
  }

  function setShowDeviceFrame(show: boolean) {
    if (frameKey) writeStorage(frameKey, show ? '1' : '0')
  }

  return {
    selection,
    setSelection,
    showDeviceFrame,
    setShowDeviceFrame
  }
}
