import { useState, useEffect, useMemo } from 'react'
import { getTrpcVanillaClient } from '@slayzone/transport/client'
import { Info } from 'lucide-react'
import { Card, CardHeader, CardTitle, CardContent, Select, SelectTrigger, SelectValue, SelectContent, SelectItem, Switch, Tooltip, TooltipTrigger, TooltipContent, unifiedThemes, getThemeVariant } from '@slayzone/ui'
import { useTheme } from '../ThemeContext'
import { useTabStore } from '../useTabStore'
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
  const projectScopedTabs = useTabStore((s) => s.projectScopedTabs)
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
  const [showContextManager, setShowContextManager] = useState(true)
  const [terminalFontSize, setTerminalFontSize] = useState('13')
  const [editorFontSize, setEditorFontSize] = useState('13')
  const [reduceMotion, setReduceMotion] = useState(false)
  const [notesFontFamily, setNotesFontFamily] = useState<'sans' | 'mono'>('sans')
  const [notesReadability, setNotesReadability] = useState<'compact' | 'normal'>('normal')
  const [notesWidth, setNotesWidth] = useState<'narrow' | 'wide'>('narrow')
  const [notesCheckedHighlight, setNotesCheckedHighlight] = useState(false)
  const [notesShowToolbar, setNotesShowToolbar] = useState(false)
  const [notesSpellcheck, setNotesSpellcheck] = useState(true)
  const [chatWidth, setChatWidth] = useState<'narrow' | 'wide'>('narrow')

  useEffect(() => {
    getTrpcVanillaClient().settings.get.query({ key: 'project_color_tints_enabled' }).then(val => setProjectColorTints(val !== '0'))
    getTrpcVanillaClient().settings.get.query({ key: 'show_context_manager' }).then(val => setShowContextManager(val !== '0'))
    getTrpcVanillaClient().settings.get.query({ key: 'terminal_font_size' }).then(val => setTerminalFontSize(val ?? '13'))
    getTrpcVanillaClient().settings.get.query({ key: 'editor_font_size' }).then(val => setEditorFontSize(val ?? '13'))
    getTrpcVanillaClient().settings.get.query({ key: 'reduce_motion' }).then(val => setReduceMotion(val === '1'))
    getTrpcVanillaClient().settings.get.query({ key: 'notes_font_family' }).then(val => setNotesFontFamily(val === 'mono' ? 'mono' : 'sans'))
    Promise.all([
      getTrpcVanillaClient().settings.get.query({ key: 'notes_readability' }),
      getTrpcVanillaClient().settings.get.query({ key: 'notes_line_spacing' }),
    ]).then(([readability, legacy]) => {
      const value = readability || legacy
      setNotesReadability(value === 'compact' ? 'compact' : 'normal')
    })
    getTrpcVanillaClient().settings.get.query({ key: 'notes_width' }).then(val => setNotesWidth(val === 'wide' ? 'wide' : 'narrow'))
    getTrpcVanillaClient().settings.get.query({ key: 'notes_checked_highlight' }).then(val => setNotesCheckedHighlight(val === '1'))
    getTrpcVanillaClient().settings.get.query({ key: 'notes_show_toolbar' }).then(val => setNotesShowToolbar(val === '1'))
    getTrpcVanillaClient().settings.get.query({ key: 'notes_spellcheck' }).then(val => setNotesSpellcheck(val !== '0'))
    getTrpcVanillaClient().settings.get.query({ key: 'chat_width' }).then(val => setChatWidth(val === 'wide' ? 'wide' : 'narrow'))
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
            <Select value={terminalFontSize} onValueChange={(v) => { setTerminalFontSize(v); getTrpcVanillaClient().settings.set.mutate({ key: 'terminal_font_size', value: v }) }}>
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
          <CardTitle>Editor & Artifacts</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
            <SettingLabel tip="Text size in the code and notes editor">Font size</SettingLabel>
            <Select value={editorFontSize} onValueChange={(v) => { setEditorFontSize(v); getTrpcVanillaClient().settings.set.mutate({ key: 'editor_font_size', value: v }) }}>
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
            <Select value={notesFontFamily} onValueChange={(v) => { setNotesFontFamily(v as 'sans' | 'mono'); getTrpcVanillaClient().settings.set.mutate({ key: 'notes_font_family', value: v }) }}>
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
            <SettingLabel tip="Vertical density of rendered markdown — text size, line height, and vertical padding">Readability</SettingLabel>
            <Select value={notesReadability} onValueChange={(v) => { setNotesReadability(v as 'compact' | 'normal'); getTrpcVanillaClient().settings.set.mutate({ key: 'notes_readability', value: v }) }}>
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
            <SettingLabel tip="Horizontal width of rendered markdown — column max-width and horizontal padding">Width</SettingLabel>
            <Select value={notesWidth} onValueChange={(v) => { setNotesWidth(v as 'narrow' | 'wide'); getTrpcVanillaClient().settings.set.mutate({ key: 'notes_width', value: v }) }}>
              <SelectTrigger className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" side="bottom" className="max-h-none">
                <SelectItem value="narrow">Narrow</SelectItem>
                <SelectItem value="wide">Wide</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
            <SettingLabel tip="Visually highlight completed checklist items in notes">Highlight checked items</SettingLabel>
            <Switch
              checked={notesCheckedHighlight}
              onCheckedChange={(checked) => {
                setNotesCheckedHighlight(checked)
                getTrpcVanillaClient().settings.set.mutate({ key: 'notes_checked_highlight', value: checked ? '1' : '0' })
              }}
            />
          </div>
          <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
            <SettingLabel tip="Display a WYSIWYG formatting toolbar above the notes editor">Show formatting toolbar</SettingLabel>
            <Switch
              checked={notesShowToolbar}
              onCheckedChange={(checked) => {
                setNotesShowToolbar(checked)
                getTrpcVanillaClient().settings.set.mutate({ key: 'notes_show_toolbar', value: checked ? '1' : '0' })
              }}
            />
          </div>
          <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
            <SettingLabel tip="Enable browser spellcheck in the notes editor">Spellcheck</SettingLabel>
            <Switch
              checked={notesSpellcheck}
              onCheckedChange={(checked) => {
                setNotesSpellcheck(checked)
                getTrpcVanillaClient().settings.set.mutate({ key: 'notes_spellcheck', value: checked ? '1' : '0' })
              }}
            />
          </div>
        </CardContent>
      </Card>

      {/* Chat */}
      <Card>
        <CardHeader>
          <CardTitle>Chat</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
            <SettingLabel tip="Horizontal width of agent chat — message column and composer max-width">Width</SettingLabel>
            <Select value={chatWidth} onValueChange={(v) => { setChatWidth(v as 'narrow' | 'wide'); getTrpcVanillaClient().settings.set.mutate({ key: 'chat_width', value: v }) }}>
              <SelectTrigger className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" side="bottom" className="max-h-none">
                <SelectItem value="narrow">Narrow</SelectItem>
                <SelectItem value="wide">Wide</SelectItem>
              </SelectContent>
            </Select>
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
            <SettingLabel tip="Tint the UI with each project's assigned color">Project color tints</SettingLabel>
            <Switch
              checked={projectColorTints}
              onCheckedChange={(checked) => {
                setProjectColorTints(checked)
                getTrpcVanillaClient().settings.set.mutate({ key: 'project_color_tints_enabled', value: checked ? '1' : '0' })
              }}
            />
          </div>
          <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
            <SettingLabel tip="Disable animations throughout the app">Reduce motion</SettingLabel>
            <Switch
              checked={reduceMotion}
              onCheckedChange={(checked) => {
                setReduceMotion(checked)
                getTrpcVanillaClient().settings.set.mutate({ key: 'reduce_motion', value: checked ? '1' : '0' })
              }}
            />
          </div>
          <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
            <SettingLabel tip="Only show tabs from the active project in the tab bar">Project-scoped tabs</SettingLabel>
            <Switch
              checked={projectScopedTabs}
              onCheckedChange={(checked) => useTabStore.getState().setProjectScopedTabs(checked)}
            />
          </div>
          <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
            <SettingLabel tip="Show the Context Manager button in the tab bar">Context Manager</SettingLabel>
            <Switch
              checked={showContextManager}
              onCheckedChange={(checked) => {
                setShowContextManager(checked)
                getTrpcVanillaClient().settings.set.mutate({ key: 'show_context_manager', value: checked ? '1' : '0' })
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
