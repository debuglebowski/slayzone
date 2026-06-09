import { useState, useEffect } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import { useTRPC } from '@slayzone/transport/client'
import { Label, Switch } from '@slayzone/ui'
import { SettingsTabIntro } from './SettingsTabIntro'

const LABS_FEATURES = [
  {
    key: 'labs_tests_panel',
    label: 'Tests Panel',
    description: 'Show test runner panel in the home tab'
  },
  {
    key: 'labs_loop_mode',
    label: 'Loop Command',
    description: 'Repeat a prompt until acceptance criteria are met'
  }
] as const

export function LabsSettingsTab() {
  const trpc = useTRPC()
  const [state, setState] = useState<Record<string, boolean>>({})

  const testsPanelQuery = useQuery(trpc.app.meta.isTestsPanelEnabled.queryOptions())
  const loopModeQuery = useQuery(trpc.app.meta.isLoopModeEnabled.queryOptions())
  const setSettingMutation = useMutation(trpc.settings.set.mutationOptions())

  useEffect(() => {
    if (testsPanelQuery.data !== undefined) {
      setState((prev) => ({ ...prev, labs_tests_panel: !!testsPanelQuery.data }))
    }
  }, [testsPanelQuery.data])

  useEffect(() => {
    if (loopModeQuery.data !== undefined) {
      setState((prev) => ({ ...prev, labs_loop_mode: !!loopModeQuery.data }))
    }
  }, [loopModeQuery.data])

  return (
    <div className="space-y-6">
      <SettingsTabIntro
        title="Labs"
        description="Try in-progress features before they are fully released. Expect behavior and UI details to evolve over time."
      />
      <div className="space-y-6">
        {LABS_FEATURES.map((f) => (
          <div key={f.key} className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor={f.key}>{f.label}</Label>
              <p className="text-xs text-muted-foreground">{f.description}</p>
            </div>
            <Switch
              id={f.key}
              checked={state[f.key] ?? false}
              onCheckedChange={async (checked) => {
                setState((prev) => ({ ...prev, [f.key]: checked }))
                await setSettingMutation.mutateAsync({ key: f.key, value: checked ? '1' : '0' })
              }}
            />
          </div>
        ))}
      </div>
    </div>
  )
}
