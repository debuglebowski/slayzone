import { useSyncExternalStore } from 'react'

const key = 'slayzone:artifact-device-frame'
let fallback = true

function readPreference(): boolean {
  try {
    return window.localStorage.getItem(key) !== '0'
  } catch {
    return fallback
  }
}

function subscribe(onChange: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === key || event.key === null) onChange()
  }
  window.addEventListener('storage', onStorage)
  window.addEventListener(key, onChange)
  return () => {
    window.removeEventListener('storage', onStorage)
    window.removeEventListener(key, onChange)
  }
}

export function setShowDeviceFrame(show: boolean) {
  fallback = show
  try {
    window.localStorage.setItem(key, show ? '1' : '0')
  } catch {
    // The current window still uses the preference if storage is unavailable.
  }
  window.dispatchEvent(new Event(key))
}

export function useShowDeviceFrame() {
  return useSyncExternalStore(subscribe, readPreference, () => true)
}
