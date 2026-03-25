import { useEffect, useState } from 'react'
import { CHANGELOG } from './changelog-data'

const SETTINGS_KEY = 'last_seen_changelog_version'

export function useChangelogAutoOpen(): [boolean, string | null, () => void] {
  const [shouldOpen, setShouldOpen] = useState(false)
  const [lastSeenVersion, setLastSeenVersion] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function check() {
      const [currentVersion, lastSeen] = await Promise.all([
        window.api.app.getVersion(),
        window.api.settings.get(SETTINGS_KEY),
      ])
      if (cancelled) return

      if (lastSeen === null) {
        // First launch or existing user getting this feature — seed silently
        await window.api.settings.set(SETTINGS_KEY, currentVersion)
        return
      }

      if (lastSeen !== currentVersion && CHANGELOG.length > 0) {
        setLastSeenVersion(lastSeen as string)
        setShouldOpen(true)
      }
    }
    check()
    return () => { cancelled = true }
  }, [])

  const dismiss = () => {
    setShouldOpen(false)
    window.api.app.getVersion().then((v) => window.api.settings.set(SETTINGS_KEY, v))
  }

  return [shouldOpen, lastSeenVersion, dismiss]
}
