import { useId, useState, type FormEvent } from 'react'
import {
  ArrowLeftRight,
  Check,
  ChevronDown,
  MonitorSmartphone,
  RectangleHorizontal,
  RectangleVertical
} from 'lucide-react'
import {
  Button,
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  Input,
  Label,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Switch
} from '@slayzone/ui'
import {
  DEVICE_CATEGORIES,
  MAX_DEVICE_VIEWPORT_SIZE,
  PREVIEW_DEVICES,
  deviceViewport,
  rotateDeviceViewport,
  type DeviceViewport,
  type PreviewDevice
} from '@slayzone/platform/preview-devices'
import type { ArtifactDeviceFrame } from './ArtifactDeviceFrame'

export type ArtifactDeviceSelection =
  | { kind: 'preset'; device: PreviewDevice; screen: number; rotated: boolean; showBoth?: boolean }
  | { kind: 'custom'; viewport: DeviceViewport }
  | null

function artifactDeviceViewport(selection: NonNullable<ArtifactDeviceSelection>): DeviceViewport {
  if (selection.kind === 'custom') return selection.viewport
  const viewport = deviceViewport(selection.device, selection.screen)
  return selection.rotated ? rotateDeviceViewport(viewport) : viewport
}

export interface ArtifactDevicePreview {
  slot: 'primary' | 'secondary'
  viewport: DeviceViewport
  frame?: ArtifactDeviceFrame
  label?: string
}

export function artifactDevicePreviews(
  selection: ArtifactDeviceSelection
): ArtifactDevicePreview[] {
  if (!selection) return []
  if (selection.kind === 'custom') return [{ slot: 'primary', viewport: selection.viewport }]

  const { device, screen, showBoth } = selection
  const screens = showBoth && device.screens.length > 1 ? [0, 1] : [screen]
  const primary = screens.includes(screen) ? screen : screens[0]
  return screens.map((index) => ({
    slot: index === primary ? 'primary' : 'secondary',
    viewport: artifactDeviceViewport({ ...selection, screen: index }),
    frame: { device, screen: index },
    label: screens.length > 1 ? device.screens[index]?.name : undefined
  }))
}

