import { useEffect } from 'react'

// Warm latency-sensitive lazy chunks on idle so the FIRST keystroke that opens
// them doesn't pay the chunk-fetch cost (Suspense fallback is null → blank gap).
// Focused on keystroke-triggered surfaces; the dynamic-import specifier must match
// the one in lazy.ts so both share one chunk in the module cache.
const PRELOADS: Array<() => Promise<unknown>> = [
  // Cmd+K command palette (+ its cmdk/fzf deps). See lazy.ts `SearchDialog`.
  () => import('@slayzone/search'),
  // Dialogs/pages kept off the startup graph by their packages' lean barrels
  // (settings, onboarding, ai-config). Before that split they loaded at boot, so
  // warming them here keeps their first open (Cmd+, settings, an auto-opened
  // onboarding/changelog dialog, the AI-config page) exactly as instant.
  () => import('@slayzone/settings/client/UserSettingsDialog'),
  () => import('@slayzone/settings/client/CliInstallDialog'),
  () => import('@slayzone/onboarding/client/OnboardingDialog'),
  () => import('@slayzone/onboarding/client/ChangelogDialog'),
  () => import('@slayzone/onboarding/client/TutorialAnimationModal'),
  () => import('@slayzone/ai-config/client')
]

export function useIdlePreload(): void {
  useEffect(() => {
    const ric: typeof requestIdleCallback =
      typeof requestIdleCallback === 'function'
        ? requestIdleCallback
        : (cb) =>
            window.setTimeout(
              () => cb({ didTimeout: false, timeRemaining: () => 0 } as IdleDeadline),
              200
            )
    const cic: typeof cancelIdleCallback =
      typeof cancelIdleCallback === 'function'
        ? cancelIdleCallback
        : (id) => window.clearTimeout(id)

    const handle = ric(() => {
      for (const load of PRELOADS)
        load().catch(() => {
          // Warming is an optimization: a failed prefetch just means the real
          // lazy import pays the fetch cost (and reports its own error).
        })
    })
    return () => cic(handle)
  }, [])
}
