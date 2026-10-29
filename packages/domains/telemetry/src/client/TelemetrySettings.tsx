import { Label } from '@slayzone/ui'
import { Switch } from '@slayzone/ui'
import type { TelemetryTier } from '../shared/types'
import { track } from './telemetry'

interface TelemetrySettingsProps {
  tier: TelemetryTier
  onTierChange: (tier: TelemetryTier) => void
  /** A connected hub turned telemetry off (or could not be asked): say so, change nothing. */
  lockedByHub?: boolean
}

export function TelemetrySettings({
  tier,
  onTierChange,
  lockedByHub = false
}: TelemetrySettingsProps) {
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
          Telemetry is off: a hub this app is connected to has turned it off, or could not be asked.
          Nothing is sent to PostHog, and the leaderboard and feedback are unavailable.
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
