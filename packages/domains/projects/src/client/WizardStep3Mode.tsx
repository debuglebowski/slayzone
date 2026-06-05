import { Label, cn } from '@slayzone/ui'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@slayzone/ui'
import type { WizardState } from './useProjectIntegrationSetupWizard'

type WizardStep3ModeProps = Pick<
  WizardState,
  'provider' | 'syncModeOptions' | 'syncMode' | 'setSyncMode' | 'conflictPolicy' | 'setConflictPolicy'
>

export function WizardStep3Mode({
  provider,
  syncModeOptions,
  syncMode,
  setSyncMode,
  conflictPolicy,
  setConflictPolicy
}: WizardStep3ModeProps): React.JSX.Element {
  return (
    <div className="space-y-2">
      {syncModeOptions.map((option) => (
        <button
          key={option.value}
          type="button"
          disabled={option.disabled}
          onClick={() => setSyncMode(option.value)}
          className={cn(
            'w-full rounded-md border px-3 py-2 text-left transition-colors',
            option.disabled
              ? 'cursor-not-allowed opacity-50'
              : syncMode === option.value
                ? 'border-primary bg-primary/5'
                : 'border-border hover:border-muted-foreground/50'
          )}
        >
          <p className="text-sm font-medium">{option.label}</p>
          <p className="text-xs text-muted-foreground">{option.description}</p>
          {option.disabled ? (
            <p className="mt-1 text-[11px] text-muted-foreground">Coming soon</p>
          ) : null}
        </button>
      ))}

      {provider === 'linear' && syncMode === 'two_way' ? (
        <div className="rounded-md border bg-muted/30 p-3">
          <Label htmlFor="wizard-conflict-policy" className="mb-1 block">
            Conflict policy
          </Label>
          <Select
            value={conflictPolicy}
            onValueChange={(value) => setConflictPolicy(value as typeof conflictPolicy)}
          >
            <SelectTrigger id="wizard-conflict-policy" className="w-full max-w-md">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="external">External wins</SelectItem>
              <SelectItem value="local">SlayZone wins</SelectItem>
              <SelectItem value="latest">Latest update wins</SelectItem>
              <SelectItem value="manual">Ask me on conflict</SelectItem>
            </SelectContent>
          </Select>
        </div>
      ) : null}
    </div>
  )
}
