import { useState, useEffect } from 'react'
import { Label, Switch } from '@slayzone/ui'
import { SettingsTabIntro } from './SettingsTabIntro'

const LABS_FEATURES = [
  { key: 'labs_context_manager', label: 'Context Manager', description: 'Manage computer, library, and project-level instructions, skills, and MCP servers', loader: () => window.api.app.isContextManagerEnabled() },
  { key: 'labs_tests_panel', label: 'Tests Panel', description: 'Show test runner panel in the home tab', loader: () => window.api.app.isTestsPanelEnabled() },
  { key: 'labs_jira_integration', label: 'Jira Integration', description: 'Sync tasks with Jira Cloud issues', loader: () => window.api.app.isJiraIntegrationEnabled() },
  { key: 'labs_loop_mode', label: 'Loop Command', description: 'Repeat a prompt until acceptance criteria are met', loader: () => window.api.app.isLoopModeEnabled() },
  { key: 'labs_automations', label: 'Automations', description: 'Trigger → condition → action rules that run automatically per project', loader: () => window.api.app.isAutomationsEnabled() },
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
      <div className="space-y-6">
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