export function ArtifactDevicePicker({
  selection,
  onChange,
  showDeviceFrame,
  onShowDeviceFrameChange
}: {
  selection: ArtifactDeviceSelection
  onChange: (selection: ArtifactDeviceSelection) => void
  showDeviceFrame: boolean
  onShowDeviceFrameChange: (show: boolean) => void
}) {
  const [open, setOpen] = useState(false)
  const [custom, setCustom] = useState(false)
  const frameSwitchId = useId()
  const viewport = selection ? artifactDeviceViewport(selection) : undefined
  const screen =
    selection?.kind === 'preset' ? selection.device.screens[selection.screen] : undefined
  const name =
    selection?.kind === 'preset' ? selection.device.name : selection ? 'Custom' : 'Device'

  const foldable =
    selection?.kind === 'preset' && selection.device.screens.length > 1 ? selection : null
  const screenOptions = foldable
    ? [...foldable.device.screens.map(({ name }, index) => name ?? 'Screen ' + (index + 1)), 'Both']
    : []
  const showBoth = foldable?.showBoth === true
  const activeScreen = showBoth ? screenOptions.length - 1 : (foldable?.screen ?? 0)
  const nextScreen = activeScreen + 1 < screenOptions.length ? activeScreen + 1 : 0
  const screenAction = 'Switch to ' + screenOptions[nextScreen]
  const toPortrait = viewport && viewport.width > viewport.height
  const OrientationIcon = toPortrait ? RectangleVertical : RectangleHorizontal
  const orientationAction = showBoth
    ? 'Rotate both screens'
    : viewport?.width === viewport?.height
      ? 'Rotate preview 90°'
      : toPortrait
        ? 'Switch to portrait'
        : 'Switch to landscape'

  function chooseScreen(index: number) {
    if (!foldable) return
    const compare = index === foldable.device.screens.length
    onChange({ ...foldable, screen: compare ? foldable.screen : index, showBoth: compare })
  }

  function chooseDevice(device: PreviewDevice) {
    onChange({ kind: 'preset', device, screen: 0, rotated: false })
    setCustom(false)
    setOpen(false)
  }

  function applyCustom(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const values = new FormData(event.currentTarget)
    const width = Number(values.get('width'))
    const height = Number(values.get('height'))
    onChange({
      kind: 'custom',
      viewport: { width, height, mobile: false, deviceScaleFactor: 1, angle: 0 }
    })
    setCustom(false)
    setOpen(false)
  }

  function rotate() {
    if (selection?.kind === 'preset') onChange({ ...selection, rotated: !selection.rotated })
    if (selection?.kind === 'custom') {
      onChange({ kind: 'custom', viewport: rotateDeviceViewport(selection.viewport) })
    }
  }

  return (
    <div className="flex shrink-0 items-center gap-1">
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (!next) setCustom(false)
        }}
      >
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 px-2 text-xs"
            aria-label={
              showBoth
                ? 'Device preview, ' + name + ', both screens'
                : viewport
                  ? `Device preview, ${name}${screen?.name ? `, ${screen.name}` : ''}, ${viewport.width} by ${viewport.height}`
                  : 'Device preview'
            }
          >
            <MonitorSmartphone className="size-3.5" />
            <span className="max-w-32 truncate">{name}</span>
            <ChevronDown className="size-3 opacity-60" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          collisionPadding={8}
          className="flex max-h-[var(--radix-popover-content-available-height)] flex-col overflow-hidden p-0"
        >
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2">
            <Label htmlFor={frameSwitchId} className="cursor-pointer text-xs">
              Show device frame
            </Label>
            <Switch
              id={frameSwitchId}
              checked={showDeviceFrame}
              onCheckedChange={onShowDeviceFrameChange}
            />
          </div>
          {foldable && (
            <div
              className="flex shrink-0 flex-wrap gap-1 border-b border-border p-2"
              role="group"
              aria-label="Device screen"
            >
              {screenOptions.map((option, index) => (
                <Button
                  key={option}
                  type="button"
                  variant={activeScreen === index ? 'secondary' : 'ghost'}
                  size="sm"
                  className="h-7 px-2 text-xs"
                  aria-pressed={activeScreen === index}
                  onClick={() => {
                    chooseScreen(index)
                    setOpen(false)
                  }}
                >
                  {option}
                </Button>
              ))}
            </div>
          )}
          <Command className="h-auto min-h-0 [&_[cmdk-input-wrapper]]:shrink-0">
            <CommandInput placeholder="Search devices…" aria-label="Search devices" />
            <CommandList className="min-h-0 max-h-none">
              <CommandEmpty>No matching devices.</CommandEmpty>
              <CommandItem
                value="Fit to pane"
                onSelect={() => {
                  onChange(null)
                  setOpen(false)
                }}
              >
                <span className="flex-1">Fit to pane</span>
                {!selection && <Check className="size-3.5" />}
              </CommandItem>
              {DEVICE_CATEGORIES.map((category) => (
                <CommandGroup key={category} heading={category}>
                  {PREVIEW_DEVICES.filter((device) => device.category === category).map(
                    (device) => (
                      <CommandItem
                        key={device.id}
                        value={device.name}
                        keywords={[category]}
                        onSelect={() => chooseDevice(device)}
                      >
                        <span className="flex-1">{device.name}</span>
                        {selection?.kind === 'preset' && selection.device.id === device.id ? (
                          <Check className="size-3.5" />
                        ) : device.screens.length === 1 ? (
                          <span className="text-xs tabular-nums text-muted-foreground">
                            {device.screens[0].width}×{device.screens[0].height}
                          </span>
                        ) : null}
                      </CommandItem>
                    )
                  )}
                </CommandGroup>
              ))}
            </CommandList>
          </Command>
          <div className="shrink-0 border-t border-border p-2">
            {custom ? (
              <form onSubmit={applyCustom} className="flex items-center gap-1.5">
                <Input
                  autoFocus
                  name="width"
                  aria-label="Viewport width"
                  type="number"
                  step={1}
                  min={1}
                  max={MAX_DEVICE_VIEWPORT_SIZE}
                  required
                  defaultValue={viewport?.width ?? 1280}
                  className="h-7 min-w-0"
                />
                <span aria-hidden="true">×</span>
                <Input
                  name="height"
                  aria-label="Viewport height"
                  type="number"
                  step={1}
                  min={1}
                  max={MAX_DEVICE_VIEWPORT_SIZE}
                  required
                  defaultValue={viewport?.height ?? 800}
                  className="h-7 min-w-0"
                />
                <Button type="submit" variant="secondary" size="sm" className="h-7">
                  Apply
                </Button>
              </form>
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 w-full justify-start px-2 text-xs"
                onClick={() => setCustom(true)}
              >
                Custom size
              </Button>
            )}
          </div>
        </PopoverContent>
      </Popover>
      {foldable && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 px-2 text-xs"
          title={screenAction}
          aria-label={screenAction}
          onClick={() => chooseScreen(nextScreen)}
        >
          <ArrowLeftRight className="size-3.5" />
          <span className="max-w-24 truncate">{screenOptions[activeScreen]}</span>
        </Button>
      )}
      {viewport && (
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="size-7"
          title={orientationAction}
          aria-label={orientationAction}
          onClick={rotate}
        >
          <OrientationIcon className="size-3.5" />
        </Button>
      )}
    </div>
  )
}
