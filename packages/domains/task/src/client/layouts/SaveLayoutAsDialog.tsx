import { useState } from 'react'
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input
} from '@slayzone/ui'

/** "Save as…": name the task's current layout as a new layout of the user's. */
export function SaveLayoutAsDialog({
  open,
  defaultName,
  onOpenChange,
  onSave
}: {
  open: boolean
  defaultName: string
  onOpenChange: (open: boolean) => void
  onSave: (name: string) => void
}): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[360px]" data-testid="save-layout-as-dialog">
        {open && (
          <SaveLayoutAsBody
            defaultName={defaultName}
            onCancel={() => onOpenChange(false)}
            onSave={(name) => {
              onSave(name)
              onOpenChange(false)
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function SaveLayoutAsBody({
  defaultName,
  onCancel,
  onSave
}: {
  defaultName: string
  onCancel: () => void
  onSave: (name: string) => void
}): React.JSX.Element {
  const [name, setName] = useState(defaultName)
  const valid = name.trim() !== ''
  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault()
        if (valid) onSave(name.trim())
      }}
    >
      <DialogHeader>
        <DialogTitle>Save as new layout</DialogTitle>
      </DialogHeader>
      <Input
        autoFocus
        aria-label="Layout name"
        data-testid="save-layout-as-name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onFocus={(e) => e.target.select()}
      />
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={!valid} data-testid="save-layout-as-confirm">
          Save
        </Button>
      </DialogFooter>
    </form>
  )
}
