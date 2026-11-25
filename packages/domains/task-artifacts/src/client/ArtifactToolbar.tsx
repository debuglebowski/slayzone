import { useId, useState, type ReactNode } from 'react'
import { useMutation } from '@tanstack/react-query'
import {
  Archive,
  Check,
  ChevronDown,
  Code2,
  Columns2,
  Download,
  Eye,
  FileCode,
  FileText,
  History,
  ImageDown,
  Minus,
  MonitorSmartphone,
  Plus,
  SlidersHorizontal
} from 'lucide-react'
import {
  Button,
  Label,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Switch,
  useAppearance
} from '@slayzone/ui'
import {
  canExportAsHtml,
  canExportAsPdf,
  canExportAsPng,
  DEFAULT_ZOOM_PCT,
  getEffectiveRenderMode,
  hasZoomableSurface,
  RENDER_MODE_INFO,
  type RenderMode,
  stepZoom,
  type TaskArtifact,
  type UpdateArtifactInput,
  ZOOM_STEPS
} from '@slayzone/task-contracts'
import {
  ArtifactDevicePicker,
  ArtifactDeviceSettings,
  type ArtifactDeviceSettingsProps
} from './ArtifactDevicePicker'
import { ArtifactToolbarMenu, type ArtifactToolbarAction } from './ArtifactToolbarMenu'
import {
  HTML_THEME_CYCLE,
  HTML_THEME_ICONS,
  HTML_THEME_LABELS,
  nextHtmlTheme
} from './ArtifactsPanel.constants'
import type { ArtifactViewMode } from './ArtifactsPanel.types'
import { useTRPC } from './trpc'

type UpdateArtifact = (patch: Omit<UpdateArtifactInput, 'id'>) => void

const viewModes = {
  preview: { label: 'Preview', icon: Eye },
  split: { label: 'Split', icon: Columns2 },
  raw: { label: 'Raw', icon: Code2 }
} satisfies Record<ArtifactViewMode, { label: string; icon: typeof Eye }>

function optionAction({
  caption,
  ...action
}: Omit<ArtifactToolbarAction, 'control'> & {
  caption?: string
  content: NonNullable<ArtifactToolbarAction['content']>
}): ArtifactToolbarAction {
  return { ...action, control: <ToolbarOptionPopover action={action} caption={caption} /> }
}

function ToolbarOptionPopover({
  action,
  caption = action.label
}: {
  action: Omit<ArtifactToolbarAction, 'control'> & {
    content: NonNullable<ArtifactToolbarAction['content']>
  }
  caption?: string
}) {
  const [open, setOpen] = useState(false)
  const Icon = action.icon
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 px-2 text-xs"
          aria-label={caption === action.label ? action.label : `${action.label}: ${caption}`}
        >
          <Icon className="size-3.5" />
          <span className="max-w-32 truncate">{caption}</span>
          <ChevronDown className="size-3 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        collisionPadding={8}
        aria-label={action.label}
        className="max-h-[var(--radix-popover-content-available-height)] w-72 max-w-[var(--radix-popover-content-available-width)] overflow-y-auto p-1"
      >
        {action.content(() => setOpen(false))}
      </PopoverContent>
    </Popover>
  )
}

function ToolbarOption({
  label,
  onClick,
  checked,
  children
}: {
  label: string
  onClick: () => void
  checked?: boolean
  children?: ReactNode
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-8 w-full justify-start gap-2 px-2 text-xs"
      onClick={onClick}
      aria-pressed={checked}
    >
      {children}
      {label}
      {checked && <Check className="ml-auto size-3.5" />}
    </Button>
  )
}

function ArtifactZoomControls({ zoom, onZoom }: { zoom: number; onZoom: (zoom: number) => void }) {
  const segmentClass =
    'h-full rounded-none border-0 p-0 shadow-none active:scale-100 disabled:opacity-100 disabled:text-muted-foreground'
  return (
    <div
      className="inline-flex h-7 shrink-0 items-center overflow-hidden rounded-md border shadow-xs dark:border-input"
      data-testid="artifact-zoom"
      role="group"
      aria-label="Artifact zoom"
    >
      <Button
        type="button"
        variant="outline"
        size="icon"
        className={`${segmentClass} w-6`}
        onClick={() => onZoom(stepZoom(zoom, -1))}
        disabled={zoom <= ZOOM_STEPS[0]}
        title="Zoom out"
        aria-label="Zoom out"
        data-testid="artifact-zoom-out"
      >
        <Minus className="size-3" />
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className={`${segmentClass} min-w-11 px-1 text-[11px] tabular-nums`}
        onClick={() => onZoom(DEFAULT_ZOOM_PCT)}
        title="Reset zoom"
        aria-label="Reset zoom"
        data-testid="artifact-zoom-value"
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
        title="Zoom in"
        aria-label="Zoom in"
        data-testid="artifact-zoom-in"
      >
        <Plus className="size-3" />
      </Button>
    </div>
  )
}

