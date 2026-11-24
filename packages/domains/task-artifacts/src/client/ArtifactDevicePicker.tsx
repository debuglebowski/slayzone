import { useId, useState, type FormEvent } from 'react'
import {
  ArrowLeftRight,
  Check,
  ChevronDown,
  Maximize,
  MonitorSmartphone,
  RectangleHorizontal,
  RectangleVertical,
  Ruler
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

export interface ArtifactDeviceSettingsProps {
  selection: ArtifactDeviceSelection
  onChange: (selection: ArtifactDeviceSelection) => void
  showDeviceFrame: boolean
  onShowDeviceFrameChange: (show: boolean) => void
}

function deviceControls({ selection, onChange }: ArtifactDeviceSettingsProps) {
  const viewport = selection ? artifactDeviceViewport(selection) : undefined
  const screen =
    selection?.kind === 'preset' ? selection.device.screens[selection.screen] : undefined
  const name =
    selection?.kind === 'preset' ? selection.device.name : selection ? 'Custom' : 'Fit to pane'

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

  function rotate() {
    if (selection?.kind === 'preset') onChange({ ...selection, rotated: !selection.rotated })
    if (selection?.kind === 'custom') {
      onChange({ kind: 'custom', viewport: rotateDeviceViewport(selection.viewport) })
    }
  }
  return {
    viewport,
    screen,
    name,
    screenOptions,
    showBoth,
    activeScreen,
    nextScreen,
    screenAction,
    OrientationIcon,
    orientationAction,
    chooseScreen,
    rotate
  }
}

export function ArtifactDeviceSettings({
  onDone,
  showOrientation = false,
  ...props
}: ArtifactDeviceSettingsProps & { onDone: () => void; showOrientation?: boolean }) {
  const { selection, onChange, showDeviceFrame, onShowDeviceFrameChange } = props
  const [custom, setCustom] = useState(false)
  const [search, setSearch] = useState('')
  const searching = search.trim().length > 0
  const frameSwitchId = useId()
  const customFormId = useId()
  const {
    viewport,
    screenOptions,
    activeScreen,
    chooseScreen,
    OrientationIcon,
    orientationAction,
    rotate
  } = deviceControls(props)

  function fitToPane() {
    onChange(null)
    onDone()
  }

  function openCustom() {
    setSearch('')
    setCustom(true)
  }

  function chooseDevice(device: PreviewDevice) {
    onChange({ kind: 'preset', device, screen: 0, rotated: false })
    setCustom(false)
    onDone()
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
    onDone()
  }

  return (
    <>
      <Command label="Search devices" className="h-auto min-h-0">
        <div className="flex shrink-0 flex-col gap-2 border-b border-border p-2.5">
          <div className="rounded-md border border-input bg-background focus-within:border-ring [&>[cmdk-input-wrapper]]:border-b-0 [&>[cmdk-input-wrapper]]:px-2">
            <CommandInput
              placeholder="Search devices…"
              className="h-8 py-0 text-xs"
              value={search}
              onValueChange={setSearch}
            />
          </div>
          {/* cmdk shortcuts apply to its search field, while these controls use native form keys. */}
          <div
            className="flex flex-col gap-2 empty:hidden"
            onKeyDown={(event) => event.stopPropagation()}
          >
            {!searching && (
              <div role="group" aria-label="Viewport sizing" className="grid grid-cols-2 gap-1.5">
                <Button
                  type="button"
                  variant={selection === null ? 'secondary' : 'outline'}
                  size="sm"
                  className="h-8 min-w-0 justify-start gap-1.5 px-2 text-xs"
                  aria-pressed={selection === null}
                  onClick={fitToPane}
                >
                  <Maximize className="size-3.5" />
                  <span className="truncate">Fit to pane</span>
                  {!selection && <Check className="ml-auto size-3" />}
                </Button>
                <Button
                  type="button"
                  variant={custom || selection?.kind === 'custom' ? 'secondary' : 'outline'}
                  size="sm"
                  className="h-8 min-w-0 justify-start gap-1.5 px-2 text-xs"
                  aria-expanded={custom}
                  aria-controls={custom ? customFormId : undefined}
                  onClick={() => (custom ? setCustom(false) : openCustom())}
                >
                  <Ruler className="size-3.5" />
                  <span className="truncate">Custom size</span>
                  <ChevronDown
                    className={custom ? 'ml-auto size-3 rotate-180' : 'ml-auto size-3'}
                  />
                </Button>
              </div>
            )}
            {custom && (
              <form
                id={customFormId}
                onSubmit={applyCustom}
                className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-end gap-2 rounded-md border border-border bg-muted/30 p-2"
              >
                <div className="min-w-0 space-y-1">
                  <Label
                    htmlFor={`${customFormId}-width`}
                    className="text-xs text-muted-foreground"
                  >
                    Width
                  </Label>
                  <Input
                    autoFocus
                    id={`${customFormId}-width`}
                    name="width"
                    aria-label="Viewport width"
                    type="number"
                    step={1}
                    min={1}
                    max={MAX_DEVICE_VIEWPORT_SIZE}
                    required
                    defaultValue={viewport?.width ?? 1280}
                    className="h-8 min-w-0 bg-background px-2 text-xs tabular-nums"
                  />
                </div>
                <div className="min-w-0 space-y-1">
                  <Label
                    htmlFor={`${customFormId}-height`}
                    className="text-xs text-muted-foreground"
                  >
                    Height
                  </Label>
                  <Input
                    id={`${customFormId}-height`}
                    name="height"
                    aria-label="Viewport height"
                    type="number"
                    step={1}
                    min={1}
                    max={MAX_DEVICE_VIEWPORT_SIZE}
                    required
                    defaultValue={viewport?.height ?? 800}
                    className="h-8 min-w-0 bg-background px-2 text-xs tabular-nums"
                  />
                </div>
                <Button type="submit" variant="secondary" size="sm" className="h-8 px-2 text-xs">
                  Apply
                </Button>
              </form>
            )}
          </div>
        </div>
        <CommandList className="min-h-0 max-h-none py-1">
          <CommandEmpty>No matching devices.</CommandEmpty>
          {searching && (
            <CommandGroup heading="Viewport sizing">
              <CommandItem value="Fit to pane" onSelect={fitToPane}>
                Fit to pane
              </CommandItem>
              <CommandItem value="Custom size" onSelect={openCustom}>
                Custom size
              </CommandItem>
            </CommandGroup>
          )}
          {DEVICE_CATEGORIES.map((category) => (
            <CommandGroup key={category} heading={category}>
              {PREVIEW_DEVICES.filter((device) => device.category === category).map((device) => (
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
              ))}
            </CommandGroup>
          ))}
        </CommandList>
      </Command>
      <div className="shrink-0 space-y-2 border-t border-border p-2.5">
        {screenOptions.length > 0 && (
          <div className="flex flex-wrap gap-1" role="group" aria-label="Device screen">
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
                  onDone()
                }}
              >
                {option}
              </Button>
            ))}
          </div>
        )}
        <div className="flex items-center gap-2">
          <Label htmlFor={frameSwitchId} className="flex-1 cursor-pointer text-xs">
            Show device frame
          </Label>
          <Switch
            id={frameSwitchId}
            checked={showDeviceFrame}
            onCheckedChange={onShowDeviceFrameChange}
          />
          {showOrientation && viewport && (
            <Button
              type="button"
              variant="ghost"
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
      </div>
    </>
  )
}

export function ArtifactDevicePicker(props: ArtifactDeviceSettingsProps) {
  const [open, setOpen] = useState(false)
  const {
    viewport,
    screen,
    name,
    screenOptions,
    showBoth,
    activeScreen,
    nextScreen,
    screenAction,
    OrientationIcon,
    orientationAction,
    chooseScreen,
    rotate
  } = deviceControls(props)

  return (
    <div className="flex shrink-0 items-center gap-1">
      <Popover open={open} onOpenChange={setOpen}>
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
          className="flex max-h-[var(--radix-popover-content-available-height)] w-80 max-w-[var(--radix-popover-content-available-width)] flex-col overflow-hidden p-0"
        >
          <ArtifactDeviceSettings {...props} onDone={() => setOpen(false)} />
        </PopoverContent>
      </Popover>
      {screenOptions.length > 0 && (
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
