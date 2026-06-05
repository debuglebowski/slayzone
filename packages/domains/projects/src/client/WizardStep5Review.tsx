import type { WizardState } from './useProjectIntegrationSetupWizard'

type WizardStep5ReviewProps = Pick<
  WizardState,
  'provider' | 'mappedStatuses' | 'openStatusLabel' | 'closedStatusLabel'
>

export function WizardStep5Review({
  provider,
  mappedStatuses,
  openStatusLabel,
  closedStatusLabel
}: WizardStep5ReviewProps): React.JSX.Element {
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Mapping defaults are pre-filled for this scaffold. Required fields are enforced.
      </p>
      <div className="rounded-md border p-3">
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Field mapping
        </p>
        <ul className="space-y-1 text-sm">
          <li>Title -&gt; Task title</li>
          <li>Description -&gt; Task description</li>
          <li>Status -&gt; Task status</li>
          <li>Assignee -&gt; Task assignee</li>
          <li>Labels -&gt; Task tags</li>
        </ul>
      </div>
      <div className="rounded-md border p-3">
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Status mapping
        </p>
        {provider === 'linear' ? (
          <div className="space-y-1 text-sm">
            {mappedStatuses.map((column) => (
              <p key={column.id}>Linear state type -&gt; {column.label}</p>
            ))}
          </div>
        ) : (
          <div className="space-y-1 text-sm">
            <p>Open issues -&gt; {openStatusLabel}</p>
            <p>Closed issues -&gt; {closedStatusLabel}</p>
          </div>
        )}
      </div>
    </div>
  )
}
