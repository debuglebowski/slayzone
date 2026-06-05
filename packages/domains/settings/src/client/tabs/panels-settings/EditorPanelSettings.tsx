import {
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch
} from '@slayzone/ui'
import { CARD_CLASS } from './panels-settings.constants'
import { PanelLayoutControls } from './PanelLayoutControls'
import type { PanelSettingsState } from './usePanelSettings'

export function EditorPanelSettings({ state }: { state: PanelSettingsState }) {
  const {
    panelConfig,
    savePanelConfig,
    editorWordWrap,
    setEditorWordWrap,
    editorRenderWhitespace,
    setEditorRenderWhitespace,
    editorTabSize,
    setEditorTabSize,
    editorIndentTabs,
    setEditorIndentTabs,
    editorMarkdownViewMode,
    setEditorMarkdownViewMode
  } = state
  return (
    <>
      <div className={CARD_CLASS}>
        <Label className="text-base font-semibold">General</Label>
        <div className="grid grid-cols-[180px_minmax(0,1fr)] items-center gap-3">
          <span className="text-sm text-muted-foreground">Word wrap</span>
          <Switch
            checked={editorWordWrap === 'on'}
            onCheckedChange={(c) => {
              const v = c ? 'on' : 'off'
              setEditorWordWrap(v)
              window.api.settings.set('editor_word_wrap', v)
            }}
          />
        </div>
        <div className="grid grid-cols-[180px_minmax(0,1fr)] items-center gap-3">
          <span className="text-sm text-muted-foreground">Show whitespace</span>
          <Switch
            checked={editorRenderWhitespace === 'all'}
            onCheckedChange={(c) => {
              const v = c ? 'all' : 'none'
              setEditorRenderWhitespace(v)
              window.api.settings.set('editor_render_whitespace', v)
            }}
          />
        </div>
        <div className="grid grid-cols-[180px_minmax(0,1fr)] items-center gap-3">
          <span className="text-sm text-muted-foreground">Tab size</span>
          <Select
            value={editorTabSize}
            onValueChange={(v) => {
              setEditorTabSize(v as any)
              window.api.settings.set('editor_tab_size', v)
            }}
          >
            <SelectTrigger className="max-w-24">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="2">2</SelectItem>
              <SelectItem value="4">4</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="grid grid-cols-[180px_minmax(0,1fr)] items-center gap-3">
          <span className="text-sm text-muted-foreground">Indent with tabs</span>
          <Switch
            checked={editorIndentTabs}
            onCheckedChange={(c) => {
              setEditorIndentTabs(c)
              window.api.settings.set('editor_indent_tabs', c ? '1' : '0')
            }}
          />
        </div>
        <div className="grid grid-cols-[180px_minmax(0,1fr)] items-center gap-3">
          <span className="text-sm text-muted-foreground">Markdown default</span>
          <Select
            value={editorMarkdownViewMode}
            onValueChange={(v) => {
              setEditorMarkdownViewMode(v as any)
              window.api.settings.set('editor_markdown_view_mode', v)
              window.dispatchEvent(new Event('sz:settings-changed'))
            }}
          >
            <SelectTrigger className="max-w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="rich">Rich text</SelectItem>
              <SelectItem value="split">Split</SelectItem>
              <SelectItem value="code">Source code</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className={CARD_CLASS}>
        <PanelLayoutControls orderId="editor" panelConfig={panelConfig} onSave={savePanelConfig} />
      </div>
    </>
  )
}
