import { Dialog, DialogContent, DialogTitle } from '@slayzone/ui'

/** An image at full size (fit to the window). `src` null = closed. */
export function ImageLightbox({
  name,
  src,
  onClose
}: {
  name: string
  src: string | null
  onClose: () => void
}): React.JSX.Element {
  return (
    <Dialog open={src !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        aria-describedby={undefined}
        className="w-auto max-w-[94vw] gap-2 p-3"
        data-testid="chat-image-lightbox"
      >
        <DialogTitle className="truncate pr-8 text-sm font-medium">{name}</DialogTitle>
        {src && (
          <img
            src={src}
            alt={name}
            className="block max-h-[85vh] max-w-[90vw] rounded object-contain"
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

/** An image that opens full size on click. */
export function ImageOpenButton({
  name,
  src,
  onOpen,
  className
}: {
  name: string
  src: string
  onOpen: (src: string) => void
  className?: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={() => onOpen(src)}
      aria-label={`Open ${name} full size`}
      className="block cursor-zoom-in"
    >
      <img src={src} alt={name} className={className} />
    </button>
  )
}
