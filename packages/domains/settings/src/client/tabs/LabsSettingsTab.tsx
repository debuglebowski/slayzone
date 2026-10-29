import { useState } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import { useTRPC } from '../trpc'
import { Label, Switch } from '@slayzone/ui'
import { SettingsTabIntro } from './SettingsTabIntro'

const LABS_FEATURES = [
  {
    key: 'labs_tests_panel',
    label: 'Tests Panel',
    description: 'Show test computer panel in the home tab'
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
  // Labs flags are client-scoped (they gate native menu items built before any hub
  // exists), so they go through the app router to the desktop's client store — NOT
  // `settings.set`, which would write a hub row nothing reads.
  const setLabFlagMutation = useMutation(trpc.app.meta.setLabFlag.mutationOptions())

  // Each new flag result re-seeds its switch (which a local toggle overrides in
  // between) — adjusted while rendering.
  const [seenTestsPanel, setSeenTestsPanel] = useState<typeof testsPanelQuery.data>()
  if (testsPanelQuery.data !== seenTestsPanel) {
    setSeenTestsPanel(testsPanelQuery.data)
    if (testsPanelQuery.data !== undefined) {
      setState((prev) => ({ ...prev, labs_tests_panel: !!testsPanelQuery.data }))
    }
  }

  const [seenLoopMode, setSeenLoopMode] = useState<typeof loopModeQuery.data>()
  if (loopModeQuery.data !== seenLoopMode) {
    setSeenLoopMode(loopModeQuery.data)
    if (loopModeQuery.data !== undefined) {
      setState((prev) => ({ ...prev, labs_loop_mode: !!loopModeQuery.data }))
    }
  }

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
                await setLabFlagMutation.mutateAsync({ key: f.key, on: checked })
              }}
            />
          </div>
        ))}
      </div>
    </div>
  )
}
