import { useState, useEffect } from 'react'
import { Label, Switch } from '@slayzone/ui'
import { SettingsTabIntro } from './SettingsTabIntro'

const LABS_FEATURES = [
  { key: 'labs_context_manager', label: 'Context Manager', description: 'Manage global and per-project instructions, skills, and MCP servers', loader: () => window.api.app.isContextManagerEnabled() },
  { key: 'labs_integrations', label: 'Integrations', description: 'Sync tasks with GitHub Issues and Linear', loader: () => window.api.app.isIntegrationsEnabled() },
  { key: 'labs_tests_panel', label: 'Tests Panel', description: 'Show test runner panel in the home tab', loader: () => window.api.app.isTestsPanelEnabled() },
] as const

export function LabsSettingsTab() {
  const [state, setState] = useState<Record<string, boolean>>({})

  useEffect(() => {
    for (const f of LABS_FEATURES) {
      f.loader().then(v => setState(prev => ({ ...prev, [f.key]: v })))
    }
  }, [])

  return (
    <div className="space-y-6">
      <SettingsTabIntro
        title="Labs"
        description="Try in-progress features before they are fully released. Expect behavior and UI details to evolve over time."
      />
      <div className="space-y-3">
        <Label className="text-base font-semibold">Experimental Features</Label>
        <p className="text-sm text-muted-foreground">These features are in development and may change.</p>
      </div>
      <div className="rounded-lg border p-4 space-y-4">
        {LABS_FEATURES.map(f => (
          <div key={f.key} className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor={f.key}>{f.label}</Label>
              <p className="text-xs text-muted-foreground">{f.description}</p>
            </div>
            <Switch
              id={f.key}
              checked={state[f.key] ?? false}
              onCheckedChange={async (checked) => {
                setState(prev => ({ ...prev, [f.key]: checked }))
                await window.api.settings.set(f.key, checked ? '1' : '0')
              }}
            />
          </div>
        ))}
      </div>
    </div>
  )
}
