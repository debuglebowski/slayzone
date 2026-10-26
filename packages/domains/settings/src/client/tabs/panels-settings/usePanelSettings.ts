import { useState } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import { useSubscription, useTRPC, useTRPCClient } from '@slayzone/transport/client'
import { safeRandomUUID } from '@slayzone/ui'
import {
  AGENT_STARTUP_SETTING,
  DEFAULT_AGENT_STARTUP_MODE,
  parseAgentStartupMode,
  type AgentStartupMode
} from '@slayzone/terminal/shared'
import { KeyboardSensor, PointerSensor, useSensor, useSensors } from '@dnd-kit/core'
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable'
import type {
  PanelConfig,
  PanelView,
  WebPanelDefinition,
  GitTabId,
  GitTabVisibility
} from '@slayzone/task/shared'
import {
  DEFAULT_PANEL_CONFIG,
  DEFAULT_GIT_TAB_ORDER,
  inferHostScopeFromUrl,
  inferProtocolFromUrl,
  mergePanelOrder,
  mergePredefinedWebPanels,
  normalizeDesktopProtocol,
  normalizeGitTabOrder,
  normalizeGitTabVisibility,
  validatePanelShortcut
} from '@slayzone/task/shared'

/** Context-line choices offered by the diff settings Select. */
export type DiffContextLines = '0' | '3' | '5' | 'all'

/** All panel-settings state, effects and handlers. The parent and its panel
 *  sub-views consume the returned view-model; nothing here owns layout/render. */
