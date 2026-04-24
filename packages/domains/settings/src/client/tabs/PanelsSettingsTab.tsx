import { useState, useEffect } from 'react'
import { ChevronRight, Cpu, FileCode, GitCompare, Globe, GripVertical, Paperclip, Plus, Settings2, SquareTerminal, Trash2 } from 'lucide-react'
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, sortableKeyboardCoordinates, useSortable, arrayMove, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Button, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, SelectSeparator, Switch, Tooltip, TooltipContent, TooltipTrigger, IconButton, getAgentPanelLabel } from '@slayzone/ui'
import type { PanelConfig, PanelView, WebPanelDefinition, GitTabId, GitTabVisibility } from '@slayzone/task/shared'
import type { TerminalMode, TerminalModeInfo } from '@slayzone/terminal/shared'
import { DEFAULT_PANEL_CONFIG, DEFAULT_GIT_TAB_ORDER, GIT_TAB_LABELS, isGitTabEnabled, isPanelEnabled, inferHostScopeFromUrl, inferProtocolFromUrl, mergePanelOrder, mergePredefinedWebPanels, normalizeDesktopProtocol, normalizeGitTabOrder, normalizeGitTabVisibility, validatePanelShortcut } from '@slayzone/task/shared'
import { getVisibleModes, getModeLabel, groupTerminalModes } from '@slayzone/terminal'
import { SettingsTabIntro } from './SettingsTabIntro'
import { PanelBreadcrumb } from './PanelBreadcrumb'

interface PanelsSettingsTabProps {
  activeTab: string
  navigateTo: (tab: string) => void
  modes: TerminalModeInfo[]
  defaultTerminalMode: TerminalMode
  onDefaultTerminalModeChange: (mode: TerminalMode) => void
}

interface PanelRowDescriptor {
  icon: typeof Globe
  label: string
  homeToggle: { enabled: boolean; onChange: (v: boolean) => void } | null
  taskToggle: { enabled: boolean; onChange: (v: boolean) => void } | null
  onClick?: () => void
  webSubtitle?: string
}

function buildPanelRowDescriptors(
  panelConfig: PanelConfig,
  navigateTo: (tab: string) => void,
  togglePanel: (id: string, view: PanelView, enabled: boolean) => void,
): Map<string, PanelRowDescriptor> {
  const m = new Map<string, PanelRowDescriptor>()
  m.set('terminal', {
    icon: SquareTerminal, label: getAgentPanelLabel(),
    homeToggle: null,
    taskToggle: { enabled: isPanelEnabled(panelConfig, 'terminal', 'task'), onChange: c => togglePanel('terminal', 'task', c) },
    onClick: () => navigateTo('panels/terminal'),
  })
  m.set('browser', {
    icon: Globe, label: 'Browser',
    homeToggle: null,
    taskToggle: { enabled: isPanelEnabled(panelConfig, 'browser', 'task'), onChange: c => togglePanel('browser', 'task', c) },
    onClick: () => navigateTo('panels/browser'),
  })
  m.set('editor', {
    icon: FileCode, label: 'Editor',
    homeToggle: { enabled: isPanelEnabled(panelConfig, 'editor', 'home'), onChange: c => togglePanel('editor', 'home', c) },
    taskToggle: { enabled: isPanelEnabled(panelConfig, 'editor', 'task'), onChange: c => togglePanel('editor', 'task', c) },
    onClick: () => navigateTo('panels/editor'),
  })
  m.set('assets', {
    icon: Paperclip, label: 'Assets',
    homeToggle: null,
    taskToggle: { enabled: isPanelEnabled(panelConfig, 'assets', 'task'), onChange: c => togglePanel('assets', 'task', c) },
  })
  m.set('git', {
    icon: GitCompare, label: 'Git',
    homeToggle: { enabled: isPanelEnabled(panelConfig, 'git', 'home'), onChange: c => togglePanel('git', 'home', c) },
    taskToggle: { enabled: isPanelEnabled(panelConfig, 'diff', 'task'), onChange: c => togglePanel('diff', 'task', c) },
    onClick: () => navigateTo('panels/git'),
  })
  m.set('settings', {
    icon: Settings2, label: 'Settings',
    homeToggle: null,
    taskToggle: { enabled: isPanelEnabled(panelConfig, 'settings', 'task'), onChange: c => togglePanel('settings', 'task', c) },
  })
  m.set('processes', {
    icon: Cpu, label: 'Processes',
    homeToggle: { enabled: isPanelEnabled(panelConfig, 'processes', 'home'), onChange: c => togglePanel('processes', 'home', c) },
    taskToggle: { enabled: isPanelEnabled(panelConfig, 'processes', 'task'), onChange: c => togglePanel('processes', 'task', c) },
  })
  for (const wp of panelConfig.webPanels) {
    m.set(wp.id, {
      icon: Globe, label: wp.name,
      homeToggle: null,
      taskToggle: { enabled: isPanelEnabled(panelConfig, wp.id, 'task'), onChange: c => togglePanel(wp.id, 'task', c) },
      onClick: () => navigateTo(`panels/${wp.id}`),
      webSubtitle: wp.baseUrl,
    })
  }
  return m
}

function SortableGitTabRow({
  id,
  enabled,
  onToggle,
  locked,
  lockedHint,
}: {
  id: GitTabId
  enabled: boolean
  onToggle: (next: boolean) => void
  locked?: boolean
  lockedHint?: string
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }
  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-3 h-9 rounded-md border px-2"
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        className="shrink-0 flex items-center justify-center size-6 text-muted-foreground hover:text-foreground cursor-grab active:cursor-grabbing touch-none"
        aria-label="Drag to reorder"
      >
        <GripVertical className="size-4" />
      </button>
      <span className="text-sm flex-1 min-w-0 truncate">{GIT_TAB_LABELS[id]}</span>
      {locked
        ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span><Switch disabled checked /></span>
            </TooltipTrigger>
            <TooltipContent side="top">{lockedHint ?? 'Always visible'}</TooltipContent>
          </Tooltip>
        )
        : <Switch checked={enabled} onCheckedChange={onToggle} />
      }
    </div>
  )
}

