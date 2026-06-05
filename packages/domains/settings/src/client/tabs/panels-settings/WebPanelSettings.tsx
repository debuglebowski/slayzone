import { Trash2 } from 'lucide-react'
import { Button, Input, Label, Switch } from '@slayzone/ui'
import { inferProtocolFromUrl } from '@slayzone/task/shared'
import { CARD_CLASS } from './panels-settings.constants'
import { PanelLayoutControls } from './PanelLayoutControls'
import type { PanelSettingsState } from './usePanelSettings'

export function WebPanelSettings({ state }: { state: PanelSettingsState }) {
  const {
    panelConfig,
    savePanelConfig,
    panelDetailId,
    validateShortcut,
    handleSaveEditPanel,
    handleDeleteWebPanel,
    editPanelName,
    setEditPanelName,
    editPanelUrl,
    setEditPanelUrl,
    editPanelShortcut,
    setEditPanelShortcut,
    editPanelBlockDesktopHandoff,
    setEditPanelBlockDesktopHandoff,
    editPanelHandoffProtocol,
    setEditPanelHandoffProtocol,
    editPanelProtocolError,
    setEditPanelProtocolError,
    editShortcutError,
    setEditShortcutError
  } = state
  if (!panelDetailId) return null
  const wp = panelConfig.webPanels.find((p) => p.id === panelDetailId)
  if (!wp) return null
  return (
    <>
      <div className={CARD_CLASS}>
        <Label className="text-base font-semibold">General</Label>
        <div className="grid grid-cols-[180px_minmax(0,1fr)] items-center gap-3">
          <span className="text-sm text-muted-foreground">Name</span>
          <Input value={editPanelName} onChange={(e) => setEditPanelName(e.target.value)} />
        </div>
        <div className="grid grid-cols-[180px_minmax(0,1fr)] items-center gap-3">
          <span className="text-sm text-muted-foreground">URL</span>
          <Input value={editPanelUrl} onChange={(e) => setEditPanelUrl(e.target.value)} />
        </div>
        <div className="grid grid-cols-[180px_minmax(0,1fr)] items-center gap-3">
          <span className="text-sm text-muted-foreground">Keyboard shortcut</span>
          <Input
            className="max-w-20"
            placeholder="Key"
            maxLength={1}
            value={editPanelShortcut}
            onChange={(e) => {
              const v = e.target.value.slice(-1)
              setEditPanelShortcut(v)
              setEditShortcutError(validateShortcut(v, panelDetailId!) || '')
            }}
          />
        </div>
        {editShortcutError && <p className="text-xs text-destructive">{editShortcutError}</p>}
        <div className="grid grid-cols-[180px_minmax(0,1fr)] items-center gap-3">
          <span className="text-sm text-muted-foreground">Handoff links</span>
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <Switch
                checked={editPanelBlockDesktopHandoff}
                onCheckedChange={(c) => {
                  setEditPanelBlockDesktopHandoff(c)
                  if (c && !editPanelHandoffProtocol.trim())
                    setEditPanelHandoffProtocol(inferProtocolFromUrl(editPanelUrl) ?? '')
                  if (!c) setEditPanelProtocolError('')
                }}
              />
              <span className="text-xs text-muted-foreground">
                Block desktop app handoff links
              </span>
            </div>
            {editPanelBlockDesktopHandoff && (
              <div className="space-y-1">
                <Input
                  placeholder="e.g. figma"
                  value={editPanelHandoffProtocol}
                  onChange={(e) => {
                    setEditPanelHandoffProtocol(e.target.value)
                    setEditPanelProtocolError('')
                  }}
                />
              </div>
            )}
            {editPanelProtocolError && (
              <p className="text-xs text-destructive">{editPanelProtocolError}</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 pt-2">
          <Button onClick={() => handleSaveEditPanel(panelDetailId)}>Save</Button>
          <div className="flex-1" />
          <Button
            variant="ghost"
            className="text-destructive hover:text-destructive"
            onClick={() => handleDeleteWebPanel(wp.id)}
          >
            <Trash2 className="size-3.5 mr-1" /> Delete
          </Button>
        </div>
      </div>
      <div className={CARD_CLASS}>
        <PanelLayoutControls
          orderId={wp.id}
          panelConfig={panelConfig}
          onSave={savePanelConfig}
        />
      </div>
    </>
  )
}
