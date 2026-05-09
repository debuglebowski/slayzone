import { useState, useEffect } from 'react'
import { useTRPCClient } from '@slayzone/transport/client'
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
  const trpcClient = useTRPCClient()
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
      trpcClient.settings.get.query({ key: 'terminal_font_size' }),
      trpcClient.settings.get.query({ key: 'editor_font_size' }),
      trpcClient.settings.get.query({ key: 'reduce_motion' }),
      trpcClient.settings.get.query({ key: 'project_color_tints_enabled' }),
      trpcClient.settings.get.query({ key: 'editor_word_wrap' }),
      trpcClient.settings.get.query({ key: 'editor_tab_size' }),
      trpcClient.settings.get.query({ key: 'editor_indent_tabs' }),
      trpcClient.settings.get.query({ key: 'editor_render_whitespace' }),
      trpcClient.settings.get.query({ key: 'terminal_font_family' }),
      trpcClient.settings.get.query({ key: 'terminal_scrollback' }),
      trpcClient.settings.get.query({ key: 'diff_context_lines' }),
      trpcClient.settings.get.query({ key: 'diff_ignore_whitespace' }),
      trpcClient.settings.get.query({ key: 'diff_continuous_flow' }),
      trpcClient.settings.get.query({ key: 'diff_tree_collapsed' }),
      trpcClient.settings.get.query({ key: 'diff_side_by_side' }),
      trpcClient.settings.get.query({ key: 'diff_wrap' }),
      trpcClient.settings.get.query({ key: 'browser_default_zoom' }),
      trpcClient.settings.get.query({ key: 'browser_default_url' }),
      trpcClient.settings.get.query({ key: 'browser_default_devices' }),
      trpcClient.settings.get.query({ key: 'notes_font_family' }),
      trpcClient.settings.get.query({ key: 'notes_readability' }),
      trpcClient.settings.get.query({ key: 'notes_line_spacing' }),
      trpcClient.settings.get.query({ key: 'notes_width' }),
      trpcClient.settings.get.query({ key: 'notes_checked_highlight' }),
      trpcClient.settings.get.query({ key: 'notes_show_toolbar' }),
      trpcClient.settings.get.query({ key: 'notes_spellcheck' }),
      trpcClient.settings.get.query({ key: 'chat_width' }),
      trpcClient.settings.get.query({ key: 'chat_show_tools' }),
      trpcClient.settings.get.query({ key: 'chat_show_last_message_tools' }),
      trpcClient.settings.get.query({ key: 'chat_file_edits_open_by_default' }),
      trpcClient.settings.get.query({ key: 'chat_show_message_meta' }),
      trpcClient.settings.get.query({ key: 'editor_markdown_view_mode' }),
      trpcClient.settings.get.query({ key: 'editor_minimap_enabled' }),
      trpcClient.settings.get.query({ key: 'editor_toc_enabled' }),
    ]).then(([
      termSize, editorSize, reduceMotion, colorTints,
      wordWrap, tabSize, indentTabs, renderWs,
      termFamily, termScrollback,
      diffContext, diffWs,
      diffContinuous, diffTreeColl, diffSbS, diffWrap,
      browserZoom, browserUrl, browserDevices,
      notesFontFamily, notesReadability, legacyNotesLineSpacing, notesWidth, notesCheckedHighlight, notesShowToolbar, notesSpellcheck,
      chatWidth,
      chatShowTools, chatShowLastMessageTools, chatFileEditsOpenByDefault, chatShowMessageMeta,
      mdViewMode, minimapEnabled, tocEnabled,
    ]) => {
      // One-shot migration: notes_line_spacing → notes_readability
      let readabilityValue = notesReadability
      if (!readabilityValue && legacyNotesLineSpacing) {
        readabilityValue = legacyNotesLineSpacing
        trpcClient.settings.set.mutate({ key: 'notes_readability', value: legacyNotesLineSpacing })
        trpcClient.settings.set.mutate({ key: 'notes_line_spacing', value: '' })
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
        diffContinuousFlow: diffContinuous === '1',
        diffTreeCollapsed: diffTreeColl === '1',
        diffSideBySide: diffSbS === '1',
        diffWrap: diffWrap === '1',
        browserDefaultZoom: browserZoom ? parseInt(browserZoom, 10) : d.browserDefaultZoom,
        browserDefaultUrl: browserUrl || '',
        browserDeviceDefaults: tryParseJson<BrowserDeviceDefaults | null>(browserDevices, null),
        notesFontFamily: notesFontFamily === 'mono' ? 'mono' : 'sans',
        notesReadability: readabilityValue === 'compact' ? 'compact' : 'normal',
        notesWidth: notesWidth === 'wide' ? 'wide' : 'narrow',
        notesCheckedHighlight: notesCheckedHighlight === '1',
        notesShowToolbar: notesShowToolbar === '1',
        notesSpellcheck: notesSpellcheck !== '0',
        chatWidth: chatWidth === 'wide' ? 'wide' : 'narrow',
        chatShowTools: chatShowTools !== '0',
        chatShowLastMessageTools: chatShowLastMessageTools !== '0',
        chatFileEditsOpenByDefault: chatFileEditsOpenByDefault !== '0',
        chatShowMessageMeta: chatShowMessageMeta !== '0',
        editorMarkdownViewMode: (mdViewMode === 'split' || mdViewMode === 'code') ? mdViewMode : 'rich',
        editorMinimapEnabled: minimapEnabled === '1',
        editorTocEnabled: tocEnabled === '1',
      })
    })
  }, [settingsRevision, localRevision])

  return (
    <AppearanceContext.Provider value={settings}>
      {children}
    </AppearanceContext.Provider>
  )
}
