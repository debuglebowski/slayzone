import type { Dispatch, SetStateAction } from 'react'
import {
  Label,
  Button,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  taskStatusOptions
} from '@slayzone/ui'
import { Plus, Trash2 } from 'lucide-react'
import type { ConditionConfig } from '@slayzone/automations/shared'
import type { ConditionPresetType } from './automation-types'
import { CONDITION_PRESETS, PRIORITY_OPTIONS } from './automation-constants'
import { conditionToPresetKey, presetToCondition, toggleValue } from './automation-helpers'

interface ConditionSectionProps {
  conditions: ConditionConfig[]
  setConditions: Dispatch<SetStateAction<ConditionConfig[]>>
  tags: Array<{ id: string; name: string }>
}

export function ConditionSection({ conditions, setConditions, tags }: ConditionSectionProps) {
  const addCondition = () => {
    setConditions((prev: ConditionConfig[]) => [...prev, presetToCondition('status_is_some')])
  }

  const updateConditionPreset = (index: number, presetKey: ConditionPresetType) => {
    setConditions((prev: ConditionConfig[]) =>
      prev.map((c: ConditionConfig, i: number) => (i === index ? presetToCondition(presetKey) : c))
    )
  }

  const toggleConditionValue = (index: number, val: string) => {
    setConditions((prev: ConditionConfig[]) =>
      prev.map((c: ConditionConfig, i: number) => {
        if (i !== index) return c
        const current = (c.params.value as string[]) ?? []
        return { ...c, params: { ...c.params, value: toggleValue(current, val) } }
      })
    )
  }

  const removeCondition = (index: number) => {
    setConditions((prev: ConditionConfig[]) =>
      prev.filter((_: ConditionConfig, i: number) => i !== index)
    )
  }

  return (
    <div className="rounded-lg border border-border/40 bg-muted/50 p-3 space-y-4">
      <div className="flex items-center justify-between">
        <Label className="text-xs uppercase tracking-wider text-muted-foreground">
          Only if <span className="normal-case">(optional)</span>
        </Label>
        <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={addCondition}>
          <Plus className="w-3 h-3 mr-1" /> Add
        </Button>
      </div>

      {conditions.map((condition, i) => {
        const presetKey = conditionToPresetKey(condition)
        const selectedValues = (condition.params.value as string[]) ?? []

        const options =
          presetKey === 'status_is_some'
            ? taskStatusOptions.map((s) => ({ value: s.value, label: s.label }))
            : presetKey === 'priority_is_some'
              ? PRIORITY_OPTIONS
              : tags.map((t) => ({ value: t.id, label: t.name }))

        return (
          <div key={i} className="space-y-2">
            <div className="flex items-center gap-2">
              <Select
                value={presetKey}
                onValueChange={(v) => updateConditionPreset(i, v as ConditionPresetType)}
              >
                <SelectTrigger className="flex-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CONDITION_PRESETS.map((p) => (
                    <SelectItem key={p.key} value={p.key}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 w-6 p-0 shrink-0"
                onClick={() => removeCondition(i)}
              >
                <Trash2 className="w-3 h-3" />
              </Button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {options.map((o) => (
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
  )
}
