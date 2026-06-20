import { useEffect, useState } from 'react'
import { useTRPCClient } from '@slayzone/transport/client'
import { CHANGELOG } from './changelog-data'

const SETTINGS_KEY = 'last_seen_changelog_version'

export function useChangelogAutoOpen(): [boolean, string | null, () => void] {
  const trpcClient = useTRPCClient()
  const [shouldOpen, setShouldOpen] = useState(false)
  const [lastSeenVersion, setLastSeenVersion] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function check() {
      const [currentVersion, lastSeen] = await Promise.all([
        trpcClient.app.meta.getVersion.query(),
        trpcClient.settings.get.query({ key: SETTINGS_KEY })
      ])
      if (cancelled) return

      if (lastSeen === null) {
        // First launch or existing user getting this feature — seed silently
        await trpcClient.settings.set.mutate({ key: SETTINGS_KEY, value: currentVersion })
        return
      }

      if (lastSeen !== currentVersion && CHANGELOG.length > 0) {
        setLastSeenVersion(lastSeen as string)
        setShouldOpen(true)
      }
    }
    check()
    return () => {
      cancelled = true
    }
  }, [trpcClient])

  const dismiss = () => {
    setShouldOpen(false)
    trpcClient.app.meta.getVersion
      .query()
      .then((v) => trpcClient.settings.set.mutate({ key: SETTINGS_KEY, value: v }))
  }

  return [shouldOpen, lastSeenVersion, dismiss]
}
