import { type ComponentType } from 'react'
import {
  Brain,
  Code,
  FileText,
  Maximize2,
  MessageSquare,
  Rows3,
  ScrollText,
  WrapText
} from 'lucide-react'
import { useMutation } from '@tanstack/react-query'
import { cn, Switch, type AppearanceSettings } from '@slayzone/ui'
import { useTRPC } from '../trpc'

export function ChatDisplayOptions({ appearance }: { appearance: AppearanceSettings }) {
  const trpc = useTRPC()
  const { mutate } = useMutation({
    ...trpc.settings.set.mutationOptions(),
    onSuccess: () => window.dispatchEvent(new CustomEvent('sz:settings-changed'))
  })
  const toggle = (key: string) => (value: boolean) => mutate({ key, value: value ? '1' : '0' })
  return (
    <div className="space-y-2">
      <section aria-label="Layout">
        <h3 className="px-2 pb-1 pt-2 text-[9px] font-medium uppercase tracking-widest text-muted-foreground">
          Layout
        </h3>
        <Option
          icon={Maximize2}
          label="Full-width messages"
          checked={appearance.chatWidth === 'wide'}
          onChange={(value) => mutate({ key: 'chat_width', value: value ? 'wide' : 'narrow' })}
        />
        <Option
          icon={Rows3}
          label="Compact spacing"
          checked={appearance.chatCompactSpacing}
          onChange={toggle('chat_compact_spacing')}
        />
        <Option
          icon={WrapText}
          label="Wrap code lines"
          checked={appearance.chatWrapCode}
          onChange={toggle('chat_wrap_code')}
        />
      </section>
      <section aria-label="Conversation">
        <h3 className="px-2 pb-1 pt-2 text-[9px] font-medium uppercase tracking-widest text-muted-foreground">
          Conversation
        </h3>
        <Option
          icon={Code}
          label="Tool calls"
          checked={appearance.chatToolVisibility !== 'none'}
          onChange={(value) =>
            mutate({ key: 'chat_tool_visibility', value: value ? 'all' : 'none' })
          }
        />
        <Option
          icon={FileText}
          label="Expand file edits"
          checked={appearance.chatFileEditsOpenByDefault}
          onChange={toggle('chat_file_edits_open_by_default')}
        />
        <Option
          icon={MessageSquare}
          label="Message details"
          checked={appearance.chatShowMessageMeta}
          onChange={toggle('chat_show_message_meta')}
        />
        <Option
          icon={Brain}
          label="Show thinking"
          checked={appearance.chatShowThinking}
          onChange={toggle('chat_show_thinking')}
        />
      </section>
      <section aria-label="Scrolling">
        <h3 className="px-2 pb-1 pt-2 text-[9px] font-medium uppercase tracking-widest text-muted-foreground">
          Scrolling
        </h3>
        <Option
          icon={ScrollText}
          label="Auto-scroll"
          checked={appearance.chatAutoScroll}
          onChange={toggle('chat_auto_scroll')}
        />
      </section>
    </div>
  )
}

const rowClass =
  'flex h-8 items-center gap-2.5 rounded-md px-2 transition-colors hover:bg-muted dark:hover:bg-foreground/10'
const iconClass =
  'size-4 shrink-0 text-muted-foreground transition-transform motion-safe:group-hover/option:scale-110'
function Option({
  icon: Icon,
  label,
  checked,
  onChange
}: {
  icon: ComponentType<{ className?: string }>
  label: string
  checked: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <label className={cn(rowClass, 'group/option cursor-pointer')}>
      <Icon className={iconClass} />
      <span className="flex-1 text-xs font-medium">{label}</span>
      <Switch aria-label={label} checked={checked} onCheckedChange={onChange} />
    </label>
  )
}
