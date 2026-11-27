import { useState } from 'react'
import { Link } from 'lucide-react'
import { normalizeWebPageUrl } from '@slayzone/task-contracts'
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle, Input } from '@slayzone/ui'

/**
 * A web page's URL, set once (docs/plans/panel-model.md step 12): asked for in the
 * panel when a new page first shows, changed later from its tab menu or header
 * ("Edit URL…"). Typed text goes through `normalizeWebPageUrl`.
 */

function UrlFields({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
  testIdPrefix
}: {
  initial: string
  submitLabel: string
  onSubmit: (url: string) => void
  onCancel?: () => void
  testIdPrefix: string
}): React.JSX.Element {
  const [text, setText] = useState(initial)
  const [touched, setTouched] = useState(false)
  const url = normalizeWebPageUrl(text)
  const showError = touched && text.trim() !== '' && url === null
  return (
    <form
      className="grid gap-3 w-full"
      onSubmit={(e) => {
        e.preventDefault()
        setTouched(true)
        if (url) onSubmit(url)
      }}
    >
      <Input
        autoFocus
        aria-label="Page URL"
        aria-invalid={showError}
        placeholder="https://example.com"
        data-testid={`${testIdPrefix}-input`}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => setTouched(true)}
        onFocus={(e) => e.target.select()}
      />
      {showError && (
        <p className="text-xs text-destructive">That doesn't look like a web address.</p>
      )}
      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button type="submit" size="sm" disabled={!url} data-testid={`${testIdPrefix}-submit`}>
          {submitLabel}
        </Button>
      </div>
    </form>
  )
}

/** In the panel of a web page with no URL yet: what should it show? */
export function WebPageUrlPrompt({
  canEdit,
  onSubmit
}: {
  canEdit: boolean
  onSubmit: (url: string) => void
}): React.JSX.Element {
  return (
    <div className="flex h-full items-center justify-center p-6" data-testid="web-page-prompt">
      <div className="w-full max-w-sm flex flex-col items-center gap-3 text-center">
        <Link className="size-6 text-muted-foreground" />
        <div className="text-sm font-medium">Which page should this panel show?</div>
        {canEdit ? (
          <UrlFields
            initial=""
            submitLabel="Open"
            onSubmit={onSubmit}
            testIdPrefix="web-page-url"
          />
        ) : (
          <div className="text-xs text-muted-foreground">No page is set for this panel yet.</div>
        )}
      </div>
    </div>
  )
}

/** "Edit URL…": change the page a web page panel shows. */
export function WebPageUrlDialog({
  open,
  url,
  onOpenChange,
  onSubmit
}: {
  open: boolean
  url: string
  onOpenChange: (open: boolean) => void
  onSubmit: (url: string) => void
}): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[420px]" data-testid="web-page-url-dialog">
        <DialogHeader>
          <DialogTitle>Web page URL</DialogTitle>
        </DialogHeader>
        {open && (
          <UrlFields
            initial={url}
            submitLabel="Save"
            testIdPrefix="web-page-edit-url"
            onCancel={() => onOpenChange(false)}
            onSubmit={(next) => {
              onSubmit(next)
              onOpenChange(false)
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
