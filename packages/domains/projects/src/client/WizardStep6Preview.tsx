import { Loader2 } from 'lucide-react'
import { Button } from '@slayzone/ui'
import type { WizardState } from './useProjectIntegrationSetupWizard'

type WizardStep6PreviewProps = Pick<
  WizardState,
  | 'previewLoading'
  | 'previewLoaded'
  | 'previewCount'
  | 'previewImportableCount'
  | 'syncMode'
  | 'saving'
  | 'handleSaveProfile'
>

export function WizardStep6Preview({
  previewLoading,
  previewLoaded,
  previewCount,
  previewImportableCount,
  syncMode,
  saving,
  handleSaveProfile
}: WizardStep6PreviewProps): React.JSX.Element {
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Review projected first sync impact before confirming.
      </p>
      <div className="rounded-md border p-3">
        {previewLoading ? (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3 animate-spin" />
            Building preview...
          </p>
        ) : previewLoaded ? (
          <div className="space-y-1 text-sm">
            <p>{previewCount} issues scanned in preview batch</p>
            <p>{previewImportableCount} issues available to import</p>
            <p>Mode: {syncMode === 'two_way' ? 'Two-way sync' : 'One-way import'}</p>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">Preview not loaded yet.</p>
        )}
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => void handleSaveProfile(false)}
          disabled={saving}
        >
          {saving ? 'Saving...' : 'Save profile without syncing'}
        </Button>
        <Button size="sm" onClick={() => void handleSaveProfile(true)} disabled={saving}>
          {saving ? 'Running...' : 'Run first sync'}
        </Button>
      </div>
    </div>
  )
}
