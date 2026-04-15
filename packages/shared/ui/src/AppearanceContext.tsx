import { createContext, useContext } from 'react'

export interface BrowserDeviceDefaults {
  desktop: { enabled: boolean; width: number; height: number }
  tablet: { enabled: boolean; width: number; height: number }
  mobile: { enabled: boolean; width: number; height: number }
}

export interface AppearanceSettings {
  terminalFontSize: number
  editorFontSize: number
  reduceMotion: boolean
  colorTintsEnabled: boolean
  // Editor
  editorWordWrap: 'on' | 'off'
  editorTabSize: 2 | 4
  editorIndentTabs: boolean
  editorRenderWhitespace: 'none' | 'all'
  // Terminal
  terminalFontFamily: string
  terminalScrollback: number
  // Diff
  diffContextLines: '0' | '3' | '5' | 'all'
  diffIgnoreWhitespace: boolean
  // Browser
  browserDefaultZoom: number
  browserDefaultUrl: string
  browserDeviceDefaults: BrowserDeviceDefaults | null
  // Editor
  notesFontFamily: 'sans' | 'mono'
  notesReadability: 'compact' | 'normal'
  notesWidth: 'narrow' | 'wide'
  notesCheckedHighlight: boolean
  notesShowToolbar: boolean
  notesSpellcheck: boolean
  // Sidebar
  sidebarBadgeMode: 'none' | 'blob' | 'count'
  // Markdown
  editorMarkdownViewMode: 'rich' | 'split' | 'code'
}

export const appearanceDefaults: AppearanceSettings = {
  terminalFontSize: 13,
  editorFontSize: 13,
  reduceMotion: false,
  colorTintsEnabled: true,
  editorWordWrap: 'off',
  editorTabSize: 2,
  editorIndentTabs: false,
  editorRenderWhitespace: 'none',
  terminalFontFamily: 'Menlo, Monaco, "Courier New", monospace',
  terminalScrollback: 5000,
  diffContextLines: '3',
  diffIgnoreWhitespace: false,
  browserDefaultZoom: 100,
  browserDefaultUrl: '',
  browserDeviceDefaults: null,
  notesFontFamily: 'sans',
  notesReadability: 'normal',
  notesWidth: 'narrow',
  notesCheckedHighlight: false,
  notesShowToolbar: false,
  notesSpellcheck: true,
  sidebarBadgeMode: 'blob',
  editorMarkdownViewMode: 'rich',
}

export const AppearanceContext = createContext<AppearanceSettings>(appearanceDefaults)

export function useAppearance(): AppearanceSettings {
  return useContext(AppearanceContext)
}
