import { useEffect, useMemo, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useTRPC } from '@slayzone/transport/client'
import { AppearanceContext, appearanceDefaults } from '@slayzone/ui'
import type { AppearanceSettings, BrowserDeviceDefaults } from '@slayzone/ui'
import { useSettings, useSetSettingMutation } from './queries'

const APPEARANCE_KEYS = [
  'terminal_font_size', 'editor_font_size', 'reduce_motion', 'project_color_tints_enabled',
  'editor_word_wrap', 'editor_tab_size', 'editor_indent_tabs', 'editor_render_whitespace',
  'terminal_font_family', 'terminal_scrollback',
  'terminal_archive_cap_mb', 'terminal_archive_initial_lines', 'terminal_archive_step_lines',
  'diff_context_lines', 'diff_ignore_whitespace',
  'diff_continuous_flow', 'diff_tree_collapsed', 'diff_side_by_side', 'diff_wrap',
  'browser_default_zoom', 'browser_default_url', 'browser_default_devices',
  'notes_font_family', 'notes_readability', 'notes_line_spacing', 'notes_width',
  'notes_checked_highlight', 'notes_show_toolbar', 'notes_spellcheck',
  'chat_width', 'chat_show_tools', 'chat_show_last_message_tools',
  'chat_file_edits_open_by_default', 'chat_show_message_meta',
  'editor_markdown_view_mode', 'editor_minimap_enabled', 'editor_toc_enabled',
] as const

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
  const queryClient = useQueryClient()
  const setSetting = useSetSettingMutation()
  const s = useSettings(APPEARANCE_KEYS)

  useEffect(() => {
    queryClient.invalidateQueries({ queryKey: trpc.settings.get.queryKey() })
  }, [settingsRevision, queryClient, trpc])

  useEffect(() => {
    const handler = () => queryClient.invalidateQueries({ queryKey: trpc.settings.get.queryKey() })
    window.addEventListener('sz:settings-changed', handler)
    return () => window.removeEventListener('sz:settings-changed', handler)
  }, [queryClient, trpc])

  // One-shot migration: notes_line_spacing → notes_readability
  useEffect(() => {
    if (s.notes_readability === undefined || s.notes_line_spacing === undefined) return
    if (!s.notes_readability && s.notes_line_spacing) {
      setSetting.mutate({ key: 'notes_readability', value: s.notes_line_spacing })
      setSetting.mutate({ key: 'notes_line_spacing', value: '' })
    }
  }, [s.notes_readability, s.notes_line_spacing, setSetting])

  const settings = useMemo<AppearanceSettings>(() => {
    const d = appearanceDefaults
    const readabilityValue = s.notes_readability || s.notes_line_spacing
    return {
      terminalFontSize: s.terminal_font_size ? parseInt(s.terminal_font_size, 10) : d.terminalFontSize,
      editorFontSize: s.editor_font_size ? parseInt(s.editor_font_size, 10) : d.editorFontSize,
      reduceMotion: s.reduce_motion === '1',
      colorTintsEnabled: s.project_color_tints_enabled !== '0',
      editorWordWrap: s.editor_word_wrap === 'on' ? 'on' : 'off',
      editorTabSize: s.editor_tab_size === '4' ? 4 : 2,
      editorIndentTabs: s.editor_indent_tabs === '1',
      editorRenderWhitespace: s.editor_render_whitespace === 'all' ? 'all' : 'none',
      terminalFontFamily: s.terminal_font_family || d.terminalFontFamily,
      terminalScrollback: s.terminal_scrollback ? parseInt(s.terminal_scrollback, 10) : d.terminalScrollback,
      terminalArchiveCapMb: s.terminal_archive_cap_mb ? Math.max(1, parseInt(s.terminal_archive_cap_mb, 10) || d.terminalArchiveCapMb) : d.terminalArchiveCapMb,
      terminalArchiveInitialLines: s.terminal_archive_initial_lines ? Math.max(50, parseInt(s.terminal_archive_initial_lines, 10) || d.terminalArchiveInitialLines) : d.terminalArchiveInitialLines,
      terminalArchiveStepLines: s.terminal_archive_step_lines ? Math.max(50, parseInt(s.terminal_archive_step_lines, 10) || d.terminalArchiveStepLines) : d.terminalArchiveStepLines,
      diffContextLines: (s.diff_context_lines === '0' || s.diff_context_lines === '5' || s.diff_context_lines === 'all') ? s.diff_context_lines : '3',
      diffIgnoreWhitespace: s.diff_ignore_whitespace === '1',
      diffContinuousFlow: s.diff_continuous_flow === '1',
      diffTreeCollapsed: s.diff_tree_collapsed === '1',
      diffSideBySide: s.diff_side_by_side === '1',
      diffWrap: s.diff_wrap === '1',
      browserDefaultZoom: s.browser_default_zoom ? parseInt(s.browser_default_zoom, 10) : d.browserDefaultZoom,
      browserDefaultUrl: s.browser_default_url || '',
      browserDeviceDefaults: tryParseJson<BrowserDeviceDefaults | null>(s.browser_default_devices, null),
      notesFontFamily: s.notes_font_family === 'mono' ? 'mono' : 'sans',
      notesReadability: readabilityValue === 'compact' ? 'compact' : 'normal',
      notesWidth: s.notes_width === 'wide' ? 'wide' : 'narrow',
      notesCheckedHighlight: s.notes_checked_highlight === '1',
      notesShowToolbar: s.notes_show_toolbar === '1',
      notesSpellcheck: s.notes_spellcheck !== '0',
      chatWidth: s.chat_width === 'wide' ? 'wide' : 'narrow',
      chatShowTools: s.chat_show_tools !== '0',
      chatShowLastMessageTools: s.chat_show_last_message_tools !== '0',
      chatFileEditsOpenByDefault: s.chat_file_edits_open_by_default !== '0',
      chatShowMessageMeta: s.chat_show_message_meta !== '0',
      editorMarkdownViewMode: (s.editor_markdown_view_mode === 'split' || s.editor_markdown_view_mode === 'code') ? s.editor_markdown_view_mode : 'rich',
      editorMinimapEnabled: s.editor_minimap_enabled === '1',
      editorTocEnabled: s.editor_toc_enabled === '1',
    }
  }, [s])

  return (
    <AppearanceContext.Provider value={settings}>
      {children}
    </AppearanceContext.Provider>
  )
}
