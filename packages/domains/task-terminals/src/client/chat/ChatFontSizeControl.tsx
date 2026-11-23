import { ALargeSmall, Minus, Plus } from 'lucide-react'
import { useMutation } from '@tanstack/react-query'
import {
  Button,
  IconButton,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  cn
} from '@slayzone/ui'
import { useTRPC } from '../trpc'
import { CHAT_FONT_SIZE_MAX, CHAT_FONT_SIZE_MIN } from '../../shared/chat-font-size'

/**
 * Tab-bar control for one chat's text size. The chat keeps its own size
 * (`terminal_tabs.chat_font_size`) until reset; "Save as default" makes the
 * size the `chat_font_size` setting and drops the chat's own, so it follows the
 * default from then on.
 */
export function ChatFontSizeControl({
  override,
  defaultSize,
  onChange
}: {
  /** The chat's own size, px; null when it follows the default. */
  override: number | null
  defaultSize: number
  /** A size for this chat; null follows the default again. */
  onChange: (size: number | null) => void
}): React.ReactElement {
  const trpc = useTRPC()
  const { mutate: setSetting, isPending: saving } = useMutation({
    ...trpc.settings.set.mutationOptions(),
    onSuccess: () => {
      window.dispatchEvent(new CustomEvent('sz:settings-changed'))
      onChange(null)
    }
  })
  const size = override ?? defaultSize
  const step = (delta: number) => {
    const next = Math.min(CHAT_FONT_SIZE_MAX, Math.max(CHAT_FONT_SIZE_MIN, size + delta))
    // Landing on the default follows it again rather than pinning a copy of it.
    onChange(next === defaultSize ? null : next)
  }

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <IconButton
              data-testid="chat-font-size-toggle"
              variant="ghost"
              className={cn('size-7', override !== null && 'bg-accent text-accent-foreground')}
              aria-label="Chat font size"
            >
              <ALargeSmall className="size-3.5" />
            </IconButton>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">Chat font size</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-60 p-3" data-testid="chat-font-size-popover">
        <div className="flex items-center gap-2">
          <span className="flex-1 text-xs font-medium">Font size</span>
          <IconButton
            variant="outline"
            className="size-7"
            aria-label="Smaller"
            disabled={size <= CHAT_FONT_SIZE_MIN}
            onClick={() => step(-1)}
          >
            <Minus className="size-3.5" />
          </IconButton>
          <span
            data-testid="chat-font-size-value"
            className="w-10 text-center text-xs tabular-nums"
          >
            {size}px
          </span>
          <IconButton
            variant="outline"
            className="size-7"
            aria-label="Larger"
            disabled={size >= CHAT_FONT_SIZE_MAX}
            onClick={() => step(1)}
          >
            <Plus className="size-3.5" />
          </IconButton>
        </div>
        <p className="mt-2 text-2xs text-muted-foreground">
          {override === null
            ? `This chat uses the default (${defaultSize}px).`
            : `This chat only. Default is ${defaultSize}px.`}
        </p>
        <div className="mt-3 flex items-center justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            disabled={override === null}
            onClick={() => onChange(null)}
          >
            Reset
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            data-testid="chat-font-size-save-default"
            disabled={override === null || saving}
            onClick={() => setSetting({ key: 'chat_font_size', value: String(size) })}
          >
            Save as default
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
