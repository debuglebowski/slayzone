import { useState, useEffect, useMemo } from 'react'
import { Info } from 'lucide-react'
import { Card, CardHeader, CardTitle, CardContent, Select, SelectTrigger, SelectValue, SelectContent, SelectItem, Switch, Tooltip, TooltipTrigger, TooltipContent, unifiedThemes, getThemeVariant } from '@slayzone/ui'
import { useTheme } from '../ThemeContext'
import { SettingsTabIntro } from './SettingsTabIntro'

function SettingLabel({ children, tip }: { children: React.ReactNode; tip: string }) {
  return (
    <span className="text-sm flex items-center gap-1.5">
      {children}
      <Tooltip>
        <TooltipTrigger asChild>
          <Info className="size-3 text-muted-foreground/50 hover:text-muted-foreground shrink-0 cursor-default" />
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs leading-relaxed">
          {tip}
        </TooltipContent>
      </Tooltip>
    </span>
  )
}

function ThemeSelect({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  return (
    <div className="flex items-center gap-2">
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="w-48">
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper" side="bottom" className="max-h-none">
          {unifiedThemes.map(t => (
            <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <ThemePreview themeId={value} />
    </div>
  )
}

export function AppearanceSettingsTab() {
  const {
    preference, setPreference,
    themeId, setThemeId,
    splitThemes, setSplitThemes,
    themeIdDark, setThemeIdDark,
    themeIdLight, setThemeIdLight,
    terminalOverrideThemeId, setTerminalOverrideThemeId,
    editorOverrideThemeId, setEditorOverrideThemeId,
  } = useTheme()

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

  useEffect(() => {
    window.api.settings.get('project_color_tints_enabled').then(val => setProjectColorTints(val !== '0'))
    window.api.settings.get('terminal_font_size').then(val => setTerminalFontSize(val ?? '13'))
    window.api.settings.get('editor_font_size').then(val => setEditorFontSize(val ?? '13'))
    window.api.settings.get('reduce_motion').then(val => setReduceMotion(val === '1'))
    window.api.settings.get('sidebar_badge_mode').then(val => setSidebarBadgeMode((val === 'none' || val === 'count') ? val : 'blob'))
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
        description="Control theme visuals, typography, and motion behavior."
      />

      {/* Application */}
      <Card>
        <CardHeader>
          <CardTitle>Application</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
            <SettingLabel tip="Choose between dark, light, or system-matched color scheme">Mode</SettingLabel>
            <Select value={preference} onValueChange={(v) => setPreference(v as 'light' | 'dark' | 'system')}>
              <SelectTrigger className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" side="bottom" className="max-h-none">
                <SelectItem value="dark">Dark</SelectItem>
                <SelectItem value="light">Light (Beta)</SelectItem>
                <SelectItem value="system">System (Beta)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {!splitThemes && (
            <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
              <SettingLabel tip="Color theme for the entire app — terminal, editor, and chrome">Color theme</SettingLabel>
              <ThemeSelect value={themeId} onChange={setThemeId} />
            </div>
          )}
          <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
            <SettingLabel tip="Choose different themes for dark and light mode">Separate dark/light themes</SettingLabel>
            <Switch checked={splitThemes} onCheckedChange={setSplitThemes} />
          </div>
          {splitThemes && (
            <>
              <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
                <SettingLabel tip="Theme used when in dark mode">Dark theme</SettingLabel>
                <ThemeSelect value={themeIdDark} onChange={setThemeIdDark} />
              </div>
              <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
                <SettingLabel tip="Theme used when in light mode">Light theme</SettingLabel>
                <ThemeSelect value={themeIdLight} onChange={setThemeIdLight} />
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Terminal */}
      <Card>
        <CardHeader>
          <CardTitle>Terminal</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
            <SettingLabel tip="Text size in terminal panels">Font size</SettingLabel>
            <Select value={terminalFontSize} onValueChange={(v) => { setTerminalFontSize(v); window.api.settings.set('terminal_font_size', v) }}>
              <SelectTrigger className="w-24">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" side="bottom" className="max-h-none">
                {[10, 11, 12, 13, 14, 15, 16, 18, 20].map((s) => (
                  <SelectItem key={s} value={String(s)}>{s}px</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
            <SettingLabel tip="Color theme for terminal panels — defaults to the application theme">Terminal theme</SettingLabel>
            <OverrideThemeSelect value={terminalOverrideThemeId} onChange={setTerminalOverrideThemeId} />
          </div>
        </CardContent>
      </Card>

      {/* Editor */}
      <Card>
        <CardHeader>
          <CardTitle>Editor & Assets</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
            <SettingLabel tip="Text size in the code and notes editor">Font size</SettingLabel>
            <Select value={editorFontSize} onValueChange={(v) => { setEditorFontSize(v); window.api.settings.set('editor_font_size', v) }}>
              <SelectTrigger className="w-24">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" side="bottom" className="max-h-none">
                {[10, 11, 12, 13, 14, 15, 16, 18, 20].map((s) => (
                  <SelectItem key={s} value={String(s)}>{s}px</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
            <SettingLabel tip="Color theme for code and notes editors — defaults to the application theme">Editor theme</SettingLabel>
            <OverrideThemeSelect value={editorOverrideThemeId} onChange={setEditorOverrideThemeId} />
          </div>
          <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
            <SettingLabel tip="Typeface used in the notes editor">Font family</SettingLabel>
            <Select value={notesFontFamily} onValueChange={(v) => { setNotesFontFamily(v as 'sans' | 'mono'); window.api.settings.set('notes_font_family', v) }}>
              <SelectTrigger className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" side="bottom" className="max-h-none">
                <SelectItem value="sans">Sans-serif</SelectItem>
                <SelectItem value="mono">Monospace</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
            <SettingLabel tip="Vertical space between lines in the notes editor">Line spacing</SettingLabel>
            <Select value={notesLineSpacing} onValueChange={(v) => { setNotesLineSpacing(v as 'compact' | 'normal'); window.api.settings.set('notes_line_spacing', v) }}>
              <SelectTrigger className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" side="bottom" className="max-h-none">
                <SelectItem value="normal">Normal</SelectItem>
                <SelectItem value="compact">Compact</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
            <SettingLabel tip="Visually highlight completed checklist items in notes">Highlight checked items</SettingLabel>
            <Switch
              checked={notesCheckedHighlight}
              onCheckedChange={(checked) => {
                setNotesCheckedHighlight(checked)
                window.api.settings.set('notes_checked_highlight', checked ? '1' : '0')
              }}
            />
          </div>
          <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
            <SettingLabel tip="Display a WYSIWYG formatting toolbar above the notes editor">Show formatting toolbar</SettingLabel>
            <Switch
              checked={notesShowToolbar}
              onCheckedChange={(checked) => {
                setNotesShowToolbar(checked)
                window.api.settings.set('notes_show_toolbar', checked ? '1' : '0')
              }}
            />
          </div>
          <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
            <SettingLabel tip="Enable browser spellcheck in the notes editor">Spellcheck</SettingLabel>
            <Switch
              checked={notesSpellcheck}
              onCheckedChange={(checked) => {
                setNotesSpellcheck(checked)
                window.api.settings.set('notes_spellcheck', checked ? '1' : '0')
              }}
            />
          </div>
        </CardContent>
      </Card>

      {/* Other */}
      <Card>
        <CardHeader>
          <CardTitle>Other</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
            <SettingLabel tip="How tasks needing attention are indicated in the sidebar">Task attention badges</SettingLabel>
            <Select value={sidebarBadgeMode} onValueChange={(v) => { setSidebarBadgeMode(v as 'none' | 'blob' | 'count'); window.api.settings.set('sidebar_badge_mode', v) }}>
              <SelectTrigger className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" side="bottom" className="max-h-none">
                <SelectItem value="none">None</SelectItem>
                <SelectItem value="blob">Blob</SelectItem>
                <SelectItem value="count">Count</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
            <SettingLabel tip="Tint the UI with each project's assigned color">Project color tints</SettingLabel>
            <Switch
              checked={projectColorTints}
              onCheckedChange={(checked) => {
                setProjectColorTints(checked)
                window.api.settings.set('project_color_tints_enabled', checked ? '1' : '0')
              }}
            />
          </div>
          <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
            <SettingLabel tip="Disable animations throughout the app">Reduce motion</SettingLabel>
            <Switch
              checked={reduceMotion}
              onCheckedChange={(checked) => {
                setReduceMotion(checked)
                window.api.settings.set('reduce_motion', checked ? '1' : '0')
              }}
            />
          </div>
        </CardContent>
      </Card>
    </>
  )
}

function OverrideThemeSelect({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  return (
    <div className="flex items-center gap-2">
      <Select value={value || '_app'} onValueChange={(v) => onChange(v === '_app' ? '' : v)}>
        <SelectTrigger className="w-48">
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper" side="bottom" className="max-h-none">
          <SelectItem value="_app">Inherit</SelectItem>
          {unifiedThemes.map(t => (
            <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      {value && <ThemePreview themeId={value} />}
    </div>
  )
}

function ThemePreview({ themeId }: { themeId: string }) {
  const variant = useMemo(() => getThemeVariant(themeId, 'dark'), [themeId])
  const bg = variant.terminal.background
  const t = variant.terminal
  const dots = [t.red, t.green, t.yellow, t.blue, t.magenta, t.cyan]
  return (
    <div
      className="flex items-center gap-px rounded px-1.5 py-1 border"
      style={{ backgroundColor: bg }}
    >
      {dots.map((color, i) => (
        <div key={i} className="size-2.5 rounded-full" style={{ backgroundColor: color }} />
      ))}
    </div>
  )
}
