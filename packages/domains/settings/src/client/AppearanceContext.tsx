import { useState, useEffect } from 'react'
import type { ReactNode } from 'react'
import { AppearanceContext, appearanceDefaults } from '@slayzone/ui'
import type { AppearanceSettings, BrowserDeviceDefaults } from '@slayzone/ui'

function tryParseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

export function AppearanceProvider({
  settingsRevision,
  children
}: {
  settingsRevision: number
  children: ReactNode
}) {
  const [settings, setSettings] = useState<AppearanceSettings>(appearanceDefaults)

  useEffect(() => {
    Promise.all([
      window.api.settings.get('terminal_font_size'),
      window.api.settings.get('editor_font_size'),
      window.api.settings.get('reduce_motion'),
      window.api.settings.get('project_color_tints_enabled'),
      window.api.settings.get('editor_word_wrap'),
      window.api.settings.get('editor_tab_size'),
      window.api.settings.get('editor_indent_tabs'),
      window.api.settings.get('editor_render_whitespace'),
      window.api.settings.get('terminal_font_family'),
      window.api.settings.get('terminal_scrollback'),
      window.api.settings.get('diff_context_lines'),
      window.api.settings.get('diff_ignore_whitespace'),
      window.api.settings.get('browser_default_zoom'),
      window.api.settings.get('browser_default_url'),
      window.api.settings.get('browser_default_devices'),
      window.api.settings.get('terminal_theme_override'),
    ]).then(([
      termSize, editorSize, reduceMotion, colorTints,
      wordWrap, tabSize, indentTabs, renderWs,
      termFamily, termScrollback,
      diffContext, diffWs,
      browserZoom, browserUrl, browserDevices,
      termThemeOverride,
    ]) => {
      const d = appearanceDefaults
      setSettings({
        terminalFontSize: termSize ? parseInt(termSize, 10) : d.terminalFontSize,
        editorFontSize: editorSize ? parseInt(editorSize, 10) : d.editorFontSize,
        reduceMotion: reduceMotion === '1',
        colorTintsEnabled: colorTints !== '0',
        editorWordWrap: wordWrap === 'on' ? 'on' : 'off',
        editorTabSize: tabSize === '4' ? 4 : 2,
        editorIndentTabs: indentTabs === '1',
        editorRenderWhitespace: renderWs === 'all' ? 'all' : 'none',
        terminalFontFamily: termFamily || d.terminalFontFamily,
        terminalScrollback: termScrollback ? parseInt(termScrollback, 10) : d.terminalScrollback,
        terminalThemeOverride: termThemeOverride === 'dark' || termThemeOverride === 'light' ? termThemeOverride : 'follow',
        diffContextLines: (diffContext === '0' || diffContext === '5' || diffContext === 'all') ? diffContext : '3',
        diffIgnoreWhitespace: diffWs === '1',
        browserDefaultZoom: browserZoom ? parseInt(browserZoom, 10) : d.browserDefaultZoom,
        browserDefaultUrl: browserUrl || '',
        browserDeviceDefaults: tryParseJson<BrowserDeviceDefaults | null>(browserDevices, null),
      })
    })
  }, [settingsRevision])

  return (
    <AppearanceContext.Provider value={settings}>
      {children}
    </AppearanceContext.Provider>
  )
}