export function usePanelSettings(activeTab: string, navigateTo: (tab: string) => void) {
  const trpc = useTRPC()
  const trpcClient = useTRPCClient()
  // staleTime:0 — settings are real-time (CLI / other windows write them out of
  // band). The dialog unmounts on close, so the onSettingsChanged refetch below
  // is inactive when an external write lands; on re-open the query must hit the
  // server, not return a globally-cached snapshot (otherwise a panel created via
  // `slay panels create` is invisible until the cache expires).
  const allSettingsQuery = useQuery(trpc.settings.getAll.queryOptions(undefined, { staleTime: 0 }))
  const setSettingMutation = useMutation(trpc.settings.set.mutationOptions())
  const [panelConfig, setPanelConfig] = useState<PanelConfig>(DEFAULT_PANEL_CONFIG)
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )
  const [terminalFontFamily, setTerminalFontFamily] = useState(
    'Menlo, Monaco, "Courier New", monospace'
  )
  const [terminalScrollback, setTerminalScrollback] = useState('2000')
  const [agentStartupMode, setAgentStartupMode] = useState<AgentStartupMode>(
    DEFAULT_AGENT_STARTUP_MODE
  )
  const [terminalAutoCloseIdle, setTerminalAutoCloseIdle] = useState(false)
  const [terminalIdleCloseValue, setTerminalIdleCloseValue] = useState('30')
  const [terminalIdleCloseUnit, setTerminalIdleCloseUnit] = useState('minutes')
  const [terminalForceCompatibilityRenderer, setTerminalForceCompatibilityRenderer] =
    useState(false)

  // Editor
  const [editorWordWrap, setEditorWordWrap] = useState<'on' | 'off'>('off')
  const [editorRenderWhitespace, setEditorRenderWhitespace] = useState<'none' | 'all'>('none')
  const [editorTabSize, setEditorTabSize] = useState<'2' | '4'>('2')
  const [editorIndentTabs, setEditorIndentTabs] = useState(false)
  const [editorMarkdownViewMode, setEditorMarkdownViewMode] = useState<'rich' | 'split' | 'code'>(
    'rich'
  )

  // Diff
  const [diffContextLines, setDiffContextLines] = useState<DiffContextLines>('3')
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
    mobile: { enabled: true, width: '393', height: '852' }
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

  // Each new settings snapshot re-seeds every field (which local edits override in
  // between) — adjusted while rendering.
  const [seenSettings, setSeenSettings] = useState<typeof allSettingsQuery.data>()
  const all = allSettingsQuery.data
  if (all !== seenSettings) {
    setSeenSettings(all)
    if (all) {
      const pc = all['panel_config']
      const tff = all['terminal_font_family']
      const ts = all['terminal_scrollback']
      const eww = all['editor_word_wrap']
      const erw = all['editor_render_whitespace']
      const ets = all['editor_tab_size']
      const eit = all['editor_indent_tabs']
      const dcl = all['diff_context_lines']
      const diw = all['diff_ignore_whitespace']
      const dcf = all['diff_continuous_flow']
      const dtc = all['diff_tree_collapsed']
      const dsbs = all['diff_side_by_side']
      const dwr = all['diff_wrap']
      const dste = all['dev_server_toast_enabled']
      const dsaob = all['dev_server_auto_open_browser']
      const bdu = all['browser_default_url']
      const bdz = all['browser_default_zoom']
      const bdd = all['browser_default_devices']
      const cgc = all['commit_graph_config']
      const emvm = all['editor_markdown_view_mode']
      const gto = all['git_tab_order']
      const gtv = all['git_tab_visibility']
      const tasm = all[AGENT_STARTUP_SETTING]
      const tfcr = all['terminal_force_compatibility_renderer']
      const taci = all['terminal_auto_close_idle']
      const ticv = all['terminal_idle_close_value']
      const ticu = all['terminal_idle_close_unit']

      if (pc)
        setPanelConfig(mergePanelOrder(mergePredefinedWebPanels(JSON.parse(pc) as PanelConfig)))
      if (tff) setTerminalFontFamily(tff)
      if (ts) setTerminalScrollback(ts)
      setAgentStartupMode(parseAgentStartupMode(tasm))
      if (tfcr === '1') setTerminalForceCompatibilityRenderer(true)
      if (taci === '1') setTerminalAutoCloseIdle(true)
      if (ticv) setTerminalIdleCloseValue(ticv)
      if (ticu) setTerminalIdleCloseUnit(ticu)
      if (eww === 'on') setEditorWordWrap('on')
      if (erw === 'all') setEditorRenderWhitespace('all')
      if (ets === '4') setEditorTabSize('4')
      if (eit === '1') setEditorIndentTabs(true)
      if (dcl === '0' || dcl === '3' || dcl === '5' || dcl === 'all') setDiffContextLines(dcl)
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
            desktop: d.desktop
              ? {
                  enabled: d.desktop.enabled !== false,
                  width: String(d.desktop.width),
                  height: String(d.desktop.height)
                }
              : { enabled: true, width: '1920', height: '1080' },
            tablet: d.tablet
              ? {
                  enabled: d.tablet.enabled !== false,
                  width: String(d.tablet.width),
                  height: String(d.tablet.height)
                }
              : { enabled: true, width: '744', height: '1133' },
            mobile: d.mobile
              ? {
                  enabled: d.mobile.enabled !== false,
                  width: String(d.mobile.width),
                  height: String(d.mobile.height)
                }
              : { enabled: true, width: '393', height: '852' }
          })
        } catch {
          /* ignore */
        }
      }
      if (cgc) {
        try {
          const g = JSON.parse(cgc)
          if (g.collapsed !== undefined) setGraphCollapsed(g.collapsed)
          if (g.showBranches !== undefined) setGraphShowBranches(g.showBranches)
          if (g.breakOnTags !== undefined) setGraphBreakOnTags(g.breakOnTags)
          if (g.breakOnMerges !== undefined) setGraphBreakOnMerges(g.breakOnMerges)
        } catch {
          /* ignore */
        }
      }
      if (emvm === 'split' || emvm === 'code') setEditorMarkdownViewMode(emvm)
      setGitTabOrder(normalizeGitTabOrder(gto))
      setGitTabVisibility(normalizeGitTabVisibility(gtv))
    }
  }

  // Replaces the app:settings-changed IPC listener: re-read panel_config when a
  // settings change is broadcast (CLI / other window). An unscoped ping (CLI/REST,
  // older hub) refetches everything as before. A keyed one comes from a
  // `settings.set` — including this dialog's own writes — so it re-reads ONLY
  // panel_config: refetching all settings would re-seed every field of the open
  // dialog from the server and could drop an edit the user has not saved yet.
  const applyPanelConfig = (pc: string | null | undefined): void => {
    if (pc) setPanelConfig(mergePanelOrder(mergePredefinedWebPanels(JSON.parse(pc) as PanelConfig)))
  }
  useSubscription(
    trpc.notify.onSettingsChanged.subscriptionOptions(undefined, {
      onData: (event) => {
        if (!event?.keys) {
          void allSettingsQuery
            .refetch()
            .then(({ data }) => applyPanelConfig(data?.['panel_config']))
          return
        }
        if (!event.keys.includes('panel_config')) return
        void trpcClient.settings.get
          .query({ key: 'panel_config' })
          .then(applyPanelConfig)
          .catch(() => undefined)
      }
    })
  )

  // Opening a web panel's tab, or a new panel config, seeds that panel's edit form
  // (which typing overrides in between) — adjusted while rendering, on an
  // [activeTab, panelConfig] effect's triggers.
  const [seenEditSource, setSeenEditSource] = useState<{
    activeTab: string
    panelConfig: PanelConfig
  }>()
  if (
    !seenEditSource ||
    seenEditSource.activeTab !== activeTab ||
    seenEditSource.panelConfig !== panelConfig
  ) {
    setSeenEditSource({ activeTab, panelConfig })
    const wp = activeTab.startsWith('panels/web:')
      ? panelConfig.webPanels.find((p) => p.id === activeTab.slice(7))
      : undefined
    if (wp) {
      setEditPanelName(wp.name)
      setEditPanelUrl(wp.baseUrl)
      setEditPanelShortcut(wp.shortcut || '')
      setEditPanelBlockDesktopHandoff(wp.blockDesktopHandoff ?? false)
      setEditPanelHandoffProtocol(wp.handoffProtocol ?? inferProtocolFromUrl(wp.baseUrl) ?? '')
      setEditPanelProtocolError('')
      setEditShortcutError('')
    }
  }

  // Shared write-through used by the panel sub-views (terminal/editor/diff/
  // browser/git) so every panel-settings write goes through one tRPC mutation.
  const setSetting = (key: string, value: string): void => {
    setSettingMutation.mutate({ key, value })
  }

  const savePanelConfig = async (next: PanelConfig) => {
    // Keep `order` complete on every write (add/delete/toggle/reorder). Without
    // this a newly-added web panel lives in `webPanels` but is absent from
    // `order`, so the list — which renders only `order`-listed ids — won't show
    // it until an out-of-band settings-change broadcast round-trips. mergePanelOrder
    // is idempotent (preserves the given order, only appends missing / prunes
    // removed), so re-applying here is safe for all callers.
    const merged = mergePanelOrder(next)
    setPanelConfig(merged)
    await setSettingMutation.mutateAsync({ key: 'panel_config', value: JSON.stringify(merged) })
    window.dispatchEvent(new CustomEvent('panel-config-changed'))
  }

  const togglePanel = (id: string, view: PanelView, enabled: boolean) => {
    savePanelConfig({
      ...panelConfig,
      viewEnabled: {
        ...panelConfig.viewEnabled,
        [view]: { ...panelConfig.viewEnabled?.[view], [id]: enabled }
      }
    })
  }

  const validateShortcut = (letter: string, excludeId?: string): string | null =>
    validatePanelShortcut(letter, panelConfig.webPanels, excludeId)

  const handleAddCustomPanel = async () => {
    if (!newPanelName.trim() || !newPanelUrl.trim()) return
    const shortcutErr = validateShortcut(newPanelShortcut)
    if (shortcutErr) {
      setPanelShortcutError(shortcutErr)
      return
    }

    let url = newPanelUrl.trim()
    if (!url.startsWith('http://') && !url.startsWith('https://')) url = `https://${url}`
    const handoffProtocol = newPanelBlockDesktopHandoff
      ? (normalizeDesktopProtocol(newPanelHandoffProtocol) ?? inferProtocolFromUrl(url))
      : null
    if (newPanelBlockDesktopHandoff && !handoffProtocol) {
      setNewPanelProtocolError('Enter a valid protocol (for example: figma)')
      return
    }
    setNewPanelProtocolError('')

    const newPanel: WebPanelDefinition = {
      id: `web:${safeRandomUUID().slice(0, 8)}`,
      name: newPanelName.trim(),
      baseUrl: url,
      shortcut: newPanelShortcut.trim().toLowerCase() || undefined,
      blockDesktopHandoff: newPanelBlockDesktopHandoff,
      handoffProtocol: handoffProtocol ?? undefined,
      handoffHostScope: newPanelBlockDesktopHandoff
        ? (inferHostScopeFromUrl(url) ?? undefined)
        : undefined
    }

    await savePanelConfig({ ...panelConfig, webPanels: [...panelConfig.webPanels, newPanel] })
    setNewPanelName('')
    setNewPanelUrl('')
    setNewPanelShortcut('')
    setNewPanelBlockDesktopHandoff(false)
    setNewPanelHandoffProtocol('')
  }

  const handleDeleteWebPanel = async (id: string) => {
    const wp = panelConfig.webPanels.find((p) => p.id === id)
    const next: PanelConfig = {
      ...panelConfig,
      webPanels: panelConfig.webPanels.filter((p) => p.id !== id)
    }
    if (wp?.predefined) next.deletedPredefined = [...(panelConfig.deletedPredefined ?? []), id]
    await savePanelConfig(next)
    if (activeTab === `panels/${id}`) navigateTo('panels')
  }

  const handleSaveEditPanel = async (panelId: string) => {
    if (!panelId || !editPanelName.trim() || !editPanelUrl.trim()) return
    const shortcutErr = editPanelShortcut ? validateShortcut(editPanelShortcut, panelId) : null
    if (shortcutErr) {
      setEditShortcutError(shortcutErr)
      return
    }

    let url = editPanelUrl.trim()
    if (!url.startsWith('http://') && !url.startsWith('https://')) url = `https://${url}`
    const handoffProtocol = editPanelBlockDesktopHandoff
      ? (normalizeDesktopProtocol(editPanelHandoffProtocol) ?? inferProtocolFromUrl(url))
      : null
    if (editPanelBlockDesktopHandoff && !handoffProtocol) {
      setEditPanelProtocolError('Enter a valid protocol')
      return
    }
    setEditPanelProtocolError('')

    await savePanelConfig({
      ...panelConfig,
      webPanels: panelConfig.webPanels.map((wp) =>
        wp.id === panelId
          ? {
              ...wp,
              name: editPanelName.trim(),
              baseUrl: url,
              shortcut: editPanelShortcut.trim().toLowerCase() || undefined,
              blockDesktopHandoff: editPanelBlockDesktopHandoff,
              handoffProtocol: editPanelBlockDesktopHandoff
                ? (handoffProtocol ?? wp.handoffProtocol)
                : wp.handoffProtocol,
              handoffHostScope: editPanelBlockDesktopHandoff
                ? (inferHostScopeFromUrl(url) ?? wp.handoffHostScope)
                : wp.handoffHostScope
            }
          : wp
      )
    })
  }

  const updateBrowserDevice = (
    slot: 'desktop' | 'tablet' | 'mobile',
    field: string,
    value: string | boolean
  ) => {
    setBrowserDevices((prev) => {
      const next = { ...prev, [slot]: { ...prev[slot], [field]: value } }
      const persist = {
        desktop: {
          enabled: next.desktop.enabled,
          width: parseInt(next.desktop.width, 10) || 1920,
          height: parseInt(next.desktop.height, 10) || 1080
        },
        tablet: {
          enabled: next.tablet.enabled,
          width: parseInt(next.tablet.width, 10) || 744,
          height: parseInt(next.tablet.height, 10) || 1133
        },
        mobile: {
          enabled: next.mobile.enabled,
          width: parseInt(next.mobile.width, 10) || 393,
          height: parseInt(next.mobile.height, 10) || 852
        }
      }
      setSetting('browser_default_devices', JSON.stringify(persist))
      return next
    })
  }

  const panelDetailId = activeTab.startsWith('panels/') ? activeTab.slice(7) : null

  return {
    navigateTo,
    panelConfig,
    sensors,
    terminalFontFamily,
    setTerminalFontFamily,
    terminalScrollback,
    setTerminalScrollback,
    agentStartupMode,
    setAgentStartupMode,
    terminalAutoCloseIdle,
    setTerminalAutoCloseIdle,
    terminalIdleCloseValue,
    setTerminalIdleCloseValue,
    terminalIdleCloseUnit,
    setTerminalIdleCloseUnit,
    terminalForceCompatibilityRenderer,
    setTerminalForceCompatibilityRenderer,
    editorWordWrap,
    setEditorWordWrap,
    editorRenderWhitespace,
    setEditorRenderWhitespace,
    editorTabSize,
    setEditorTabSize,
    editorIndentTabs,
    setEditorIndentTabs,
    editorMarkdownViewMode,
    setEditorMarkdownViewMode,
    diffContextLines,
    setDiffContextLines,
    diffIgnoreWhitespace,
    setDiffIgnoreWhitespace,
    diffContinuousFlow,
    setDiffContinuousFlow,
    diffTreeCollapsed,
    setDiffTreeCollapsed,
    diffSideBySide,
    setDiffSideBySide,
    diffWrap,
    setDiffWrap,
    graphCollapsed,
    setGraphCollapsed,
    graphShowBranches,
    setGraphShowBranches,
    graphBreakOnTags,
    setGraphBreakOnTags,
    graphBreakOnMerges,
    setGraphBreakOnMerges,
    gitTabOrder,
    setGitTabOrder,
    gitTabVisibility,
    setGitTabVisibility,
    devServerToastEnabled,
    setDevServerToastEnabled,
    devServerAutoOpenBrowser,
    setDevServerAutoOpenBrowser,
    browserDefaultUrl,
    setBrowserDefaultUrl,
    browserDefaultZoom,
    setBrowserDefaultZoom,
    browserDevices,
    setBrowserDevices,
    newPanelName,
    setNewPanelName,
    newPanelUrl,
    setNewPanelUrl,
    newPanelShortcut,
    setNewPanelShortcut,
    newPanelBlockDesktopHandoff,
    setNewPanelBlockDesktopHandoff,
    newPanelHandoffProtocol,
    setNewPanelHandoffProtocol,
    newPanelProtocolError,
    setNewPanelProtocolError,
    panelShortcutError,
    setPanelShortcutError,
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
    setEditShortcutError,
    panelDetailId,
    setSetting,
    savePanelConfig,
    togglePanel,
    validateShortcut,
    handleAddCustomPanel,
    handleDeleteWebPanel,
    handleSaveEditPanel,
    updateBrowserDevice
  }
}

export type PanelSettingsState = ReturnType<typeof usePanelSettings>
