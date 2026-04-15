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
  const [localRevision, setLocalRevision] = useState(0)

  useEffect(() => {
    const handler = () => setLocalRevision(r => r + 1)
    window.addEventListener('sz:settings-changed', handler)
    return () => window.removeEventListener('sz:settings-changed', handler)
  }, [])

  useEffect(() => {
    performance.mark('sz:appearance:start')
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
      window.api.settings.get('sidebar_badge_mode'),
      window.api.settings.get('notes_font_family'),
      window.api.settings.get('notes_readability'),
      window.api.settings.get('notes_line_spacing'),
      window.api.settings.get('notes_width'),
      window.api.settings.get('notes_checked_highlight'),
      window.api.settings.get('notes_show_toolbar'),
      window.api.settings.get('notes_spellcheck'),
      window.api.settings.get('editor_markdown_view_mode'),
    ]).then(([
      termSize, editorSize, reduceMotion, colorTints,
      wordWrap, tabSize, indentTabs, renderWs,
      termFamily, termScrollback,
      diffContext, diffWs,
      browserZoom, browserUrl, browserDevices,
      sidebarBadge,
      notesFontFamily, notesReadability, legacyNotesLineSpacing, notesWidth, notesCheckedHighlight, notesShowToolbar, notesSpellcheck,
      mdViewMode,
    ]) => {
      // One-shot migration: notes_line_spacing → notes_readability
      let readabilityValue = notesReadability
      if (!readabilityValue && legacyNotesLineSpacing) {
        readabilityValue = legacyNotesLineSpacing
        window.api.settings.set('notes_readability', legacyNotesLineSpacing)
        window.api.settings.set('notes_line_spacing', '')
      }
      const d = appearanceDefaults
      performance.mark('sz:appearance:end')
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
        diffContextLines: (diffContext === '0' || diffContext === '5' || diffContext === 'all') ? diffContext : '3',
        diffIgnoreWhitespace: diffWs === '1',
        browserDefaultZoom: browserZoom ? parseInt(browserZoom, 10) : d.browserDefaultZoom,
        browserDefaultUrl: browserUrl || '',
        browserDeviceDefaults: tryParseJson<BrowserDeviceDefaults | null>(browserDevices, null),
        sidebarBadgeMode: (sidebarBadge === 'none' || sidebarBadge === 'count') ? sidebarBadge : 'blob',
        notesFontFamily: notesFontFamily === 'mono' ? 'mono' : 'sans',
        notesReadability: readabilityValue === 'compact' ? 'compact' : 'normal',
        notesWidth: notesWidth === 'wide' ? 'wide' : 'narrow',
        notesCheckedHighlight: notesCheckedHighlight === '1',
        notesShowToolbar: notesShowToolbar === '1',
        notesSpellcheck: notesSpellcheck !== '0',
        editorMarkdownViewMode: (mdViewMode === 'split' || mdViewMode === 'code') ? mdViewMode : 'rich',
      })
    })
  }, [settingsRevision, localRevision])

  return (
    <AppearanceContext.Provider value={settings}>
      {children}
    </AppearanceContext.Provider>
  )
}
