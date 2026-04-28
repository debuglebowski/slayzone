import { useState, useEffect } from 'react'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
  Button, Input, Label, Textarea,
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem, SelectGroup, SelectLabel,
  taskStatusOptions,
} from '@slayzone/ui'
import { Plus, Trash2, Sparkles, Terminal } from 'lucide-react'
import { TEMPLATE_VARIABLES, getHeadlessPattern, type Automation, type TriggerConfig, type ConditionConfig, type ActionConfig, type ActionType, type CreateAutomationInput, type UpdateAutomationInput } from '@slayzone/automations/shared'

interface AiProviderOption {
  id: string
  label: string
  type: string
  defaultFlags: string
}

interface AutomationDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  automation?: Automation | null
  projectId: string
  tags: Array<{ id: string; name: string }>
  onSave: (data: CreateAutomationInput | UpdateAutomationInput) => void
}

function triggerDescription(trigger: TriggerConfig): string {
  switch (trigger.type) {
    case 'task_status_change': {
      const from = trigger.params.fromStatus as string | undefined
      const to = trigger.params.toStatus as string | undefined
      if (from && to) return `Runs when a task moves from "${from}" to "${to}"`
      if (to) return `Runs when a task moves to "${to}"`
      if (from) return `Runs when a task leaves "${from}"`
      return 'Runs whenever a task changes status'
    }
    case 'task_created': return 'Runs when a new task is created in this project'
    case 'task_archived': return 'Runs when a task is archived'
    case 'task_tag_changed': return 'Runs when tags are added or removed from a task'
    case 'cron': {
      const expr = trigger.params.expression as string | undefined
      return expr ? `Runs on schedule: ${expr}` : 'Runs on a recurring schedule'
    }
    case 'manual': return 'Runs only when you click the play button'
    default: return ''
  }
}

// --- Condition presets ---

type ConditionPresetType = 'status_is_some' | 'priority_is_some' | 'tags_contains_some'

interface ConditionPreset {
  key: ConditionPresetType
  label: string
}

const CONDITION_PRESETS: ConditionPreset[] = [
  { key: 'status_is_some', label: 'Task status is any of...' },
  { key: 'priority_is_some', label: 'Task priority is any of...' },
  { key: 'tags_contains_some', label: 'Task tags contains any of...' },
]

const PRIORITY_OPTIONS = [
  { value: '1', label: 'Urgent' },
  { value: '2', label: 'High' },
  { value: '3', label: 'Medium' },
  { value: '4', label: 'Low' },
  { value: '5', label: 'None' },
]

function conditionToPresetKey(c: ConditionConfig): ConditionPresetType {
  const field = c.params.field as string
  if (field === 'status') return 'status_is_some'
  if (field === 'priority') return 'priority_is_some'
  if (field === 'tags') return 'tags_contains_some'
  return 'status_is_some'
}

function presetToCondition(key: ConditionPresetType): ConditionConfig {
  switch (key) {
    case 'status_is_some': return { type: 'task_property', params: { field: 'status', operator: 'in', value: [] } }
    case 'priority_is_some': return { type: 'task_property', params: { field: 'priority', operator: 'in', value: [] } }
    case 'tags_contains_some': return { type: 'task_property', params: { field: 'tags', operator: 'in', value: [] } }
  }
}

// Multi-select toggle helper
function toggleValue(arr: string[], val: string): string[] {
  return arr.includes(val) ? arr.filter(v => v !== val) : [...arr, val]
}

const EMPTY_TRIGGER: TriggerConfig = { type: 'task_status_change', params: {} }
const EMPTY_RUN_COMMAND: ActionConfig = { type: 'run_command', params: { command: '' } }

function newAiAction(provider: AiProviderOption | undefined): ActionConfig {
  return {
    type: 'ai',
    params: {
      provider: provider?.id ?? '',
      prompt: '',
      flags: provider?.defaultFlags ?? '',
    },
  }
}

