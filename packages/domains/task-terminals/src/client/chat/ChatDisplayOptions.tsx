import { type ComponentType } from 'react'
import {
  Activity,
  Eye,
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
      </section>
      <section aria-label="Activity">
        <h3 className="px-2 pb-1 pt-2 text-[9px] font-medium uppercase tracking-widest text-muted-foreground">
          Activity
        </h3>
        <Option
          icon={Eye}
          label="Preview latest activity"
          checked={appearance.chatPreviewLatestActivity}
          onChange={toggle('chat_preview_latest_activity')}
        />
        <Option
          icon={Activity}
          label="Show activities"
          checked={appearance.chatShowActivities}
          onChange={toggle('chat_show_activities')}
        />
        {appearance.chatShowActivities && (
          <>
            <Option
              nested
              label="Messages"
              checked={appearance.chatShowActivityMessages}
              onChange={toggle('chat_show_activity_messages')}
            />
            <Option
              nested
              label="Thinking"
              checked={appearance.chatShowThinking}
              onChange={toggle('chat_show_thinking')}
            />
            <Option
              nested
              label="Tool calls"
              checked={appearance.chatShowActivityTools}
              onChange={toggle('chat_show_activity_tools')}
            />
          </>
        )}
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
  onChange,
  nested = false
}: {
  icon?: ComponentType<{ className?: string }>
  label: string
  checked: boolean
  onChange: (value: boolean) => void
  nested?: boolean
}) {
  return (
    <label className={cn(rowClass, 'group/option relative cursor-pointer', nested && 'pl-[34px]')}>
      {Icon && <Icon className={iconClass} />}
      {nested && (
        <span
          aria-hidden="true"
          className="absolute left-[15px] -top-2 h-6 w-2.5 rounded-bl border-b border-l border-muted-foreground/60"
        />
      )}
      <span className="flex-1 text-xs font-medium">{label}</span>
      <Switch aria-label={label} checked={checked} onCheckedChange={onChange} />
    </label>
  )
}
