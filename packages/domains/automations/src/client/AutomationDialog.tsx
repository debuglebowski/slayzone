import { useState, useEffect } from 'react'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
  Button, Input, Label, Textarea,
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem, SelectGroup, SelectLabel,
  taskStatusOptions,
} from '@slayzone/ui'
import { Plus, Trash2 } from 'lucide-react'
import type { Automation, TriggerConfig, ConditionConfig, ActionConfig, CreateAutomationInput, UpdateAutomationInput } from '@slayzone/automations/shared'

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

export function AutomationDialog({ open, onOpenChange, automation, projectId, tags, onSave }: AutomationDialogProps) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [trigger, setTrigger] = useState<TriggerConfig>(EMPTY_TRIGGER)
  const [conditions, setConditions] = useState<ConditionConfig[]>([])
  const [actions, setActions] = useState<ActionConfig[]>([{ type: 'run_command', params: { command: '' } }])
  const [showAllVars, setShowAllVars] = useState(false)

  useEffect(() => {
    if (automation) {
      setName(automation.name)
      setDescription(automation.description ?? '')
      setTrigger(automation.trigger_config)
      setConditions(automation.conditions)
      setActions(automation.actions.length > 0 ? automation.actions : [{ type: 'run_command', params: { command: '' } }])
    } else {
      setName('')
      setDescription('')
      setTrigger({ ...EMPTY_TRIGGER })
      setConditions([])
      setActions([{ type: 'run_command', params: { command: '' } }])
    }
  }, [automation, open])

  const handleSave = () => {
    if (!name.trim()) return
    const validActions = actions.filter((a: ActionConfig) => (a.params.command as string)?.trim())
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
              <div className="space-y-1">
                <Label className="text-xs">Cron expression</Label>
                <Input
                  value={(trigger.params.expression as string) ?? ''}
                  onChange={(e) => updateTriggerParam('expression', e.target.value)}
                  placeholder="*/30 * * * * (every 30 min)"
                  className="font-mono text-xs"
                />
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
              <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => setActions((prev: ActionConfig[]) => [...prev, { type: 'run_command' as const, params: { command: '' } }])}>
                <Plus className="w-3 h-3 mr-1" /> Add
              </Button>
            </div>

            {actions.map((action, i) => (
              <div key={i} className="flex items-center gap-2">
                <Textarea
                  value={(action.params.command as string) ?? ''}
                  onChange={(e) => setActions((prev: ActionConfig[]) => prev.map((a: ActionConfig, j: number) => j === i ? { ...a, params: { ...a.params, command: e.target.value } } : a))}
                  placeholder="echo {{task.name}}"
                  className="font-mono text-xs flex-1 min-h-[60px] resize-y"
                />
                {actions.length > 1 && (
                  <Button variant="ghost" size="sm" className="h-6 w-6 p-0 shrink-0" onClick={() => setActions((prev: ActionConfig[]) => prev.filter((_: ActionConfig, j: number) => j !== i))}>
                    <Trash2 className="w-3 h-3" />
                  </Button>
                )}
              </div>
            ))}

            <table className="w-full text-xs mt-2 border-collapse border border-border/40 rounded">
              <thead>
                <tr className="text-muted-foreground text-left bg-muted/30">
                  <th className="px-2 py-1.5 font-medium border border-border/40">Variable</th>
                  <th className="px-2 py-1.5 font-medium border border-border/40">Description</th>
                </tr>
              </thead>
              <tbody className="text-muted-foreground">
                <tr><td className="px-2 py-1 font-mono text-foreground/70 border border-border/40">{'{{task.id}}'}</td><td className="px-2 py-1 border border-border/40">Task ID</td></tr>
                <tr><td className="px-2 py-1 font-mono text-foreground/70 border border-border/40">{'{{task.name}}'}</td><td className="px-2 py-1 border border-border/40">Task title</td></tr>
                {showAllVars && (<>
                  <tr><td className="px-2 py-1 font-mono text-foreground/70 border border-border/40">{'{{task.status}}'}</td><td className="px-2 py-1 border border-border/40">Current status</td></tr>
                  <tr><td className="px-2 py-1 font-mono text-foreground/70 border border-border/40">{'{{task.priority}}'}</td><td className="px-2 py-1 border border-border/40">Priority (1-5)</td></tr>
                  <tr><td className="px-2 py-1 font-mono text-foreground/70 border border-border/40">{'{{task.worktree_path}}'}</td><td className="px-2 py-1 border border-border/40">Worktree path</td></tr>
                  <tr><td className="px-2 py-1 font-mono text-foreground/70 border border-border/40">{'{{task.branch}}'}</td><td className="px-2 py-1 border border-border/40">Branch name</td></tr>
                  <tr><td className="px-2 py-1 font-mono text-foreground/70 border border-border/40">{'{{task.terminal_mode}}'}</td><td className="px-2 py-1 border border-border/40">Terminal mode (claude-code, codex, etc.)</td></tr>
                  <tr><td className="px-2 py-1 font-mono text-foreground/70 border border-border/40">{'{{task.terminal_mode_flags}}'}</td><td className="px-2 py-1 border border-border/40">Terminal mode flags</td></tr>
                  <tr><td className="px-2 py-1 font-mono text-foreground/70 border border-border/40">{'{{project.name}}'}</td><td className="px-2 py-1 border border-border/40">Project name</td></tr>
                  <tr><td className="px-2 py-1 font-mono text-foreground/70 border border-border/40">{'{{project.path}}'}</td><td className="px-2 py-1 border border-border/40">Project directory path</td></tr>
                  <tr><td className="px-2 py-1 font-mono text-foreground/70 border border-border/40">{'{{trigger.old_status}}'}</td><td className="px-2 py-1 border border-border/40">Previous status (status change only)</td></tr>
                  <tr><td className="px-2 py-1 font-mono text-foreground/70 border border-border/40">{'{{trigger.new_status}}'}</td><td className="px-2 py-1 border border-border/40">New status (status change only)</td></tr>
                </>)}
              </tbody>
            </table>
            <button type="button" onClick={() => setShowAllVars(v => !v)} className="text-xs text-muted-foreground hover:text-foreground w-full text-center">
              {showAllVars ? 'Show less' : `Show all (${12} variables)`}
            </button>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={!name.trim() || actions.every((a: ActionConfig) => !(a.params.command as string)?.trim())}>
            {automation ? 'Save' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
