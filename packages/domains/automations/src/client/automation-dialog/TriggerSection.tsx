import type { Dispatch, SetStateAction } from 'react'
import {
  Label,
  Input,
  Checkbox,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  SelectGroup,
  SelectLabel,
  taskStatusOptions
} from '@slayzone/ui'
import type { TriggerConfig } from '@slayzone/automations/shared'
import { triggerDescription } from './automation-helpers'
import { CRON_PRESETS } from './automation-constants'

interface TriggerSectionProps {
  trigger: TriggerConfig
  setTrigger: Dispatch<SetStateAction<TriggerConfig>>
  catchupOnStart: boolean
  setCatchupOnStart: Dispatch<SetStateAction<boolean>>
}

export function TriggerSection({
  trigger,
  setTrigger,
  catchupOnStart,
  setCatchupOnStart
}: TriggerSectionProps) {
  const updateTriggerParam = (key: string, value: string) => {
    setTrigger((prev: TriggerConfig) => ({
      ...prev,
      params: { ...prev.params, [key]: value === '_any' ? undefined : value || undefined }
    }))
  }

  return (
    <div className="rounded-lg border border-border/40 bg-muted/50 p-3 space-y-4">
      <Label className="text-xs uppercase tracking-wider text-muted-foreground">When</Label>
      <div className="flex items-center gap-3">
        <Select
          value={trigger.type}
          onValueChange={(v) => setTrigger({ type: v as TriggerConfig['type'], params: {} })}
        >
          <SelectTrigger className="shrink-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="[&_[data-slot=select-group]+[data-slot=select-group]]:pt-1.5">
            <SelectGroup>
              <SelectLabel>Tasks</SelectLabel>
              <SelectItem value="task_status_change">Task status changes</SelectItem>
              <SelectItem value="task_created">Task created</SelectItem>
              <SelectItem value="task_archived">Task archived</SelectItem>
              <SelectItem value="task_tag_changed">Task tags changed</SelectItem>
            </SelectGroup>
            <SelectGroup>
              <SelectLabel>Other</SelectLabel>
              <SelectItem value="cron">Scheduled (cron)</SelectItem>
              <SelectItem value="manual">Manual trigger</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">{triggerDescription(trigger)}</p>
      </div>

      {trigger.type === 'task_status_change' && (
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label className="text-xs">From status</Label>
            <Select
              value={(trigger.params.fromStatus as string) || '_any'}
              onValueChange={(v) => updateTriggerParam('fromStatus', v)}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="_any">Any</SelectItem>
                {taskStatusOptions.map((s) => (
                  <SelectItem key={s.value} value={s.value}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">To status</Label>
            <Select
              value={(trigger.params.toStatus as string) || '_any'}
              onValueChange={(v) => updateTriggerParam('toStatus', v)}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="_any">Any</SelectItem>
                {taskStatusOptions.map((s) => (
                  <SelectItem key={s.value} value={s.value}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      )}

      {trigger.type === 'cron' && (
        <div className="space-y-2">
          <div className="space-y-1">
            <Label className="text-xs">Schedule</Label>
            <div className="flex items-center gap-2">
              <Input
                value={(trigger.params.expression as string) ?? ''}
                onChange={(e) => updateTriggerParam('expression', e.target.value)}
                placeholder="*/30 * * * *"
                className="font-mono text-xs shrink-0 w-40"
              />
              <code className="font-mono text-[11px] text-muted-foreground whitespace-nowrap">
                <span className="text-foreground/70">min</span>{' '}
                <span className="text-foreground/70">hour</span>{' '}
                <span className="text-foreground/70">day</span>{' '}
                <span className="text-foreground/70">month</span>{' '}
                <span className="text-foreground/70">weekday</span>
                &nbsp;&nbsp;—&nbsp;&nbsp;
                <span className="text-foreground/50">*</span> = every &nbsp;{' '}
                <span className="text-foreground/50">*/N</span> = every Nth
              </code>
            </div>
          </div>
          <div className="flex flex-wrap gap-1" style={{ marginTop: 12 }}>
            {CRON_PRESETS.map(([expr, label]) => (
              <button
                key={expr}
                type="button"
                onClick={() => updateTriggerParam('expression', expr)}
                className={`px-1.5 py-0 rounded text-[11px] border transition-colors ${
                  (trigger.params.expression as string) === expr
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'bg-background text-muted-foreground border-border hover:border-foreground/30'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <Label
            className="flex items-center gap-2 cursor-pointer text-xs font-normal"
            style={{ marginTop: 20 }}
            data-testid="automation-catchup-checkbox-label"
          >
            <Checkbox
              checked={catchupOnStart}
              onCheckedChange={(v) => setCatchupOnStart(v === true)}
              data-testid="automation-catchup-checkbox"
            />
            <span>Run on startup if a scheduled fire was missed</span>
          </Label>
        </div>
      )}
    </div>
  )
}
