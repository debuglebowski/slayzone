import { startTransition, useEffect, useState } from 'react'

/**
 * `false` in the component's first commit, `true` from a later render — for children
 * that call into their native view from a mount effect, i.e. Expo DOM components:
 * expo's web view wrapper (`expo/build/dom/webview-wrapper.js`) sends its props with
 * `injectJavaScript` from a `useEffect` on mount.
 *
 * Why: when the commit that mounts such a child is a sync-lane render (a store update
 * via `useSyncExternalStore`, a discrete event), React flushes its passive effects in
 * the same JS task — before React Native applies the Fabric mount at the end of that
 * task. The native call then finds no view with that tag and rejects, unhandled
 * ("Unable to find the 'DomWebView' view with tag …", a red LogBox toast in dev).
 * Mounting the child in a transition render instead defers its passive effects to a
 * later task, after the native view exists.
 */
export function useNativeMounted(): boolean {
  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    startTransition(() => setMounted(true))
  }, [])
  return mounted
}
