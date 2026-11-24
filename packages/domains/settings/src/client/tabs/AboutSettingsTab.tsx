import { useQuery } from '@tanstack/react-query'
import { useTRPC } from '../trpc'
import { Label } from '@slayzone/ui'
import { SettingsTabIntro } from './SettingsTabIntro'

/** This app install: version and where its database lives. */
export function AboutSettingsTab() {
  const trpc = useTRPC()
  const versionQuery = useQuery(trpc.app.meta.getVersion.queryOptions())
  const dbPathQuery = useQuery(trpc.settings.get.queryOptions({ key: 'database_path' }))

  // Empty until the setting has loaded (a loaded query never reverts to undefined).
  const dbPath =
    dbPathQuery.data !== undefined ? (dbPathQuery.data ?? 'Default location (userData)') : ''

  return (
    <div className="space-y-6">
      <SettingsTabIntro
        title="About"
        description="This app install: its version, where its data is stored, and diagnostics."
      />
      <div className="space-y-3">
        <Label className="text-base font-semibold">Version</Label>
        <p className="text-sm text-muted-foreground" data-testid="about-version">
          SlayZone {versionQuery.data ?? ''}
        </p>
      </div>
      <div className="space-y-3">
        <Label className="text-base font-semibold">Database</Label>
        <div className="text-sm text-muted-foreground">
          <p>Location: {dbPath}</p>
          <p className="text-xs mt-1">
            Database path can be changed via command line. Restart required.
          </p>
        </div>
      </div>
    </div>
  )
}
