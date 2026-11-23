import { useId, useState, type FormEvent } from 'react'
import { Check, ChevronDown, MonitorSmartphone, RotateCw } from 'lucide-react'
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

export type ArtifactDeviceSelection =
  | { kind: 'preset'; device: PreviewDevice; screen: number; rotated: boolean }
  | { kind: 'custom'; viewport: DeviceViewport }
  | null

export function artifactDeviceViewport(
  selection: ArtifactDeviceSelection
): DeviceViewport | undefined {
  if (!selection) return undefined
  if (selection.kind === 'custom') return selection.viewport
  const viewport = deviceViewport(selection.device, selection.screen)
  return selection.rotated ? rotateDeviceViewport(viewport) : viewport
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
  const viewport = artifactDeviceViewport(selection)
  const screen =
    selection?.kind === 'preset' ? selection.device.screens[selection.screen] : undefined
  const name =
    selection?.kind === 'preset' ? selection.device.name : selection ? 'Custom' : 'Device'

  function chooseDevice(device: PreviewDevice) {
    onChange({ kind: 'preset', device, screen: 0, rotated: false })
    setOpen(device.screens.length > 1)
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
              viewport
                ? `Device preview, ${name}${screen?.name ? `, ${screen.name}` : ''}, ${viewport.width} by ${viewport.height}`
                : 'Device preview'
            }
          >
            <MonitorSmartphone className="size-3.5" />
            <span className="max-w-32 truncate">
              {name}
              {screen?.name ? ` · ${screen.name}` : ''}
            </span>
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
          {selection?.kind === 'preset' && selection.device.screens.length > 1 && (
            <div
              className="flex shrink-0 flex-wrap gap-1 border-b border-border p-2"
              role="group"
              aria-label="Device screen"
            >
              {selection.device.screens.map((option, index) => (
                <Button
                  key={option.name}
                  type="button"
                  variant={selection.screen === index ? 'secondary' : 'ghost'}
                  size="sm"
                  className="h-7 px-2 text-xs"
                  aria-pressed={selection.screen === index}
                  onClick={() => {
                    onChange({ ...selection, screen: index })
                    setOpen(false)
                  }}
                >
                  {option.name}
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
      {viewport && (
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="size-7"
          title="Rotate device"
          aria-label="Rotate device"
          onClick={rotate}
        >
          <RotateCw className="size-3.5" />
        </Button>
      )}
    </div>
  )
}
