import { useState, useEffect, useMemo } from 'react'
import { Label, Select, SelectTrigger, SelectValue, SelectContent, SelectItem, Switch } from '@slayzone/ui'
import { darkThemes, lightThemes } from '@slayzone/terminal/client'
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
  const [notesFontFamily, setNotesFontFamily] = useState<'sans' | 'mono'>('sans')
  const [notesLineSpacing, setNotesLineSpacing] = useState<'compact' | 'normal'>('normal')
  const [notesCheckedHighlight, setNotesCheckedHighlight] = useState(false)
  const [notesShowToolbar, setNotesShowToolbar] = useState(false)
  const [notesSpellcheck, setNotesSpellcheck] = useState(true)
  const [terminalThemeFollowApp, setTerminalThemeFollowApp] = useState(true)
  const [terminalThemeDark, setTerminalThemeDark] = useState('slay')
  const [terminalThemeLight, setTerminalThemeLight] = useState('slay-light')

  useEffect(() => {
    window.api.settings.get('project_color_tints_enabled').then(val => setProjectColorTints(val !== '0'))
    window.api.settings.get('terminal_font_size').then(val => setTerminalFontSize(val ?? '13'))
    window.api.settings.get('editor_font_size').then(val => setEditorFontSize(val ?? '13'))
    window.api.settings.get('reduce_motion').then(val => setReduceMotion(val === '1'))
    window.api.settings.get('sidebar_badge_mode').then(val => setSidebarBadgeMode((val === 'none' || val === 'count') ? val : 'blob'))
    window.api.settings.get('terminal_theme_follow_app').then(val => setTerminalThemeFollowApp(val !== '0'))
    window.api.settings.get('terminal_theme_dark').then(val => { if (val) setTerminalThemeDark(val) })
    window.api.settings.get('terminal_theme_light').then(val => { if (val) setTerminalThemeLight(val) })
    window.api.settings.get('notes_font_family').then(val => setNotesFontFamily(val === 'mono' ? 'mono' : 'sans'))
    window.api.settings.get('notes_line_spacing').then(val => setNotesLineSpacing(val === 'compact' ? 'compact' : 'normal'))
    window.api.settings.get('notes_checked_highlight').then(val => setNotesCheckedHighlight(val === '1'))
    window.api.settings.get('notes_show_toolbar').then(val => setNotesShowToolbar(val === '1'))
    window.api.settings.get('notes_spellcheck').then(val => setNotesSpellcheck(val !== '0'))
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
              <SelectItem value="light">Light (Beta)</SelectItem>
              <SelectItem value="system">System (Beta)</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-3">
        <Label className="text-base font-semibold">Terminal Theme</Label>
        <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
          <span className="text-sm">Follow application theme</span>
          <Switch
            checked={terminalThemeFollowApp}
            onCheckedChange={(checked) => {
              setTerminalThemeFollowApp(checked)
              window.api.settings.set('terminal_theme_follow_app', checked ? '1' : '0')
            }}
          />
        </div>
        {terminalThemeFollowApp ? (
          <>
            <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
              <span className="text-sm">Dark theme</span>
              <div className="flex items-center gap-2">
                <Select value={terminalThemeDark} onValueChange={(v) => { setTerminalThemeDark(v); window.api.settings.set('terminal_theme_dark', v) }}>
                  <SelectTrigger className="w-48">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {darkThemes.map(t => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
                  </SelectContent>
                </Select>
                <TerminalThemePreview themeId={terminalThemeDark} />
              </div>
            </div>
            <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
              <span className="text-sm">Light theme</span>
              <div className="flex items-center gap-2">
                <Select value={terminalThemeLight} onValueChange={(v) => { setTerminalThemeLight(v); window.api.settings.set('terminal_theme_light', v) }}>
                  <SelectTrigger className="w-48">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {lightThemes.map(t => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
                  </SelectContent>
                </Select>
                <TerminalThemePreview themeId={terminalThemeLight} />
              </div>
            </div>
          </>
        ) : (
          <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
            <span className="text-sm">Theme</span>
            <div className="flex items-center gap-2">
              <Select value={terminalThemeDark} onValueChange={(v) => { setTerminalThemeDark(v); window.api.settings.set('terminal_theme_dark', v) }}>
                <SelectTrigger className="w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {darkThemes.map(t => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
                  {lightThemes.map(t => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
                </SelectContent>
              </Select>
              <TerminalThemePreview themeId={terminalThemeDark} />
            </div>
          </div>
        )}
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
        <Label className="text-base font-semibold">Notes editor</Label>
        <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
          <span className="text-sm">Font family</span>
          <Select value={notesFontFamily} onValueChange={(v) => { setNotesFontFamily(v as 'sans' | 'mono'); window.api.settings.set('notes_font_family', v) }}>
            <SelectTrigger className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="sans">Sans-serif</SelectItem>
              <SelectItem value="mono">Monospace</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
          <span className="text-sm">Line spacing</span>
          <Select value={notesLineSpacing} onValueChange={(v) => { setNotesLineSpacing(v as 'compact' | 'normal'); window.api.settings.set('notes_line_spacing', v) }}>
            <SelectTrigger className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="normal">Normal</SelectItem>
              <SelectItem value="compact">Compact</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
          <span className="text-sm">Highlight checked items</span>
          <Switch
            checked={notesCheckedHighlight}
            onCheckedChange={(checked) => {
              setNotesCheckedHighlight(checked)
              window.api.settings.set('notes_checked_highlight', checked ? '1' : '0')
            }}
          />
        </div>
        <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
          <span className="text-sm">Show formatting toolbar</span>
          <Switch
            checked={notesShowToolbar}
            onCheckedChange={(checked) => {
              setNotesShowToolbar(checked)
              window.api.settings.set('notes_show_toolbar', checked ? '1' : '0')
            }}
          />
        </div>
        <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
          <span className="text-sm">Spellcheck</span>
          <Switch
            checked={notesSpellcheck}
            onCheckedChange={(checked) => {
              setNotesSpellcheck(checked)
              window.api.settings.set('notes_spellcheck', checked ? '1' : '0')
            }}
          />
        </div>
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

function TerminalThemePreview({ themeId }: { themeId: string }) {
  const theme = useMemo(() => [...darkThemes, ...lightThemes].find(t => t.id === themeId), [themeId])
  if (!theme) return null
  const c = theme.colors
  const colors = [c.red, c.green, c.yellow, c.blue, c.magenta, c.cyan]
  return (
    <div
      className="flex items-center gap-px rounded px-1.5 py-1 border"
      style={{ backgroundColor: c.background ?? '#000' }}
    >
      {colors.map((color, i) => (
        <div key={i} className="size-2.5 rounded-full" style={{ backgroundColor: color ?? '#888' }} />
      ))}
    </div>
  )
}
