import { CheckCircle2, Circle } from 'lucide-react'
import { Button, Card, CardContent, CardHeader, CardTitle, cn } from '@slayzone/ui'
import type { ProjectIntegrationSetupWizardProps } from './ProjectIntegrationSetupWizard.types'
import { STEPS } from './ProjectIntegrationSetupWizard.constants'
import { useProjectIntegrationSetupWizard } from './useProjectIntegrationSetupWizard'
import { WizardStep1Connection } from './WizardStep1Connection'
import { WizardStep2Source } from './WizardStep2Source'
import { WizardStep3Mode } from './WizardStep3Mode'
import { WizardStep4Statuses } from './WizardStep4Statuses'
import { WizardStep5Review } from './WizardStep5Review'
import { WizardStep6Preview } from './WizardStep6Preview'

export type { ProjectIntegrationProvider } from './ProjectIntegrationSetupWizard.types'

export function ProjectIntegrationSetupWizard(
  props: ProjectIntegrationSetupWizardProps
): React.JSX.Element {
  const { provider, onCancel } = props
  const wizard = useProjectIntegrationSetupWizard(props)
  const { step, setStep, canGoNext, message } = wizard

  return (
    <Card className="gap-4 py-4">
      <CardHeader className="space-y-4 px-4">
        <div className="space-y-1">
          <CardTitle className="text-base">
            {provider === 'github' ? 'GitHub Project Setup Wizard' : 'Linear Setup Wizard'}
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Configure sync for this project in six quick steps.
          </p>
        </div>
        <div className="grid grid-cols-6 gap-2">
          {STEPS.map((label, index) => {
            const current = index + 1
            const done = current < step
            const active = current === step
            return (
              <button
                key={label}
                type="button"
                onClick={() => setStep(current)}
                className={cn(
                  'flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-left transition-colors',
                  active
                    ? 'border-primary bg-primary/5'
                    : 'border-border hover:border-muted-foreground/50'
                )}
              >
                {done ? (
                  <CheckCircle2 className="size-3 text-primary" />
                ) : (
                  <Circle className="size-3 text-muted-foreground" />
                )}
                <span className="line-clamp-1 text-[11px] text-muted-foreground">{label}</span>
              </button>
            )
          })}
        </div>
      </CardHeader>

      <CardContent className="space-y-4 px-4">
        {step === 1 ? <WizardStep1Connection {...wizard} /> : null}
        {step === 2 ? <WizardStep2Source {...wizard} /> : null}
        {step === 3 ? <WizardStep3Mode {...wizard} /> : null}
        {step === 4 ? <WizardStep4Statuses {...wizard} /> : null}
        {step === 5 ? <WizardStep5Review {...wizard} /> : null}
        {step === 6 ? <WizardStep6Preview {...wizard} /> : null}

        {message ? <p className="text-xs text-muted-foreground">{message}</p> : null}

        <div className="flex items-center justify-between border-t pt-3">
          <div className="text-xs text-muted-foreground">
            Step {step} of {STEPS.length}
          </div>
          <div className="flex items-center gap-2">
            {step > 1 ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setStep((current) => Math.max(1, current - 1))}
              >
                Back
              </Button>
            ) : (
              <Button variant="outline" size="sm" onClick={onCancel}>
                Cancel
              </Button>
            )}
            {step < STEPS.length ? (
              <Button
                size="sm"
                onClick={() => setStep((current) => Math.min(STEPS.length, current + 1))}
                disabled={!canGoNext}
              >
                Next
              </Button>
            ) : null}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