function SortablePanelRow({ id, descriptor }: { id: string; descriptor: PanelRowDescriptor }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }
  const Icon = descriptor.icon
  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-3 h-11 rounded-lg border px-2 w-full text-left hover:bg-accent/30 transition-colors"
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        className="shrink-0 flex items-center justify-center size-6 text-muted-foreground hover:text-foreground cursor-grab active:cursor-grabbing touch-none"
        aria-label="Drag to reorder"
        onClick={(e) => e.stopPropagation()}
      >
        <GripVertical className="size-4" />
      </button>
      <button
        type="button"
        onClick={descriptor.onClick ?? (() => {})}
        disabled={!descriptor.onClick}
        className="flex items-center gap-3 flex-1 min-w-0 text-left disabled:cursor-default"
      >
        <Icon className="size-4 shrink-0" />
        <span className="text-sm font-medium truncate">{descriptor.label}</span>
        {descriptor.webSubtitle && (
          <span className="text-xs text-muted-foreground truncate flex-1">{descriptor.webSubtitle}</span>
        )}
      </button>
      {descriptor.webSubtitle && (
        <span className="shrink-0 px-1.5 py-0.5 rounded-full border border-border text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
          External
        </span>
      )}
      <div className="flex items-center gap-5 shrink-0 pr-2">
        {descriptor.homeToggle
          ? <Switch checked={descriptor.homeToggle.enabled} onCheckedChange={descriptor.homeToggle.onChange} onClick={(e) => e.stopPropagation()} />
          : <Tooltip><TooltipTrigger asChild><span><Switch disabled checked={false} onClick={(e) => e.stopPropagation()} /></span></TooltipTrigger><TooltipContent side="top">Task-only panel</TooltipContent></Tooltip>
        }
        {descriptor.taskToggle
          ? <Switch checked={descriptor.taskToggle.enabled} onCheckedChange={descriptor.taskToggle.onChange} onClick={(e) => e.stopPropagation()} />
          : <span className="w-8" />
        }
      </div>
      {descriptor.onClick
        ? <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
        : <span className="w-3.5" />}
    </div>
  )
}

