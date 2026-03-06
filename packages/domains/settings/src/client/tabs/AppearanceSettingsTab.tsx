import { useState, useEffect } from 'react'
import { Label, Select, SelectTrigger, SelectValue, SelectContent, SelectItem, Switch } from '@slayzone/ui'
import { SettingsTabIntro } from './SettingsTabIntro'

interface AppearanceSettingsTabProps {
  preference: 'light' | 'dark' | 'system'
  setPreference: (val: 'light' | 'dark' | 'system') => void
}

export function AppearanceSettingsTab({
  preference,
  setPreference,
}: AppearanceSettingsTabProps) {
  const [projectColorTints, setProjectColorTints] = useState(true)
  const [terminalFontSize, setTerminalFontSize] = useState('13')
  const [editorFontSize, setEditorFontSize] = useState('13')
  const [reduceMotion, setReduceMotion] = useState(false)
  const [sidebarBadgeMode, setSidebarBadgeMode] = useState<'none' | 'blob' | 'count'>('blob')

  useEffect(() => {
    window.api.settings.get('project_color_tints_enabled').then(val => setProjectColorTints(val !== '0'))
    window.api.settings.get('terminal_font_size').then(val => setTerminalFontSize(val ?? '13'))
    window.api.settings.get('editor_font_size').then(val => setEditorFontSize(val ?? '13'))
    window.api.settings.get('reduce_motion').then(val => setReduceMotion(val === '1'))
    window.api.settings.get('sidebar_badge_mode').then(val => setSidebarBadgeMode((val === 'none' || val === 'count') ? val : 'blob'))
  }, [])

  return (
    <>
      <SettingsTabIntro
        title="Appearance"
        description="Control theme visuals, typography, and motion behavior. These preferences affect readability and comfort across the app."
      />
      <div className="space-y-3">
        <Label className="text-base font-semibold">Theme</Label>
        <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
          <span className="text-sm">Appearance</span>
          <Select value={preference} onValueChange={(v) => setPreference(v as 'light' | 'dark' | 'system')}>
            <SelectTrigger className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="dark">Dark</SelectItem>
              <SelectItem value="light">Light (Experimental)</SelectItem>
              <SelectItem value="system">System (Experimental)</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-3">
        <Label className="text-base font-semibold">Colors</Label>
        <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
          <span className="text-sm">Project color tints</span>
          <Switch
            checked={projectColorTints}
            onCheckedChange={(checked) => {
              setProjectColorTints(checked)
              window.api.settings.set('project_color_tints_enabled', checked ? '1' : '0')
            }}
          />
        </div>
      </div>

      <div className="space-y-3">
        <Label className="text-base font-semibold">Fonts</Label>
        {([
          { label: 'Terminal font size', value: terminalFontSize, set: setTerminalFontSize, key: 'terminal_font_size' },
          { label: 'Editor font size', value: editorFontSize, set: setEditorFontSize, key: 'editor_font_size' },
        ] as const).map(({ label, value, set, key }) => (
          <div key={key} className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
            <span className="text-sm">{label}</span>
            <Select value={value} onValueChange={(v) => { set(v); window.api.settings.set(key, v) }}>
              <SelectTrigger className="w-24">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[10, 11, 12, 13, 14, 15, 16, 18, 20].map((s) => (
                  <SelectItem key={s} value={String(s)}>{s}px</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ))}
      </div>

      <div className="space-y-3">
        <Label className="text-base font-semibold">Sidebar</Label>
        <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
          <span className="text-sm">Task attention badges</span>
          <Select value={sidebarBadgeMode} onValueChange={(v) => { setSidebarBadgeMode(v as 'none' | 'blob' | 'count'); window.api.settings.set('sidebar_badge_mode', v) }}>
            <SelectTrigger className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">None</SelectItem>
              <SelectItem value="blob">Blob</SelectItem>
              <SelectItem value="count">Count</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-3">
        <Label className="text-base font-semibold">Motion</Label>
        <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
          <span className="text-sm">Reduce motion</span>
          <Switch
            checked={reduceMotion}
            onCheckedChange={(checked) => {
              setReduceMotion(checked)
              window.api.settings.set('reduce_motion', checked ? '1' : '0')
            }}
          />
        </div>
      </div>
    </>
  )
}