export function AutomationDialog({ open, onOpenChange, automation, projectId, tags, onSave }: AutomationDialogProps) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [trigger, setTrigger] = useState<TriggerConfig>(EMPTY_TRIGGER)
  const [conditions, setConditions] = useState<ConditionConfig[]>([])
  const [actions, setActions] = useState<ActionConfig[]>([{ ...EMPTY_RUN_COMMAND }])
  const [showAllVars, setShowAllVars] = useState(false)
  const [providers, setProviders] = useState<AiProviderOption[]>([])
  const [providersLoaded, setProvidersLoaded] = useState(false)

  useEffect(() => {
    if (!open) return
    setProvidersLoaded(false)
    window.api.terminalModes.list().then((modes: { id: string; label: string; type: string; enabled: boolean; defaultFlags?: string | null }[]) => {
      setProviders(
        modes
          .filter(m => m.enabled && getHeadlessPattern(m.type))
          .map(m => ({ id: m.id, label: m.label, type: m.type, defaultFlags: m.defaultFlags ?? '' }))
      )
      setProvidersLoaded(true)
    }).catch(() => {
      setProviders([])
      setProvidersLoaded(true)
    })
  }, [open])

  // Validity is provider-aware: an AI action with a stale/disabled provider id
  // fails validation so the Save button disables and the engine never runs it.
  // While providers haven't loaded yet, skip the existence check to avoid
  // flickering Save disabled when editing an existing automation.
  const actionIsValid = (action: ActionConfig): boolean => {
    if (action.type === 'ai') {
      const providerId = (action.params.provider as string)?.trim()
      if (!providerId) return false
      if (!(action.params.prompt as string)?.trim()) return false
      if (providersLoaded && !providers.some(p => p.id === providerId)) return false
      // Mirror the engine's shell-injection guard so Save disables locally.
      if (((action.params.flags as string) ?? '').includes('{{')) return false
      return true
    }
    return !!(action.params.command as string)?.trim()
  }

  useEffect(() => {
    if (automation) {
      setName(automation.name)
      setDescription(automation.description ?? '')
      setTrigger(automation.trigger_config)
      setConditions(automation.conditions)
      setActions(automation.actions.length > 0 ? automation.actions : [{ ...EMPTY_RUN_COMMAND }])
    } else {
      setName('')
      setDescription('')
      setTrigger({ ...EMPTY_TRIGGER })
      setConditions([])
      setActions([{ ...EMPTY_RUN_COMMAND }])
    }
  }, [automation, open])

  const handleSave = () => {
    if (!name.trim()) return
    const validActions = actions.filter(actionIsValid)
    if (validActions.length === 0) return

    if (automation) {
      onSave({
        id: automation.id,
        name: name.trim(),
        description: description.trim() || undefined,
        trigger_config: trigger,
        conditions,
        actions: validActions,
      } satisfies UpdateAutomationInput)
    } else {
      onSave({
        project_id: projectId,
        name: name.trim(),
        description: description.trim() || undefined,
        trigger_config: trigger,
        conditions,
        actions: validActions,
      } satisfies CreateAutomationInput)
    }
    onOpenChange(false)
  }

  const updateTriggerParam = (key: string, value: string) => {
    setTrigger((prev: TriggerConfig) => ({ ...prev, params: { ...prev.params, [key]: value === '_any' ? undefined : value || undefined } }))
  }

  const addCondition = () => {
    setConditions((prev: ConditionConfig[]) => [...prev, presetToCondition('status_is_some')])
  }

  const updateConditionPreset = (index: number, presetKey: ConditionPresetType) => {
    setConditions((prev: ConditionConfig[]) => prev.map((c: ConditionConfig, i: number) => i === index ? presetToCondition(presetKey) : c))
  }

  const toggleConditionValue = (index: number, val: string) => {
    setConditions((prev: ConditionConfig[]) => prev.map((c: ConditionConfig, i: number) => {
      if (i !== index) return c
      const current = (c.params.value as string[]) ?? []
      return { ...c, params: { ...c.params, value: toggleValue(current, val) } }
    }))
  }

  const removeCondition = (index: number) => {
    setConditions((prev: ConditionConfig[]) => prev.filter((_: ConditionConfig, i: number) => i !== index))
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent style={{ maxWidth: 672 }}>
        <DialogHeader>
          <DialogTitle>{automation ? 'Edit Automation' : 'New Automation'}</DialogTitle>
        </DialogHeader>

        <div className="space-y-5 max-h-[60vh] overflow-y-auto pr-1">
          {/* Name */}
          <div className="space-y-1.5">
            <Label>Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Auto-cleanup worktrees" />
          </div>

          {/* Description */}
          <div className="space-y-1.5">
            <Label>Description <span className="text-muted-foreground text-xs">(optional)</span></Label>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What does this automation do?" />
          </div>

          {/* WHEN */}
          <div className="rounded-lg border border-border/40 bg-muted/50 p-3 space-y-4">
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">When</Label>
            <div className="flex items-center gap-3">
            <Select value={trigger.type} onValueChange={(v) => setTrigger({ type: v as TriggerConfig['type'], params: {} })}>
              <SelectTrigger className="shrink-0"><SelectValue /></SelectTrigger>
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
                  <Select value={(trigger.params.fromStatus as string) || '_any'} onValueChange={(v) => updateTriggerParam('fromStatus', v)}>
                    <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="_any">Any</SelectItem>
                      {taskStatusOptions.map(s => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">To status</Label>
                  <Select value={(trigger.params.toStatus as string) || '_any'} onValueChange={(v) => updateTriggerParam('toStatus', v)}>
                    <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="_any">Any</SelectItem>
                      {taskStatusOptions.map(s => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}
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
                      <span className="text-foreground/70">min</span> <span className="text-foreground/70">hour</span> <span className="text-foreground/70">day</span> <span className="text-foreground/70">month</span> <span className="text-foreground/70">weekday</span>
                      &nbsp;&nbsp;—&nbsp;&nbsp;
                      <span className="text-foreground/50">*</span> = every &nbsp; <span className="text-foreground/50">*/N</span> = every Nth
                    </code>
                  </div>
                </div>
                <div className="flex flex-wrap gap-1" style={{ marginTop: 12 }}>
                  {([
                    ['*/15 * * * *', 'Every 15 min'],
                    ['0 * * * *', 'Every hour'],
                    ['0 9 * * *', 'Daily at 9am'],
                    ['0 9 * * 1-5', 'Weekdays at 9am'],
                    ['0 0 * * 0', 'Weekly (Sun midnight)'],
                  ] as const).map(([expr, label]) => (
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
              </div>
            )}
          </div>

          {/* ONLY IF */}
          <div className="rounded-lg border border-border/40 bg-muted/50 p-3 space-y-4">
            <div className="flex items-center justify-between">
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">Only if <span className="normal-case">(optional)</span></Label>
              <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={addCondition}>
                <Plus className="w-3 h-3 mr-1" /> Add
              </Button>
            </div>

            {conditions.map((condition, i) => {
              const presetKey = conditionToPresetKey(condition)
              const selectedValues = (condition.params.value as string[]) ?? []

              const options = presetKey === 'status_is_some'
                ? taskStatusOptions.map(s => ({ value: s.value, label: s.label }))
                : presetKey === 'priority_is_some'
                  ? PRIORITY_OPTIONS
                  : tags.map(t => ({ value: t.id, label: t.name }))

              return (
                <div key={i} className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Select value={presetKey} onValueChange={(v) => updateConditionPreset(i, v as ConditionPresetType)}>
                      <SelectTrigger className="flex-1"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {CONDITION_PRESETS.map(p => <SelectItem key={p.key} value={p.key}>{p.label}</SelectItem>)}
                      </SelectContent>
                    </Select>
                    <Button variant="ghost" size="sm" className="h-6 w-6 p-0 shrink-0" onClick={() => removeCondition(i)}>
                      <Trash2 className="w-3 h-3" />
                    </Button>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {options.map(o => (
                      <button
                        key={o.value}
                        type="button"
                        onClick={() => toggleConditionValue(i, o.value)}
                        className={`px-2 py-0.5 rounded-md text-xs border transition-colors ${
                          selectedValues.includes(o.value)
                            ? 'bg-primary text-primary-foreground border-primary'
                            : 'bg-background text-muted-foreground border-border hover:border-foreground/30'
                        }`}
                      >
                        {o.label}
                      </button>
                    ))}
                  </div>
                </div>
              )
            })}

            {conditions.length >= 2 && (
              <p className="text-xs text-muted-foreground mt-8">
                All conditions must be met for the automation to run.
              </p>
            )}
          </div>

          {/* THEN */}
          <div className="rounded-lg border border-border/40 bg-muted/50 p-3 space-y-4">
            <div className="flex items-center justify-between">
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">Then</Label>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 text-xs"
                  onClick={() => setActions((prev: ActionConfig[]) => [...prev, { ...EMPTY_RUN_COMMAND }])}
                >
                  <Terminal className="w-3 h-3 mr-1" /> Command
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 text-xs"
                  disabled={providers.length === 0}
                  onClick={() => setActions((prev: ActionConfig[]) => [...prev, newAiAction(providers[0])])}
                >
                  <Sparkles className="w-3 h-3 mr-1" /> AI
                </Button>
              </div>
            </div>

            {actions.map((action, i) => {
              const updateParam = (key: string, value: string) =>
                setActions((prev: ActionConfig[]) => prev.map((a: ActionConfig, j: number) => j === i ? { ...a, params: { ...a.params, [key]: value } } : a))
              const changeType = (newType: ActionType) =>
                setActions((prev: ActionConfig[]) => prev.map((a: ActionConfig, j: number) => {
                  if (j !== i) return a
                  if (newType === a.type) return a
                  return newType === 'ai' ? newAiAction(providers[0]) : { ...EMPTY_RUN_COMMAND }
                }))

              const storedProviderId = action.type === 'ai' ? ((action.params.provider as string) ?? '') : ''
              const providerMissing = action.type === 'ai'
                && providersLoaded
                && !!storedProviderId
                && !providers.some(p => p.id === storedProviderId)
              const flagsHasTemplate = action.type === 'ai' && ((action.params.flags as string) ?? '').includes('{{')

              return (
                <div key={i} className="rounded-md border border-border/40 bg-background/40 p-2 space-y-2">
                  <div className="flex items-center gap-2">
                    <Select value={action.type} onValueChange={(v) => changeType(v as ActionType)}>
                      <SelectTrigger size="sm" className="w-32 shrink-0"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="run_command">Run command</SelectItem>
                        <SelectItem value="ai" disabled={providers.length === 0}>Run AI</SelectItem>
                      </SelectContent>
                    </Select>
                    {action.type === 'ai' && (
                      <Select
                        value={storedProviderId}
                        onValueChange={(v) => updateParam('provider', v)}
                      >
                        <SelectTrigger size="sm" className="flex-1"><SelectValue placeholder="Pick provider" /></SelectTrigger>
                        <SelectContent>
                          {providers.map(p => <SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    )}
                    <div className="flex-1" />
                    {actions.length > 1 && (
                      <Button variant="ghost" size="sm" className="h-6 w-6 p-0 shrink-0" onClick={() => setActions((prev: ActionConfig[]) => prev.filter((_: ActionConfig, j: number) => j !== i))}>
                        <Trash2 className="w-3 h-3" />
                      </Button>
                    )}
                  </div>

                  {providerMissing && (
                    <p className="text-[11px] text-destructive">
                      Provider "{storedProviderId}" is unavailable — pick another above.
                    </p>
                  )}

                  {action.type === 'run_command' ? (
                    <Textarea
                      value={(action.params.command as string) ?? ''}
                      onChange={(e) => updateParam('command', e.target.value)}
                      placeholder="echo {{task.name}}"
                      className="font-mono text-xs w-full min-h-[60px] resize-y"
                    />
                  ) : (
                    <>
                      <Textarea
                        value={(action.params.prompt as string) ?? ''}
                        onChange={(e) => updateParam('prompt', e.target.value)}
                        placeholder="Summarize {{task.name}} and post to PR"
                        className="font-mono text-xs w-full min-h-[60px] resize-y"
                      />
                      <Input
                        value={(action.params.flags as string) ?? ''}
                        onChange={(e) => updateParam('flags', e.target.value)}
                        placeholder="provider flags (clear to run with no flags)"
                        className="font-mono text-[11px] h-7"
                      />
                      {flagsHasTemplate && (
                        <p className="text-[11px] text-destructive">
                          Template variables are not allowed in flags — put them in the prompt above.
                        </p>
                      )}
                    </>
                  )}
                </div>
              )
            })}

            <table className="w-full text-xs mt-2 border-collapse border border-border/40 rounded">
              <thead>
                <tr className="text-muted-foreground text-left bg-muted/30">
                  <th className="px-2 py-1.5 font-medium border border-border/40">Variable</th>
                  <th className="px-2 py-1.5 font-medium border border-border/40">Description</th>
                </tr>
              </thead>
              <tbody className="text-muted-foreground">
                {(showAllVars ? TEMPLATE_VARIABLES : TEMPLATE_VARIABLES.slice(0, 2)).map(v => (
                  <tr key={v.name}>
                    <td className="px-2 py-1 font-mono text-foreground/70 border border-border/40">{`{{${v.name}}}`}</td>
                    <td className="px-2 py-1 border border-border/40">{v.desc}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button type="button" onClick={() => setShowAllVars(v => !v)} className="text-xs text-muted-foreground hover:text-foreground w-full text-center">
              {showAllVars ? 'Show less' : `Show all (${TEMPLATE_VARIABLES.length} variables)`}
            </button>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={!name.trim() || !actions.some(actionIsValid)}>
            {automation ? 'Save' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