function DisplaySwitch({
  label,
  checked,
  onChange,
  override,
  disabled
}: {
  label: string
  checked: boolean
  onChange: (value: boolean) => void
  override?: boolean
  disabled?: boolean
}) {
  const id = useId()
  return (
    <div className="flex items-center justify-between gap-3">
      <Label htmlFor={id} className="cursor-pointer text-xs">
        {label}
        {override && <span className="ml-1 text-muted-foreground">(override)</span>}
      </Label>
      <Switch id={id} checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </div>
  )
}

function MarkdownDisplay({
  artifact,
  viewMode,
  update
}: {
  artifact: TaskArtifact
  viewMode: ArtifactViewMode
  update: UpdateArtifact
}) {
  const trpc = useTRPC()
  const { mutateAsync } = useMutation(trpc.settings.set.mutationOptions())
  const { notesReadability, notesWidth, notesFontFamily, editorMinimapEnabled, editorTocEnabled } =
    useAppearance()

  function setSetting(key: string, value: string) {
    void mutateAsync({ key, value }).then(() =>
      window.dispatchEvent(new Event('sz:settings-changed'))
    )
  }

  return (
    <div className="space-y-4 p-2">
      <div className="space-y-2">
        <h3 className="text-xs text-muted-foreground">Editor</h3>
        <DisplaySwitch
          label="Outline"
          checked={editorTocEnabled}
          onChange={(show) => setSetting('editor_toc_enabled', show ? '1' : '0')}
        />
        <DisplaySwitch
          label={viewMode === 'preview' ? 'Minimap (not in preview)' : 'Minimap'}
          checked={editorMinimapEnabled && viewMode !== 'preview'}
          disabled={viewMode === 'preview'}
          onChange={(show) => setSetting('editor_minimap_enabled', show ? '1' : '0')}
        />
      </div>
      <div className="space-y-2">
        <h3 className="text-xs text-muted-foreground">Layout</h3>
        <DisplaySwitch
          label="Compact"
          checked={(artifact.readability_override ?? notesReadability) === 'compact'}
          override={!!artifact.readability_override}
          onChange={(compact) => {
            const next = compact ? 'compact' : 'normal'
            update({ readabilityOverride: next === notesReadability ? null : next })
          }}
        />
        <DisplaySwitch
          label="Wide"
          checked={(artifact.width_override ?? notesWidth) === 'wide'}
          override={!!artifact.width_override}
          onChange={(wide) => {
            const next = wide ? 'wide' : 'narrow'
            update({ widthOverride: next === notesWidth ? null : next })
          }}
        />
        <DisplaySwitch
          label="Use mono font"
          checked={notesFontFamily === 'mono'}
          onChange={(mono) => setSetting('notes_font_family', mono ? 'mono' : 'sans')}
        />
      </div>
    </div>
  )
}

