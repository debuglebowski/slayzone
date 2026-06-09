import { useState, useEffect } from 'react'
import type { ReactNode } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import { useTRPC } from '@slayzone/transport/client'
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
  const trpc = useTRPC()
  const [settings, setSettings] = useState<AppearanceSettings>(appearanceDefaults)

  const allSettingsQuery = useQuery(trpc.settings.getAll.queryOptions())
  const setSettingMutation = useMutation(trpc.settings.set.mutationOptions())

  // External retriggers (revision bump + the legacy 'sz:settings-changed'
  // CustomEvent fired by other windows/handlers) refetch the settings snapshot.
  useEffect(() => {
    void allSettingsQuery.refetch()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsRevision])

  useEffect(() => {
    const handler = (): void => {
      void allSettingsQuery.refetch()
    }
    window.addEventListener('sz:settings-changed', handler)
    return () => window.removeEventListener('sz:settings-changed', handler)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const all = allSettingsQuery.data
    if (!all) return
    performance.mark('sz:appearance:start')
    const get = (key: string): string | undefined => all[key]

    const termSize = get('terminal_font_size')
    const editorSize = get('editor_font_size')
    const reduceMotion = get('reduce_motion')
    const colorTints = get('project_color_tints_enabled')
    const wordWrap = get('editor_word_wrap')
    const tabSize = get('editor_tab_size')
    const indentTabs = get('editor_indent_tabs')
    const renderWs = get('editor_render_whitespace')
    const termFamily = get('terminal_font_family')
    const termScrollback = get('terminal_scrollback')
    const termForceCompat = get('terminal_force_compatibility_renderer')
    const diffContext = get('diff_context_lines')
    const diffWs = get('diff_ignore_whitespace')
    const diffContinuous = get('diff_continuous_flow')
    const diffTreeColl = get('diff_tree_collapsed')
    const diffSbS = get('diff_side_by_side')
    const diffWrap = get('diff_wrap')
    const browserZoom = get('browser_default_zoom')
    const browserUrl = get('browser_default_url')
    const browserDevices = get('browser_default_devices')
    const notesFontFamily = get('notes_font_family')
    const notesReadability = get('notes_readability')
    const legacyNotesLineSpacing = get('notes_line_spacing')
    const notesWidth = get('notes_width')
    const notesCheckedHighlight = get('notes_checked_highlight')
    const notesShowToolbar = get('notes_show_toolbar')
    const notesSpellcheck = get('notes_spellcheck')
    const chatWidth = get('chat_width')
    const chatShowTools = get('chat_show_tools')
    const chatShowLastMessageTools = get('chat_show_last_message_tools')
    const chatFileEditsOpenByDefault = get('chat_file_edits_open_by_default')
    const chatShowMessageMeta = get('chat_show_message_meta')
    const mdViewMode = get('editor_markdown_view_mode')
    const minimapEnabled = get('editor_minimap_enabled')
    const tocEnabled = get('editor_toc_enabled')

    // One-shot migration: notes_line_spacing → notes_readability
    let readabilityValue = notesReadability
    if (!readabilityValue && legacyNotesLineSpacing) {
      readabilityValue = legacyNotesLineSpacing
      setSettingMutation.mutate({ key: 'notes_readability', value: legacyNotesLineSpacing })
      setSettingMutation.mutate({ key: 'notes_line_spacing', value: '' })
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
      terminalForceCompatibilityRenderer: termForceCompat === '1',
      diffContextLines:
        diffContext === '0' || diffContext === '5' || diffContext === 'all' ? diffContext : '3',
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
      editorMarkdownViewMode: mdViewMode === 'split' || mdViewMode === 'code' ? mdViewMode : 'rich',
      editorMinimapEnabled: minimapEnabled === '1',
      editorTocEnabled: tocEnabled === '1'
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allSettingsQuery.data])

  return <AppearanceContext.Provider value={settings}>{children}</AppearanceContext.Provider>
}
