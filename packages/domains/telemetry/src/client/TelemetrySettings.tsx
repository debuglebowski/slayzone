import { Label } from '@slayzone/ui'
import { Switch } from '@slayzone/ui'
import type { TelemetryTier } from '../shared/types'
import type { TelemetryHubRef } from './TelemetryProvider'
import { useTrack } from './useTrack'

interface TelemetrySettingsProps {
  tier: TelemetryTier
  onTierChange: (tier: TelemetryTier) => void
  /** The home hub turned telemetry off (or could not be asked): say so, change nothing. */
  lockedByHub?: boolean
  /** The home hub's label, for the locked note; null = unnamed (no hub registry). */
  homeHubLabel?: string | null
  /** Other hubs whose own tasks and projects are not reported on. */
  withheldHubs?: readonly TelemetryHubRef[]
}

export function TelemetrySettings({
  tier,
  onTierChange,
  lockedByHub = false,
  homeHubLabel = null,
  withheldHubs = []
}: TelemetrySettingsProps) {
  const { track } = useTrack()
  const isOptedIn = tier === 'opted_in'
  const isOff = tier === 'off'

  const change = (newTier: TelemetryTier): void => {
    // Turning it off sends nothing, not even the switch itself.
    if (newTier !== 'off') track('telemetry_tier_changed', { tier: newTier })
    onTierChange(newTier)
  }

  return (
    <div className="space-y-6">
      {lockedByHub && (
        <p
          className="rounded-md border border-border bg-muted p-3 text-sm text-muted-foreground"
          data-testid="telemetry-locked-by-hub"
        >
          Telemetry is off: {homeHubLabel ? <>the hub {homeHubLabel}</> : 'this app’s hub'} has
          turned it off (<code>SLAYZONE_HUB_ENABLE_TELEMETRY=0</code>), or could not be asked.
          Nothing is sent to PostHog, and the leaderboard and feedback are unavailable.
        </p>
      )}

      {!lockedByHub && withheldHubs.length > 0 && (
        <p
          className="rounded-md border border-border bg-muted p-3 text-sm text-muted-foreground"
          data-testid="telemetry-withheld-hubs"
        >
          Nothing about the tasks and projects on {withheldHubs.map((h) => h.label).join(', ')} is
          sent: {withheldHubs.length === 1 ? 'that hub has' : 'those hubs have'} turned telemetry
          off, or could not be asked. Everything else here applies as you choose.
        </p>
      )}

      <div className="space-y-3">
        <Label className="text-base font-semibold">Anonymous Analytics</Label>
        <p className="text-sm text-muted-foreground">
          SlayZone records when the app is opened and sends an activity heartbeat every 10 minutes
          while the app is active and in the foreground. No personal identifiers, no data stored on
          your device, no IP recording.
        </p>
      </div>

      <div className="space-y-3">
        <Label className="text-base font-semibold">Enhanced Analytics</Label>
        <p className="text-sm text-muted-foreground">
          Opt in to help us understand retention patterns over time. A random anonymous ID is
          persisted locally and unhandled exceptions are reported to help us fix crashes. No
          personal information is collected.
        </p>
        <div className="flex items-center gap-3">
          <Switch
            id="telemetry-opt-in"
            checked={isOptedIn}
            disabled={isOff || lockedByHub}
            onCheckedChange={(checked: boolean) => change(checked ? 'opted_in' : 'anonymous')}
          />
          <label htmlFor="telemetry-opt-in" className="text-sm cursor-pointer">
            Help improve SlayZone
          </label>
        </div>
      </div>

      <div className="space-y-3">
        <Label className="text-base font-semibold">Turn Off</Label>
        <p className="text-sm text-muted-foreground">
          Send nothing to PostHog and turn off the features that use SlayZone&apos;s cloud service
          (Convex): the leaderboard and feedback.
        </p>
        <div className="flex items-center gap-3">
          <Switch
            id="telemetry-off"
            checked={isOff}
            disabled={lockedByHub}
            onCheckedChange={(checked: boolean) => change(checked ? 'off' : 'anonymous')}
          />
          <label htmlFor="telemetry-off" className="text-sm cursor-pointer">
            Turn off telemetry
          </label>
        </div>
      </div>
    </div>
  )
}