export function ArtifactToolbar({
  artifact,
  mode,
  viewMode,
  onViewModeChange,
  device,
  update,
  downloads,
  onVersions
}: {
  artifact: TaskArtifact
  mode: RenderMode
  viewMode: ArtifactViewMode
  onViewModeChange: (mode: ArtifactViewMode) => void
  device: ArtifactDeviceSettingsProps
  update: UpdateArtifact
  downloads: Record<'file' | 'pdf' | 'png' | 'html' | 'zip', () => void>
  onVersions: () => void
}) {
  const actions: ArtifactToolbarAction[] = []
  const isHtml = mode === 'html-preview'
  const isMarkdown = mode === 'markdown'
  const autoLabel = `Auto (${RENDER_MODE_INFO[getEffectiveRenderMode(artifact.title, null)].label})`
  const format = RENDER_MODE_INFO[mode].label

  if (isHtml || isMarkdown) {
    const { label, icon } = viewModes[viewMode]
    actions.push(
      optionAction({
        id: 'view',
        label: 'View mode',
        caption: label,
        icon,
        content: (close) =>
          (Object.keys(viewModes) as ArtifactViewMode[]).map((option) => {
            const { label, icon: Icon } = viewModes[option]
            return (
              <ToolbarOption
                key={option}
                label={label}
                checked={viewMode === option}
                onClick={() => {
                  onViewModeChange(option)
                  close()
                }}
              >
                <Icon className="size-3.5" />
              </ToolbarOption>
            )
          })
      })
    )
  }

  if (isHtml && viewMode !== 'raw') {
    actions.push({
      id: 'device',
      submenuClassName: 'w-80 p-0',
      label: 'Device',
      icon: MonitorSmartphone,
      control: <ArtifactDevicePicker {...device} />,
      content: (close) => <ArtifactDeviceSettings {...device} onDone={close} showOrientation />
    })
  }

  if (hasZoomableSurface(mode, viewMode)) {
    const zoom = (
      <ArtifactZoomControls
        zoom={artifact.zoom_pct ?? DEFAULT_ZOOM_PCT}
        onZoom={(next) => update({ zoomPct: next === DEFAULT_ZOOM_PCT ? null : next })}
      />
    )
    actions.push({
      id: 'zoom',
      label: 'Zoom',
      icon: Plus,
      control: zoom,
      content: () => <div className="p-2">{zoom}</div>
    })
  }

  if (isHtml) {
    const theme = artifact.html_theme_override ?? 'system'
    const ThemeIcon = HTML_THEME_ICONS[theme]
    const setTheme = (next: keyof typeof HTML_THEME_ICONS) =>
      update({ htmlThemeOverride: next === 'system' ? null : next })
    actions.push({
      id: 'theme',
      label: 'Theme',
      icon: ThemeIcon,
      control: (
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="size-7"
          title={`${HTML_THEME_LABELS[theme]} — click to cycle`}
          aria-label={HTML_THEME_LABELS[theme]}
          data-testid="artifact-html-theme"
          onClick={() => setTheme(nextHtmlTheme(theme))}
        >
          <ThemeIcon className="size-3.5" />
        </Button>
      ),
      content: (close) =>
        HTML_THEME_CYCLE.map((option) => {
          const Icon = HTML_THEME_ICONS[option]
          return (
            <ToolbarOption
              key={option}
              label={HTML_THEME_LABELS[option]}
              checked={theme === option}
              onClick={() => {
                setTheme(option)
                close()
              }}
            >
              <Icon className="size-3.5" />
            </ToolbarOption>
          )
        })
    })
  }

  if (isMarkdown) {
    actions.push(
      optionAction({
        id: 'display',
        submenuClassName: 'w-72',
        label: 'Display',
        icon: SlidersHorizontal,
        content: () => <MarkdownDisplay artifact={artifact} viewMode={viewMode} update={update} />
      })
    )
  }

  actions.push(
    optionAction({
      id: 'format',
      label: 'Render as',
      caption: artifact.render_mode ? format : autoLabel,
      icon: FileCode,
      content: (close) => (
        <>
          <ToolbarOption
            label={autoLabel}
            checked={!artifact.render_mode}
            onClick={() => {
              update({ renderMode: null })
              close()
            }}
          />
          {(Object.keys(RENDER_MODE_INFO) as RenderMode[]).map((option) => (
            <ToolbarOption
              key={option}
              label={RENDER_MODE_INFO[option].label}
              checked={artifact.render_mode === option}
              onClick={() => {
                update({ renderMode: option })
                close()
              }}
            />
          ))}
        </>
      )
    })
  )

  actions.push(
    optionAction({
      id: 'download',
      label: 'Download',
      icon: Download,
      content: (close) => {
        const options: Array<
          false | { id: keyof typeof downloads; label: string; icon: typeof Download }
        > = [
          { id: 'file', label: 'Download original', icon: Download },
          canExportAsPdf(mode) && { id: 'pdf', label: 'Download as PDF', icon: FileText },
          canExportAsPng(mode) && { id: 'png', label: 'Download as PNG', icon: ImageDown },
          canExportAsHtml(mode) && { id: 'html', label: 'Download as HTML', icon: FileCode },
          { id: 'zip', label: 'Download all as ZIP', icon: Archive }
        ]
        return options
          .filter((option) => option !== false)
          .map(({ id, label, icon: Icon }) => (
            <ToolbarOption
              key={id}
              label={label}
              onClick={() => {
                close()
                downloads[id]()
              }}
            >
              <Icon className="size-3.5" />
            </ToolbarOption>
          ))
      }
    })
  )

  actions.push({
    id: 'versions',
    label: 'Versions',
    icon: History,
    run: onVersions,
    control: (
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="size-7"
        aria-label="Versions"
        title="Versions"
        onClick={onVersions}
      >
        <History className="size-3.5" />
      </Button>
    )
  })

  return (
    <ArtifactToolbarMenu actions={actions} artifactId={artifact.id} mode={mode} format={format} />
  )
}
