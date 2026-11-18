import { useQuery } from '@tanstack/react-query'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@slayzone/ui'
import { useTRPC } from '../trpc'

/**
 * A file someone shared with the user on its own (T-100): they may not open its task,
 * so it opens here — its current text, or a note for a file that is not text.
 */
export function SharedArtifactDialog({
  artifactId,
  onClose
}: {
  artifactId: string | null
  onClose: () => void
}): React.JSX.Element {
  const trpc = useTRPC()
  const id = artifactId ?? ''
  const meta = useQuery({ ...trpc.artifacts.get.queryOptions({ id }), enabled: !!artifactId })
  const text = useQuery({ ...trpc.artifacts.readText.queryOptions({ id }), enabled: !!artifactId })
  const read = text.data
  return (
    <Dialog open={!!artifactId} onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="xl" data-testid="shared-artifact-dialog">
        <DialogHeader>
          <DialogTitle>{meta.data?.title ?? 'Shared file'}</DialogTitle>
        </DialogHeader>
        {text.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : read?.kind === 'text' ? (
          <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-md bg-surface-1 p-3 text-sm">
            {read.content}
          </pre>
        ) : (
          <p className="text-sm text-muted-foreground">
            {read?.kind === 'too-large'
              ? 'This file is too large to show here.'
              : read?.kind === 'binary'
                ? 'This file is not text.'
                : 'This file is not available.'}
          </p>
        )}
      </DialogContent>
    </Dialog>
  )
}
