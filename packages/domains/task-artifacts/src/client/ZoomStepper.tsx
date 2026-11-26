import { Minus, Plus } from 'lucide-react'
import { Button } from '@slayzone/ui'
import { DEFAULT_ZOOM_PCT, stepZoom, ZOOM_STEPS } from '@slayzone/task-contracts'

/** `[−] 110% [+]` on the zoom ladder; the readout resets to 100%. */
export function ZoomStepper({
  zoom,
  onZoom,
  label,
  noun,
  testId
}: {
  zoom: number
  onZoom: (zoom: number) => void
  /** The group's accessible name, e.g. "Artifact zoom". */
  label: string
  /** What the buttons change, in their names: "Zoom in", "Display zoom in". */
  noun: string
  testId: string
}) {
  const segmentClass =
    'h-full rounded-none border-0 p-0 shadow-none active:scale-100 disabled:opacity-100 disabled:text-muted-foreground'
  return (
    <div
      className="inline-flex h-7 shrink-0 items-center overflow-hidden rounded-md border shadow-xs dark:border-input"
      data-testid={testId}
      role="group"
      aria-label={label}
    >
      <Button
        type="button"
        variant="outline"
        size="icon"
        className={`${segmentClass} w-6`}
        onClick={() => onZoom(stepZoom(zoom, -1))}
        disabled={zoom <= ZOOM_STEPS[0]}
        title={noun + ' out'}
        aria-label={noun + ' out'}
        data-testid={testId + '-out'}
      >
        <Minus className="size-3" />
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className={`${segmentClass} min-w-11 px-1 text-[11px] tabular-nums`}
        onClick={() => onZoom(DEFAULT_ZOOM_PCT)}
        title={'Reset ' + noun.toLowerCase()}
        aria-label={'Reset ' + noun.toLowerCase()}
        data-testid={testId + '-value'}
      >
        {zoom}%
      </Button>
      <Button
        type="button"
        variant="outline"
        size="icon"
        className={`${segmentClass} w-6`}
        onClick={() => onZoom(stepZoom(zoom, 1))}
        disabled={zoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1]}
        title={noun + ' in'}
        aria-label={noun + ' in'}
        data-testid={testId + '-in'}
      >
        <Plus className="size-3" />
      </Button>
    </div>
  )
}
