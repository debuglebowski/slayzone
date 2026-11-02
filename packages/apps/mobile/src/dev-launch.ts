import { useRouter } from 'expo-router'
import { useEffect } from 'react'
import { tabPathOfLink } from './deep-links'

/**
 * DEV-ONLY: a dev bundle started with `EXPO_PUBLIC_SLZ_DEV_LINK=<app link> [<link>…]`
 * opens those links once, one after the other, right after sign-in — the simulator can't be tapped from a script, and
 * `simctl openurl` asks "Open in SlayZone?" first on a fresh device. Inlined at bundle
 * time by babel-preset-expo; never set in a release build (and `__DEV__` is false there).
 */
const DEV_LINK = __DEV__ ? (process.env.EXPO_PUBLIC_SLZ_DEV_LINK ?? '') : ''

export function useDevLaunchLink(): void {
  const router = useRouter()
  useEffect(() => {
    const timers = DEV_LINK.split(/\s+/)
      .filter(Boolean)
      .map((link, i) =>
        setTimeout(() => router.navigate(tabPathOfLink(link) as never), 1500 + i * 1500)
      )
    return () => timers.forEach(clearTimeout)
  }, [router])
}
