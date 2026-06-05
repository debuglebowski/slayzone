import { CheckCircle2, Loader2 } from 'lucide-react'
import { Button } from '@slayzone/ui'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@slayzone/ui'
import { resolveColumns } from '@slayzone/projects/shared'
import { WORKFLOW_CATEGORIES, type WorkflowCategory } from '@slayzone/workflow'
import { slugifyStatusName } from '@slayzone/integrations/shared'
import type { WizardState } from './useProjectIntegrationSetupWizard'
import { providerLabel } from './ProjectIntegrationSetupWizard.helpers'

type WizardStep4StatusesProps = Pick<
  WizardState,
  | 'provider'
  | 'project'
  | 'loadingStatuses'
  | 'providerStatuses'
  | 'categoryOverrides'
  | 'setCategoryOverrides'
  | 'taskRemapping'
  | 'setTaskRemapping'
  | 'statusSetupComplete'
  | 'applyingStatuses'
  | 'handleApplyStatuses'
>

export function WizardStep4Statuses({
  provider,
  project,
  loadingStatuses,
  providerStatuses,
  categoryOverrides,
  setCategoryOverrides,
  taskRemapping,
  setTaskRemapping,
  statusSetupComplete,
  applyingStatuses,
  handleApplyStatuses
}: WizardStep4StatusesProps): React.JSX.Element {
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Import statuses from {providerLabel(provider)} to replace this project's statuses.
      </p>
      {loadingStatuses ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3 animate-spin" />
          Loading statuses from {providerLabel(provider)}...
        </p>
      ) : providerStatuses.length > 0 ? (
        <>
          <div className="rounded-md border p-3">
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {providerLabel(provider)} statuses
            </p>
            <div className="space-y-2">
              {providerStatuses.map((status) => (
                <div key={status.id} className="flex items-center justify-between gap-2">
                  <span className="text-sm">{status.name}</span>
                  <Select
                    value={categoryOverrides[status.id] ?? status.type ?? 'unstarted'}
                    onValueChange={(value) =>
                      setCategoryOverrides((prev) => ({
                        ...prev,
                        [status.id]: value as WorkflowCategory
                      }))
                    }
                  >
                    <SelectTrigger className="w-36">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {WORKFLOW_CATEGORIES.map((cat) => (
                        <SelectItem key={cat} value={cat}>
                          {cat}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>
          </div>

          {!statusSetupComplete ? (
            <div className="rounded-md border p-3">
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Remap existing tasks
              </p>
              <p className="mb-2 text-xs text-muted-foreground">
                Choose where existing tasks should go. Unmapped tasks will move to the default
                status.
              </p>
              <div className="space-y-2">
                {resolveColumns(project.columns_config).map((col) => (
                  <div key={col.id} className="flex items-center justify-between gap-2">
                    <span className="text-sm">{col.label}</span>
                    <span className="text-xs text-muted-foreground">-&gt;</span>
                    <Select
                      value={taskRemapping[col.id] ?? ''}
                      onValueChange={(value) =>
                        setTaskRemapping((prev) => ({ ...prev, [col.id]: value }))
                      }
                    >
                      <SelectTrigger className="w-40">
                        <SelectValue placeholder="Auto (default)" />
                      </SelectTrigger>
                      <SelectContent>
                        {providerStatuses.map((ps) => (
                          <SelectItem key={ps.id} value={slugifyStatusName(ps.name)}>
                            {ps.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <div className="flex justify-end">
            {statusSetupComplete ? (
              <p className="flex items-center gap-2 text-xs text-green-600">
                <CheckCircle2 className="size-3" /> Statuses applied
              </p>
            ) : (
              <Button
                size="sm"
                onClick={() => void handleApplyStatuses()}
                disabled={applyingStatuses}
              >
                {applyingStatuses ? 'Applying...' : 'Apply statuses'}
              </Button>
            )}
          </div>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">No statuses found.</p>
      )}
    </div>
  )
}
