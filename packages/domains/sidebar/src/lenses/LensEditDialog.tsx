import { useState } from 'react'
import {
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Input
} from '@slayzone/ui'
import { isLensDirty, uniqueLensName, useTabStore } from '@slayzone/tabs-state'
import { LensEditorSection } from './LensEditorFields'
import { LensIconView } from './lens-icons'
import {
  closeLensEditor,
  setLensEditorTab,
  useLensEditor,
  type LensEditorTab
} from './lens-editor-store'

const TABS: ReadonlyArray<readonly [LensEditorTab, string]> = [
  ['structure', 'Structure'],
  ['show', 'What to show'],
  ['rows', 'How rows look']
]

/**
 * "Edit lens": the active lens's settings in three tabs. Edits apply live to the
 * sidebar (left visible behind a clear overlay); Save writes them into the lens,
 * Save as new… makes a new lens of them, Revert drops them. Closing keeps unsaved
 * edits live — the Lens button's dot shows they are unsaved.
 */
export function LensEditDialog(): React.JSX.Element {
  const { open, tab } = useLensEditor()
  const activeLensId = useTabStore((s) => s.activeLensId)
  // The lens "Save as new…" just made: its name field takes focus to rename it.
  const [renameNew, setRenameNew] = useState<string | null>(null)
  return (
    <Dialog open={open} onOpenChange={(next) => !next && closeLensEditor()}>
      <DialogContent
        data-testid="lens-edit-dialog"
        overlayClassName="bg-transparent dark:bg-transparent backdrop-blur-none"
        showCloseButton
        className="flex max-h-[min(640px,calc(100vh-4rem))] w-[480px] max-w-[calc(100vw-2rem)] flex-col gap-0 p-0"
      >
        {open && (
          <LensEditBody
            key={activeLensId}
            tab={tab}
            focusName={renameNew === activeLensId}
            onSavedAsNew={setRenameNew}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function LensEditBody({
  tab,
  focusName,
  onSavedAsNew
}: {
  tab: LensEditorTab
  focusName: boolean
  onSavedAsNew: (id: string) => void
}): React.JSX.Element | null {
  const lens = useTabStore((s) => s.lenses.find((l) => l.id === s.activeLensId))
  const dirty = useTabStore((s) => isLensDirty(s.lenses, s.activeLensId, s))
  const [name, setName] = useState(lens?.name ?? '')
  if (!lens) return null
  const renamed = name.trim() !== '' && name.trim() !== lens.name
  const canSave = dirty || renamed
  return (
    <>
      <div className="flex items-center gap-2 border-b border-border px-4 py-3 pr-12">
        <LensIconView icon={lens.icon} className="size-4 shrink-0 text-muted-foreground" />
        <DialogTitle className="sr-only">Edit lens</DialogTitle>
        <Input
          aria-label="Lens name"
          value={name}
          autoFocus={focusName}
          onFocus={(e) => focusName && e.currentTarget.select()}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && canSave) useTabStore.getState().saveActiveLens(name)
          }}
          className="h-8 flex-1 text-sm font-medium"
        />
      </div>
      <DialogDescription className="sr-only">
        Changes show in the sidebar as you make them.
      </DialogDescription>
      <div
        role="tablist"
        aria-label="Lens settings"
        className="flex gap-1 border-b border-border px-3"
      >
        {TABS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => setLensEditorTab(key)}
            className={cn(
              '-mb-px border-b-2 px-2.5 py-2 text-xs transition-colors',
              tab === key
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            {label}
          </button>
        ))}
      </div>
      <div role="tabpanel" className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <LensEditorSection section={tab} />
      </div>
      <div className="flex items-center gap-2 border-t border-border px-4 py-3 text-xs">
        {canSave ? (
          <>
            <span aria-hidden className="size-1.5 rounded-full bg-primary" />
            <span>Unsaved changes</span>
          </>
        ) : (
          <span className="text-muted-foreground">No changes</span>
        )}
        <span className="flex-1" />
        {dirty && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => useTabStore.getState().revertActiveLens()}
          >
            Revert
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            const s = useTabStore.getState()
            const id = s.saveLensAs(uniqueLensName(s.lenses, `${name.trim() || lens.name} copy`))
            onSavedAsNew(id)
          }}
        >
          Save as new…
        </Button>
        <Button
          size="sm"
          disabled={!canSave}
          onClick={() => useTabStore.getState().saveActiveLens(name)}
        >
          Save
        </Button>
      </div>
    </>
  )
}