export function PanelsSettingsTab({ activeTab, navigateTo, modes, defaultTerminalMode, onDefaultTerminalModeChange }: PanelsSettingsTabProps) {
  const [panelConfig, setPanelConfig] = useState<PanelConfig>(DEFAULT_PANEL_CONFIG)
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  const [terminalFontFamily, setTerminalFontFamily] = useState('Menlo, Monaco, "Courier New", monospace')
  const [terminalScrollback, setTerminalScrollback] = useState('5000')
  
  // Editor
  const [editorWordWrap, setEditorWordWrap] = useState<'on' | 'off'>('off')
  const [editorRenderWhitespace, setEditorRenderWhitespace] = useState<'none' | 'all'>('none')
  const [editorTabSize, setEditorTabSize] = useState<'2' | '4'>('2')
  const [editorIndentTabs, setEditorIndentTabs] = useState(false)
  const [editorMarkdownViewMode, setEditorMarkdownViewMode] = useState<'rich' | 'split' | 'code'>('rich')
  
  // Diff
  const [diffContextLines, setDiffContextLines] = useState<'0' | '3' | '5' | 'all'>('3')
  const [diffIgnoreWhitespace, setDiffIgnoreWhitespace] = useState(false)
  const [diffContinuousFlow, setDiffContinuousFlow] = useState(false)
  const [diffTreeCollapsed, setDiffTreeCollapsed] = useState(false)
  const [diffSideBySide, setDiffSideBySide] = useState(false)
  const [diffWrap, setDiffWrap] = useState(false)

  // Commit graph defaults
  const [graphCollapsed, setGraphCollapsed] = useState(false)
  const [graphShowBranches, setGraphShowBranches] = useState(true)
  const [graphBreakOnTags, setGraphBreakOnTags] = useState(true)
  const [graphBreakOnMerges, setGraphBreakOnMerges] = useState(true)

  // Git sub-tab order + visibility
  const [gitTabOrder, setGitTabOrder] = useState<GitTabId[]>(() => [...DEFAULT_GIT_TAB_ORDER])
  const [gitTabVisibility, setGitTabVisibility] = useState<GitTabVisibility>({})
  
  // Browser
  const [devServerToastEnabled, setDevServerToastEnabled] = useState(true)
  const [devServerAutoOpenBrowser, setDevServerAutoOpenBrowser] = useState(false)
  const [browserDefaultUrl, setBrowserDefaultUrl] = useState('')
  const [browserDefaultZoom, setBrowserDefaultZoom] = useState('100')
  const [browserDevices, setBrowserDevices] = useState({
    desktop: { enabled: true, width: '1920', height: '1080' },
    tablet: { enabled: true, width: '744', height: '1133' },
    mobile: { enabled: true, width: '393', height: '852' },
  })

  // New panel state
  const [newPanelName, setNewPanelName] = useState('')
  const [newPanelUrl, setNewPanelUrl] = useState('')
  const [newPanelShortcut, setNewPanelShortcut] = useState('')
  const [newPanelBlockDesktopHandoff, setNewPanelBlockDesktopHandoff] = useState(false)
  const [newPanelHandoffProtocol, setNewPanelHandoffProtocol] = useState('')
  const [newPanelProtocolError, setNewPanelProtocolError] = useState('')
  const [panelShortcutError, setPanelShortcutError] = useState('')

  // Edit panel state
  const [editPanelName, setEditPanelName] = useState('')
  const [editPanelUrl, setEditPanelUrl] = useState('')
  const [editPanelShortcut, setEditPanelShortcut] = useState('')
  const [editPanelBlockDesktopHandoff, setEditPanelBlockDesktopHandoff] = useState(false)
  const [editPanelHandoffProtocol, setEditPanelHandoffProtocol] = useState('')
  const [editPanelProtocolError, setEditPanelProtocolError] = useState('')
  const [editShortcutError, setEditShortcutError] = useState('')

  useEffect(() => {
    Promise.all([
      window.api.settings.get('panel_config'),
      window.api.settings.get('terminal_font_family'),
      window.api.settings.get('terminal_scrollback'),
      window.api.settings.get('editor_word_wrap'),
      window.api.settings.get('editor_render_whitespace'),
      window.api.settings.get('editor_tab_size'),
      window.api.settings.get('editor_indent_tabs'),
      window.api.settings.get('diff_context_lines'),
      window.api.settings.get('diff_ignore_whitespace'),
      window.api.settings.get('diff_continuous_flow'),
      window.api.settings.get('diff_tree_collapsed'),
      window.api.settings.get('diff_side_by_side'),
      window.api.settings.get('diff_wrap'),
      window.api.settings.get('dev_server_toast_enabled'),
      window.api.settings.get('dev_server_auto_open_browser'),
      window.api.settings.get('browser_default_url'),
      window.api.settings.get('browser_default_zoom'),
      window.api.settings.get('browser_default_devices'),
      window.api.settings.get('commit_graph_config'),
      window.api.settings.get('editor_markdown_view_mode'),
      window.api.settings.get('git_tab_order'),
      window.api.settings.get('git_tab_visibility'),
    ]).then(([pc, tff, ts, eww, erw, ets, eit, dcl, diw, dcf, dtc, dsbs, dwr, dste, dsaob, bdu, bdz, bdd, cgc, emvm, gto, gtv]) => {
      if (pc) setPanelConfig(mergePanelOrder(mergePredefinedWebPanels(JSON.parse(pc) as PanelConfig)))
      if (tff) setTerminalFontFamily(tff)
      if (ts) setTerminalScrollback(ts)
      if (eww === 'on') setEditorWordWrap('on')
      if (erw === 'all') setEditorRenderWhitespace('all')
      if (ets === '4') setEditorTabSize('4')
      if (eit === '1') setEditorIndentTabs(true)
      if (dcl) setDiffContextLines(dcl as any)
      if (diw === '1') setDiffIgnoreWhitespace(true)
      if (dcf === '1') setDiffContinuousFlow(true)
      if (dtc === '1') setDiffTreeCollapsed(true)
      if (dsbs === '1') setDiffSideBySide(true)
      if (dwr === '1') setDiffWrap(true)
      if (dste === '0') setDevServerToastEnabled(false)
      if (dsaob === '1') setDevServerAutoOpenBrowser(true)
      if (bdu) setBrowserDefaultUrl(bdu)
      if (bdz) setBrowserDefaultZoom(bdz)
      if (bdd) {
        try {
          const d = JSON.parse(bdd)
          setBrowserDevices({
            desktop: d.desktop ? { enabled: d.desktop.enabled !== false, width: String(d.desktop.width), height: String(d.desktop.height) } : { enabled: true, width: '1920', height: '1080' },
            tablet: d.tablet ? { enabled: d.tablet.enabled !== false, width: String(d.tablet.width), height: String(d.tablet.height) } : { enabled: true, width: '744', height: '1133' },
            mobile: d.mobile ? { enabled: d.mobile.enabled !== false, width: String(d.mobile.width), height: String(d.mobile.height) } : { enabled: true, width: '393', height: '852' },
          })
        } catch { /* ignore */ }
      }
      if (cgc) {
        try {
          const g = JSON.parse(cgc)
          if (g.collapsed !== undefined) setGraphCollapsed(g.collapsed)
          if (g.showBranches !== undefined) setGraphShowBranches(g.showBranches)
          if (g.breakOnTags !== undefined) setGraphBreakOnTags(g.breakOnTags)
          if (g.breakOnMerges !== undefined) setGraphBreakOnMerges(g.breakOnMerges)
        } catch { /* ignore */ }
      }
      if (emvm === 'split' || emvm === 'code') setEditorMarkdownViewMode(emvm)
      setGitTabOrder(normalizeGitTabOrder(gto))
      setGitTabVisibility(normalizeGitTabVisibility(gtv))
    })

    const cleanupIpc = window.api?.app?.onSettingsChanged?.(() => {
      window.api.settings.get('panel_config').then(pc => {
        if (pc) setPanelConfig(mergePanelOrder(mergePredefinedWebPanels(JSON.parse(pc) as PanelConfig)))
      })
    })
    return () => { cleanupIpc?.() }
  }, [])

  useEffect(() => {
    if (!activeTab.startsWith('panels/web:')) return
    const wpId = activeTab.slice(7)
    const wp = panelConfig.webPanels.find(p => p.id === wpId)
    if (wp) {
      setEditPanelName(wp.name)
      setEditPanelUrl(wp.baseUrl)
      setEditPanelShortcut(wp.shortcut || '')
      setEditPanelBlockDesktopHandoff(wp.blockDesktopHandoff ?? false)
      setEditPanelHandoffProtocol(wp.handoffProtocol ?? inferProtocolFromUrl(wp.baseUrl) ?? '')
      setEditPanelProtocolError('')
      setEditShortcutError('')
    }
  }, [activeTab, panelConfig])

  const savePanelConfig = async (next: PanelConfig) => {
    setPanelConfig(next)
    await window.api.settings.set('panel_config', JSON.stringify(next))
    window.dispatchEvent(new CustomEvent('panel-config-changed'))
  }

  const togglePanel = (id: string, view: PanelView, enabled: boolean) => {
    savePanelConfig({
      ...panelConfig,
      viewEnabled: {
        ...panelConfig.viewEnabled,
        [view]: { ...panelConfig.viewEnabled?.[view], [id]: enabled },
      },
    })
  }

  const validateShortcut = (letter: string, excludeId?: string): string | null =>
    validatePanelShortcut(letter, panelConfig.webPanels, excludeId)

  const handleAddCustomPanel = async () => {
    if (!newPanelName.trim() || !newPanelUrl.trim()) return
    const shortcutErr = validateShortcut(newPanelShortcut)
    if (shortcutErr) { setPanelShortcutError(shortcutErr); return }

    let url = newPanelUrl.trim()
    if (!url.startsWith('http://') && !url.startsWith('https://')) url = `https://${url}`
    const handoffProtocol = newPanelBlockDesktopHandoff ? (normalizeDesktopProtocol(newPanelHandoffProtocol) ?? inferProtocolFromUrl(url)) : null
    if (newPanelBlockDesktopHandoff && !handoffProtocol) {
      setNewPanelProtocolError('Enter a valid protocol (for example: figma)')
      return
    }
    setNewPanelProtocolError('')

    const newPanel: WebPanelDefinition = {
      id: `web:${crypto.randomUUID().slice(0, 8)}`,
      name: newPanelName.trim(),
      baseUrl: url,
      shortcut: newPanelShortcut.trim().toLowerCase() || undefined,
      blockDesktopHandoff: newPanelBlockDesktopHandoff,
      handoffProtocol: handoffProtocol ?? undefined,
      handoffHostScope: newPanelBlockDesktopHandoff ? (inferHostScopeFromUrl(url) ?? undefined) : undefined,
    }

    await savePanelConfig({ ...panelConfig, webPanels: [...panelConfig.webPanels, newPanel] })
    setNewPanelName(''); setNewPanelUrl(''); setNewPanelShortcut(''); setNewPanelBlockDesktopHandoff(false); setNewPanelHandoffProtocol('');
  }

  const handleDeleteWebPanel = async (id: string) => {
    const wp = panelConfig.webPanels.find(p => p.id === id)
    const next: PanelConfig = { ...panelConfig, webPanels: panelConfig.webPanels.filter(p => p.id !== id) }
    if (wp?.predefined) next.deletedPredefined = [...(panelConfig.deletedPredefined ?? []), id]
    await savePanelConfig(next)
    if (activeTab === `panels/${id}`) navigateTo('panels')
  }

  const handleSaveEditPanel = async (panelId: string) => {
    if (!panelId || !editPanelName.trim() || !editPanelUrl.trim()) return
    const shortcutErr = editPanelShortcut ? validateShortcut(editPanelShortcut, panelId) : null
    if (shortcutErr) { setEditShortcutError(shortcutErr); return }

    let url = editPanelUrl.trim()
    if (!url.startsWith('http://') && !url.startsWith('https://')) url = `https://${url}`
    const handoffProtocol = editPanelBlockDesktopHandoff ? (normalizeDesktopProtocol(editPanelHandoffProtocol) ?? inferProtocolFromUrl(url)) : null
    if (editPanelBlockDesktopHandoff && !handoffProtocol) {
      setEditPanelProtocolError('Enter a valid protocol')
      return
    }
    setEditPanelProtocolError('')

    await savePanelConfig({
      ...panelConfig,
      webPanels: panelConfig.webPanels.map(wp =>
        wp.id === panelId
          ? {
            ...wp,
            name: editPanelName.trim(),
            baseUrl: url,
            shortcut: editPanelShortcut.trim().toLowerCase() || undefined,
            blockDesktopHandoff: editPanelBlockDesktopHandoff,
            handoffProtocol: editPanelBlockDesktopHandoff ? (handoffProtocol ?? wp.handoffProtocol) : wp.handoffProtocol,
            handoffHostScope: editPanelBlockDesktopHandoff ? (inferHostScopeFromUrl(url) ?? wp.handoffHostScope) : wp.handoffHostScope,
          }
          : wp
      )
    })
  }

  const updateBrowserDevice = (slot: 'desktop' | 'tablet' | 'mobile', field: string, value: string | boolean) => {
    setBrowserDevices(prev => {
      const next = { ...prev, [slot]: { ...prev[slot], [field]: value } }
      const persist = {
        desktop: { enabled: next.desktop.enabled, width: parseInt(next.desktop.width, 10) || 1920, height: parseInt(next.desktop.height, 10) || 1080 },
        tablet: { enabled: next.tablet.enabled, width: parseInt(next.tablet.width, 10) || 744, height: parseInt(next.tablet.height, 10) || 1133 },
        mobile: { enabled: next.mobile.enabled, width: parseInt(next.mobile.width, 10) || 393, height: parseInt(next.mobile.height, 10) || 852 },
      }
      window.api.settings.set('browser_default_devices', JSON.stringify(persist))
      return next
    })
  }

  const panelDetailId = activeTab.startsWith('panels/') ? activeTab.slice(7) : null

  return (
    <>
      <SettingsTabIntro title="Panels" description="Choose which panels are available per view." />

      {activeTab === 'panels' && (() => {
        const rowDescriptors = buildPanelRowDescriptors(panelConfig, navigateTo, togglePanel)
        const orderedIds = (panelConfig.order ?? []).filter(id => rowDescriptors.has(id))
        const handleDragEnd = (e: DragEndEvent) => {
          const { active, over } = e
          if (!over || active.id === over.id) return
          const oldIdx = orderedIds.indexOf(String(active.id))
          const newIdx = orderedIds.indexOf(String(over.id))
          if (oldIdx < 0 || newIdx < 0) return
          const nextOrdered = arrayMove(orderedIds, oldIdx, newIdx)
          const next = [...nextOrdered, ...(panelConfig.order ?? []).filter(id => !rowDescriptors.has(id))]
          savePanelConfig({ ...panelConfig, order: next })
        }
        return (
          <div className="space-y-6">
            <div className="space-y-3">
              <div className="flex items-center gap-3 px-4">
                <span className="w-3.5" />
                <Label className="text-base font-semibold flex-1">Panels</Label>
                <div className="flex items-center gap-5 shrink-0">
                  <span className="text-[10px] font-medium text-muted-foreground w-8 text-center">Home</span>
                  <span className="text-[10px] font-medium text-muted-foreground w-8 text-center">Task</span>
                </div>
                <span className="w-3.5" />
              </div>
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                <SortableContext items={orderedIds} strategy={verticalListSortingStrategy}>
                  <div className="space-y-2">
                    {orderedIds.map(id => {
                      const d = rowDescriptors.get(id)!
                      return <SortablePanelRow key={id} id={id} descriptor={d} />
                    })}
                  </div>
                </SortableContext>
              </DndContext>
            </div>

            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Label className="text-base font-semibold">Add external panel</Label>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <IconButton variant="ghost" size="icon-sm" aria-label="About external panels" className="text-muted-foreground/50">
                      <Plus className="size-3" />
                    </IconButton>
                  </TooltipTrigger>
                  <TooltipContent side="right" className="max-w-64">
                    Web views embedded as panels inside tasks.
                  </TooltipContent>
                </Tooltip>
              </div>
              <div className="grid grid-cols-[1fr_1fr_80px] gap-2">
                <Input placeholder="Name" value={newPanelName} onChange={(e) => setNewPanelName(e.target.value)} />
                <Input placeholder="URL" value={newPanelUrl} onChange={(e) => setNewPanelUrl(e.target.value)} />
                <Input placeholder="Key" maxLength={1} value={newPanelShortcut} onChange={(e) => setNewPanelShortcut(e.target.value.slice(-1))} />
              </div>
              {panelShortcutError && <p className="text-xs text-destructive">{panelShortcutError}</p>}
              <label className="flex items-center gap-2 text-xs cursor-pointer">
                <input type="checkbox" checked={newPanelBlockDesktopHandoff} onChange={(e) => { setNewPanelBlockDesktopHandoff(e.target.checked); if (e.target.checked && !newPanelHandoffProtocol.trim()) setNewPanelHandoffProtocol(inferProtocolFromUrl(newPanelUrl) ?? ''); if (!e.target.checked) setNewPanelProtocolError('') }} />
                <span className="text-muted-foreground">Block desktop app handoff links</span>
              </label>
              {newPanelBlockDesktopHandoff && (
                <div className="space-y-1">
                  <Input placeholder="Protocol (e.g. figma)" value={newPanelHandoffProtocol} onChange={(e) => { setNewPanelHandoffProtocol(e.target.value); setNewPanelProtocolError('') }} />
                </div>
              )}
              {newPanelProtocolError && <p className="text-xs text-destructive">{newPanelProtocolError}</p>}
              <Button size="sm" onClick={handleAddCustomPanel} disabled={!newPanelName.trim() || !newPanelUrl.trim()}><Plus className="size-3.5 mr-1" /> Add Panel</Button>
            </div>
          </div>
        )
      })()}

      {activeTab === 'panels/terminal' && (
        <div className="rounded-lg border p-5 space-y-6">
          <PanelBreadcrumb label={getAgentPanelLabel()} onBack={() => navigateTo('panels')} />
          <div className="flex items-center justify-between">
            <Label className="text-base font-semibold">{getAgentPanelLabel()}</Label>
            <Switch checked={isPanelEnabled(panelConfig, 'terminal', 'task')} onCheckedChange={(c) => togglePanel('terminal', 'task', c)} />
          </div>
          <div className="space-y-3">
            <Label className="text-sm font-medium">Default mode</Label>
            <Select value={defaultTerminalMode} onValueChange={(v) => onDefaultTerminalModeChange(v as TerminalMode)}>
              <SelectTrigger className="max-w-sm"><SelectValue /></SelectTrigger>
              <SelectContent position="popper" align="start" className="min-w-[var(--radix-select-trigger-width)] max-h-none">
                {(() => {
                  const visibleModes = getVisibleModes(modes, defaultTerminalMode)
                  const { builtin, custom } = groupTerminalModes(visibleModes)
                  return (
                    <>
                      {builtin.map(m => <SelectItem key={m.id} value={m.id}>{getModeLabel(m)}</SelectItem>)}
                      {custom.length > 0 && builtin.length > 0 && <SelectSeparator />}
                      {custom.map(m => <SelectItem key={m.id} value={m.id}>{getModeLabel(m)}</SelectItem>)}
                    </>
                  )
                })()}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-[180px_minmax(0,1fr)] items-center gap-3">
            <span className="text-sm text-muted-foreground">Font family</span>
            <Input value={terminalFontFamily} onChange={(e) => setTerminalFontFamily(e.target.value)} onBlur={() => window.api.settings.set('terminal_font_family', terminalFontFamily.trim())} />
          </div>
          <div className="grid grid-cols-[180px_minmax(0,1fr)] items-center gap-3">
            <span className="text-sm text-muted-foreground">Scrollback</span>
            <Input className="max-w-32" type="number" value={terminalScrollback} onChange={(e) => setTerminalScrollback(e.target.value)} onBlur={() => { const n = parseInt(terminalScrollback, 10); if (n >= 0) window.api.settings.set('terminal_scrollback', String(n)) }} />
          </div>
        </div>
      )}

      {activeTab === 'panels/browser' && (
        <div className="rounded-lg border p-5 space-y-6">
          <PanelBreadcrumb label="Browser" onBack={() => navigateTo('panels')} />
          <div className="flex items-center justify-between">
            <Label className="text-base font-semibold">Browser</Label>
            <Switch checked={isPanelEnabled(panelConfig, 'browser', 'task')} onCheckedChange={(c) => togglePanel('browser', 'task', c)} />
          </div>
          <div className="space-y-3">
            <Label className="text-sm font-medium">Dev server</Label>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input type="checkbox" checked={devServerToastEnabled} onChange={(e) => { setDevServerToastEnabled(e.target.checked); window.api.settings.set('dev_server_toast_enabled', e.target.checked ? '1' : '0') }} />
              <span>Show toast when detected</span>
            </label>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input type="checkbox" checked={devServerAutoOpenBrowser} onChange={(e) => { setDevServerAutoOpenBrowser(e.target.checked); window.api.settings.set('dev_server_auto_open_browser', e.target.checked ? '1' : '0') }} />
              <span>Auto-open when detected</span>
            </label>
          </div>
          <div className="grid grid-cols-[180px_minmax(0,1fr)] items-center gap-3">
            <span className="text-sm text-muted-foreground">Default URL</span>
            <Input value={browserDefaultUrl} onChange={(e) => setBrowserDefaultUrl(e.target.value)} onBlur={() => window.api.settings.set('browser_default_url', browserDefaultUrl.trim())} />
          </div>
          <div className="grid grid-cols-[180px_minmax(0,1fr)] items-center gap-3">
            <span className="text-sm text-muted-foreground">Default zoom</span>
            <Input className="max-w-24" type="number" value={browserDefaultZoom} onChange={(e) => setBrowserDefaultZoom(e.target.value)} onBlur={() => { const n = parseInt(browserDefaultZoom, 10); if (n >= 50 && n <= 200) window.api.settings.set('browser_default_zoom', String(n)) }} />
          </div>
          <div className="space-y-3">
            <Label className="text-sm font-medium">Device defaults</Label>
            {(['desktop', 'tablet', 'mobile'] as const).map(slot => (
              <div key={slot} className="grid grid-cols-[180px_minmax(0,1fr)] items-center gap-3">
                <span className="text-sm text-muted-foreground capitalize">{slot}</span>
                <div className="flex items-center gap-2">
                  <Switch checked={browserDevices[slot].enabled} onCheckedChange={(c) => updateBrowserDevice(slot, 'enabled', c)} />
                  <Input className="max-w-20" type="number" value={browserDevices[slot].width} onChange={(e) => setBrowserDevices(prev => ({ ...prev, [slot]: { ...prev[slot], width: e.target.value } }))} onBlur={() => updateBrowserDevice(slot, 'width', browserDevices[slot].width)} />
                  <span className="text-xs">×</span>
                  <Input className="max-w-20" type="number" value={browserDevices[slot].height} onChange={(e) => setBrowserDevices(prev => ({ ...prev, [slot]: { ...prev[slot], height: e.target.value } }))} onBlur={() => updateBrowserDevice(slot, 'height', browserDevices[slot].height)} />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {activeTab === 'panels/editor' && (
        <div className="rounded-lg border p-5 space-y-6">
          <PanelBreadcrumb label="Editor" onBack={() => navigateTo('panels')} />
          <div className="flex items-center justify-between">
            <Label className="text-base font-semibold">Editor</Label>
            <Switch checked={isPanelEnabled(panelConfig, 'editor', 'task')} onCheckedChange={(c) => togglePanel('editor', 'task', c)} />
          </div>
          <div className="grid grid-cols-[180px_minmax(0,1fr)] items-center gap-3">
            <span className="text-sm text-muted-foreground">Word wrap</span>
            <Switch checked={editorWordWrap === 'on'} onCheckedChange={(c) => { const v = c ? 'on' : 'off'; setEditorWordWrap(v); window.api.settings.set('editor_word_wrap', v) }} />
          </div>
          <div className="grid grid-cols-[180px_minmax(0,1fr)] items-center gap-3">
            <span className="text-sm text-muted-foreground">Show whitespace</span>
            <Switch checked={editorRenderWhitespace === 'all'} onCheckedChange={(c) => { const v = c ? 'all' : 'none'; setEditorRenderWhitespace(v); window.api.settings.set('editor_render_whitespace', v) }} />
          </div>
          <div className="grid grid-cols-[180px_minmax(0,1fr)] items-center gap-3">
            <span className="text-sm text-muted-foreground">Tab size</span>
            <Select value={editorTabSize} onValueChange={(v) => { setEditorTabSize(v as any); window.api.settings.set('editor_tab_size', v) }}>
              <SelectTrigger className="max-w-24"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="2">2</SelectItem><SelectItem value="4">4</SelectItem></SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-[180px_minmax(0,1fr)] items-center gap-3">
            <span className="text-sm text-muted-foreground">Indent with tabs</span>
            <Switch checked={editorIndentTabs} onCheckedChange={(c) => { setEditorIndentTabs(c); window.api.settings.set('editor_indent_tabs', c ? '1' : '0') }} />
          </div>
          <div className="grid grid-cols-[180px_minmax(0,1fr)] items-center gap-3">
            <span className="text-sm text-muted-foreground">Markdown default</span>
            <Select value={editorMarkdownViewMode} onValueChange={(v) => { setEditorMarkdownViewMode(v as any); window.api.settings.set('editor_markdown_view_mode', v); window.dispatchEvent(new Event('sz:settings-changed')) }}>
              <SelectTrigger className="max-w-32"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="rich">Rich text</SelectItem><SelectItem value="split">Split</SelectItem><SelectItem value="code">Source code</SelectItem></SelectContent>
            </Select>
          </div>
        </div>
      )}

      {activeTab === 'panels/diff' && (
        <div className="rounded-lg border p-5 space-y-6">
          <PanelBreadcrumb label="Diff" onBack={() => navigateTo('panels')} />
          <div className="flex items-center justify-between">
            <Label className="text-base font-semibold">Diff</Label>
            <Switch checked={isPanelEnabled(panelConfig, 'diff', 'task')} onCheckedChange={(c) => togglePanel('diff', 'task', c)} />
          </div>
          <div className="grid grid-cols-[180px_minmax(0,1fr)] items-center gap-3">
            <span className="text-sm text-muted-foreground">Context lines</span>
            <Select value={diffContextLines} onValueChange={(v) => { setDiffContextLines(v as any); window.api.settings.set('diff_context_lines', v) }}>
              <SelectTrigger className="max-w-32"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="0">0</SelectItem><SelectItem value="3">3</SelectItem><SelectItem value="5">5</SelectItem><SelectItem value="all">All</SelectItem></SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-[180px_minmax(0,1fr)] items-center gap-3">
            <span className="text-sm text-muted-foreground">Ignore whitespace</span>
            <Switch checked={diffIgnoreWhitespace} onCheckedChange={(c) => { setDiffIgnoreWhitespace(c); window.api.settings.set('diff_ignore_whitespace', c ? '1' : '0') }} />
          </div>
          <div className="grid grid-cols-[180px_minmax(0,1fr)] items-center gap-3">
            <span className="text-sm text-muted-foreground">Continuous flow</span>
            <Switch checked={diffContinuousFlow} onCheckedChange={(c) => { setDiffContinuousFlow(c); window.api.settings.set('diff_continuous_flow', c ? '1' : '0'); window.dispatchEvent(new Event('sz:settings-changed')) }} />
          </div>
          <div className="grid grid-cols-[180px_minmax(0,1fr)] items-center gap-3">
            <span className="text-sm text-muted-foreground">Hide file tree</span>
            <Switch checked={diffTreeCollapsed} onCheckedChange={(c) => { setDiffTreeCollapsed(c); window.api.settings.set('diff_tree_collapsed', c ? '1' : '0'); window.dispatchEvent(new Event('sz:settings-changed')) }} />
          </div>
          <div className="grid grid-cols-[180px_minmax(0,1fr)] items-center gap-3">
            <span className="text-sm text-muted-foreground">Side-by-side</span>
            <Switch checked={diffSideBySide} onCheckedChange={(c) => { setDiffSideBySide(c); window.api.settings.set('diff_side_by_side', c ? '1' : '0'); window.dispatchEvent(new Event('sz:settings-changed')) }} />
          </div>
          <div className="grid grid-cols-[180px_minmax(0,1fr)] items-center gap-3">
            <span className="text-sm text-muted-foreground">Wrap lines</span>
            <Switch checked={diffWrap} onCheckedChange={(c) => { setDiffWrap(c); window.api.settings.set('diff_wrap', c ? '1' : '0'); window.dispatchEvent(new Event('sz:settings-changed')) }} />
          </div>
        </div>
      )}

      {activeTab === 'panels/git' && (() => {
        const saveGraphConfig = (patch: Record<string, unknown>) => {
          const next = { collapsed: graphCollapsed, showBranches: graphShowBranches, breakOnTags: graphBreakOnTags, breakOnMerges: graphBreakOnMerges, ...patch }
          if ('collapsed' in patch) setGraphCollapsed(next.collapsed as boolean)
          if ('showBranches' in patch) setGraphShowBranches(next.showBranches as boolean)
          if ('breakOnTags' in patch) setGraphBreakOnTags(next.breakOnTags as boolean)
          if ('breakOnMerges' in patch) setGraphBreakOnMerges(next.breakOnMerges as boolean)
          window.api.settings.set('commit_graph_config', JSON.stringify(next))
        }
        const handleGitTabDragEnd = (e: DragEndEvent) => {
          const { active, over } = e
          if (!over || active.id === over.id) return
          const oldIdx = gitTabOrder.indexOf(active.id as GitTabId)
          const newIdx = gitTabOrder.indexOf(over.id as GitTabId)
          if (oldIdx < 0 || newIdx < 0) return
          const next = arrayMove(gitTabOrder, oldIdx, newIdx)
          setGitTabOrder(next)
          window.api.settings.set('git_tab_order', JSON.stringify(next))
          window.dispatchEvent(new Event('sz:settings-changed'))
        }
        const toggleGitTab = (id: GitTabId, enabled: boolean) => {
          const next: GitTabVisibility = { ...gitTabVisibility, [id]: enabled }
          setGitTabVisibility(next)
          window.api.settings.set('git_tab_visibility', JSON.stringify(next))
          window.dispatchEvent(new Event('sz:settings-changed'))
        }
        return (
          <div className="rounded-lg border p-5 space-y-6">
            <PanelBreadcrumb label="Git" onBack={() => navigateTo('panels')} />

            {/* Tabs — order + visibility */}
            <div>
              <Label className="text-base font-semibold">Tabs</Label>
              <p className="text-xs text-muted-foreground mt-1">Drag to reorder. Toggle to show/hide. Conflicts tab always appears when a merge/rebase is in progress.</p>
              <div className="mt-3">
                <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleGitTabDragEnd}>
                  <SortableContext items={gitTabOrder} strategy={verticalListSortingStrategy}>
                    <div className="space-y-1.5">
                      {gitTabOrder.map(id => (
                        <SortableGitTabRow
                          key={id}
                          id={id}
                          enabled={isGitTabEnabled(gitTabVisibility, id)}
                          onToggle={(v) => toggleGitTab(id, v)}
                          locked={id === 'conflicts'}
                          lockedHint="Shown automatically during merge conflicts"
                        />
                      ))}
                    </div>
                  </SortableContext>
                </DndContext>
              </div>
            </div>

            <div className="h-px bg-border" />

            {/* Diff settings */}
            <div>
              <Label className="text-base font-semibold">Diff</Label>
              <div className="mt-3 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Enabled</span>
                  <Switch checked={isPanelEnabled(panelConfig, 'diff', 'task')} onCheckedChange={(c) => togglePanel('diff', 'task', c)} />
                </div>
                <div className="grid grid-cols-[180px_minmax(0,1fr)] items-center gap-3">
                  <span className="text-sm text-muted-foreground">Context lines</span>
                  <Select value={diffContextLines} onValueChange={(v) => { setDiffContextLines(v as any); window.api.settings.set('diff_context_lines', v) }}>
                    <SelectTrigger className="max-w-32"><SelectValue /></SelectTrigger>
                    <SelectContent><SelectItem value="0">0</SelectItem><SelectItem value="3">3</SelectItem><SelectItem value="5">5</SelectItem><SelectItem value="all">All</SelectItem></SelectContent>
                  </Select>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Ignore whitespace</span>
                  <Switch checked={diffIgnoreWhitespace} onCheckedChange={(c) => { setDiffIgnoreWhitespace(c); window.api.settings.set('diff_ignore_whitespace', c ? '1' : '0') }} />
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Continuous flow</span>
                  <Switch checked={diffContinuousFlow} onCheckedChange={(c) => { setDiffContinuousFlow(c); window.api.settings.set('diff_continuous_flow', c ? '1' : '0'); window.dispatchEvent(new Event('sz:settings-changed')) }} />
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Hide file tree</span>
                  <Switch checked={diffTreeCollapsed} onCheckedChange={(c) => { setDiffTreeCollapsed(c); window.api.settings.set('diff_tree_collapsed', c ? '1' : '0'); window.dispatchEvent(new Event('sz:settings-changed')) }} />
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Side-by-side</span>
                  <Switch checked={diffSideBySide} onCheckedChange={(c) => { setDiffSideBySide(c); window.api.settings.set('diff_side_by_side', c ? '1' : '0'); window.dispatchEvent(new Event('sz:settings-changed')) }} />
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Wrap lines</span>
                  <Switch checked={diffWrap} onCheckedChange={(c) => { setDiffWrap(c); window.api.settings.set('diff_wrap', c ? '1' : '0'); window.dispatchEvent(new Event('sz:settings-changed')) }} />
                </div>
              </div>
            </div>

            <div className="h-px bg-border" />

            {/* Commit graph defaults — matches DisplayPopover layout */}
            <div>
              <Label className="text-base font-semibold">Commit graph</Label>
              <p className="text-xs text-muted-foreground mt-1">Default display settings. Each task and project can override these.</p>
              <div className="mt-3 space-y-3">
                {/* View mode toggle — same as popover */}
                <div className="grid grid-cols-2 rounded-md border border-border/50 p-0.5 gap-0.5">
                  {([
                    { value: false, label: 'All commits' },
                    { value: true, label: 'Collapsed' }
                  ] as const).map(({ value, label }) => {
                    const isActive = graphCollapsed === value
                    return (
                      <button
                        key={label}
                        type="button"
                        className={`flex items-center justify-center gap-1.5 py-2 text-xs font-medium rounded transition-colors ${
                          isActive
                            ? 'bg-foreground text-background'
                            : 'text-muted-foreground hover:text-foreground hover:bg-accent'
                        }`}
                        onClick={() => saveGraphConfig({ collapsed: value })}
                      >
                        {label}
                      </button>
                    )
                  })}
                </div>

                <div className="h-px bg-border" />

                <div className="flex items-center justify-between">
                  <span className="text-sm">Show branches</span>
                  <Switch checked={graphShowBranches} onCheckedChange={(c) => saveGraphConfig({ showBranches: c })} />
                </div>
                {graphCollapsed && (<>
                  <div className="flex items-center justify-between">
                    <span className="text-sm">Break on tags</span>
                    <Switch checked={graphBreakOnTags} onCheckedChange={(c) => saveGraphConfig({ breakOnTags: c })} />
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm">Break on merges</span>
                    <Switch checked={graphBreakOnMerges} onCheckedChange={(c) => saveGraphConfig({ breakOnMerges: c })} />
                  </div>
                </>)}
              </div>
            </div>
          </div>
        )
      })()}

      {panelDetailId && panelDetailId.startsWith('web:') && (() => {
        const wp = panelConfig.webPanels.find(p => p.id === panelDetailId)
        if (!wp) return null
        return (
          <div className="rounded-lg border p-5 space-y-6">
            <PanelBreadcrumb label={wp.name} onBack={() => navigateTo('panels')} />
            <div className="flex items-center justify-between">
              <Label className="text-base font-semibold">{wp.name}</Label>
              <Switch checked={isPanelEnabled(panelConfig, wp.id, 'task')} onCheckedChange={(c) => togglePanel(wp.id, 'task', c)} />
            </div>
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
              <Input className="max-w-20" placeholder="Key" maxLength={1} value={editPanelShortcut} onChange={(e) => { const v = e.target.value.slice(-1); setEditPanelShortcut(v); setEditShortcutError(validateShortcut(v, panelDetailId!) || '') }} />
            </div>
            {editShortcutError && <p className="text-xs text-destructive">{editShortcutError}</p>}
            <div className="grid grid-cols-[180px_minmax(0,1fr)] items-center gap-3">
              <span className="text-sm text-muted-foreground">Handoff links</span>
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <Switch checked={editPanelBlockDesktopHandoff} onCheckedChange={(c) => { setEditPanelBlockDesktopHandoff(c); if (c && !editPanelHandoffProtocol.trim()) setEditPanelHandoffProtocol(inferProtocolFromUrl(editPanelUrl) ?? ''); if (!c) setEditPanelProtocolError('') }} />
                  <span className="text-xs text-muted-foreground">Block desktop app handoff links</span>
                </div>
                {editPanelBlockDesktopHandoff && (
                  <div className="space-y-1">
                    <Input placeholder="e.g. figma" value={editPanelHandoffProtocol} onChange={(e) => { setEditPanelHandoffProtocol(e.target.value); setEditPanelProtocolError('') }} />
                  </div>
                )}
                {editPanelProtocolError && <p className="text-xs text-destructive">{editPanelProtocolError}</p>}
              </div>
            </div>
            <div className="flex items-center gap-2 pt-2">
              <Button onClick={() => handleSaveEditPanel(panelDetailId)}>Save</Button>
              <div className="flex-1" />
              <Button variant="ghost" className="text-destructive hover:text-destructive" onClick={() => handleDeleteWebPanel(wp.id)}><Trash2 className="size-3.5 mr-1" /> Delete</Button>
            </div>
          </div>
        )
      })()}
    </>
  )
}
