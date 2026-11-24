import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  agentModeLabel,
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  cn,
  toast
} from '@slayzone/ui'
import { getModeLabel, getVisibleModes, useAgents } from '@slayzone/terminal'
import {
  AGENT_STARTUP_SETTING,
  chatModesForMode,
  defaultChatModeForMode,
  defaultChatModeSettingKey
} from '@slayzone/terminal-contracts'
import { useTRPC } from '../trpc'

interface Option {
  value: string
  label: string
}

const STARTUP_OPTIONS: Option[] = [
  { value: 'manual', label: 'Manual' },
  { value: 'auto', label: 'Auto' },
  { value: 'instant', label: 'Instant' }
]

/**
 * A project's Agents tab: hub settings it may set for itself
 * (plans/settings-by-scope.md, phase 3). Each row shows the value that applies to
 * this project's work and where it comes from; Override copies the hub's value into
 * the project to edit it, Reset drops the project's own value. Renders inside the
 * project's hub scope.
 */
export function ProjectAgentSettings({ projectId }: { projectId: string }) {
  const { modes } = useAgents()
  const agentOptions: Option[] = getVisibleModes(modes, '').map((m) => ({
    value: m.id,
    label: getModeLabel(m)
  }))
  return (
    <div className="space-y-6" data-testid="project-agent-settings">
      <p className="text-sm text-muted-foreground">
        These start from this project's hub. Override one to use a different value for this project
        only.
      </p>
      <div className="divide-y rounded-lg border">
        <OverrideRow
          projectId={projectId}
          settingKey="default_agent_id"
          label="Default agent"
          help="Which agent new tasks in this project start with."
          options={agentOptions}
          fallback="claude-code"
        />
        <OverrideRow
          projectId={projectId}
          settingKey={AGENT_STARTUP_SETTING}
          label="Agent startup"
          help="When an agent starts after you open its task."
          options={STARTUP_OPTIONS}
          fallback="auto"
        />
        {(['claude-chat', 'codex-chat'] as const).map((mode) => (
          <OverrideRow
            key={mode}
            projectId={projectId}
            settingKey={defaultChatModeSettingKey(mode)}
            label={`Chat permission · ${mode === 'claude-chat' ? 'Claude' : 'Codex'}`}
            help="For chat tasks that have not picked a mode."
            options={chatModesForMode(mode).map((m) => ({ value: m, label: agentModeLabel(m) }))}
            fallback={defaultChatModeForMode(mode)}
          />
        ))}
      </div>
    </div>
  )
}

function OverrideRow({
  projectId,
  settingKey,
  label,
  help,
  options,
  fallback
}: {
  projectId: string
  settingKey: string
  label: string
  help: string
  options: Option[]
  /** The reader's built-in default, shown when neither project nor hub sets one. */
  fallback: string
}) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const effective = useQuery(trpc.settings.effective.queryOptions({ key: settingKey, projectId }))
  const invalidate = () =>
    Promise.all([
      queryClient.invalidateQueries(trpc.settings.effective.queryFilter()),
      queryClient.invalidateQueries(trpc.settings.overridesOfKey.queryFilter())
    ])
  const onError = (err: { message: string }) => toast.error(`Could not save: ${err.message}`)
  const set = useMutation(
    trpc.settings.setProjectOverride.mutationOptions({ onSuccess: invalidate, onError })
  )
  const clear = useMutation(
    trpc.settings.clearProjectOverride.mutationOptions({ onSuccess: invalidate, onError })
  )
  const data = effective.data
  const own = data?.source === 'project'
  const value = data?.value ?? fallback
  const labelOf = (v: string) => options.find((o) => o.value === v)?.label ?? v
  return (
    <div
      className="grid grid-cols-[minmax(0,1fr)_260px] items-center gap-6 px-4 py-3"
      data-testid={`project-override-${settingKey}`}
    >
      <div className="min-w-0 space-y-1">
        <div className="text-sm">{label}</div>
        <div className="text-xs text-muted-foreground">{help}</div>
        {data && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span
              className={cn(
                'rounded-full border px-2 leading-5',
                own ? 'border-primary/50 text-foreground' : ''
              )}
              data-testid="override-source"
            >
              {data.locked
                ? 'Locked by hub'
                : own
                  ? 'Set for this project'
                  : data.source === 'hub'
                    ? 'From hub'
                    : 'Built-in default'}
            </span>
            {data.locked ? null : own ? (
              <Button
                variant="link"
                size="sm"
                className="h-auto p-0 text-xs text-muted-foreground"
                onClick={() => clear.mutate({ projectId, key: settingKey })}
                data-testid="override-reset"
              >
                Reset to hub
              </Button>
            ) : (
              <Button
                variant="link"
                size="sm"
                className="h-auto p-0 text-xs text-muted-foreground"
                onClick={() => set.mutate({ projectId, key: settingKey, value })}
                data-testid="override-start"
              >
                Override
              </Button>
            )}
          </div>
        )}
      </div>
      <Select
        value={value}
        disabled={!own}
        onValueChange={(v) => set.mutate({ projectId, key: settingKey, value: v })}
      >
        <SelectTrigger
          className={cn('w-full', !own && 'border-dashed text-muted-foreground')}
          aria-label={label}
          data-testid="override-select"
        >
          <SelectValue>{labelOf(value)}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
