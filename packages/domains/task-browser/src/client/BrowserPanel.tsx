import { useState, useRef, useEffect, useCallback, forwardRef, useImperativeHandle, createRef } from 'react'
import { track } from '@slayzone/telemetry/client'
import { ArrowLeft, ArrowRight, RotateCw, X, Plus, Import, Smartphone, Monitor, Tablet, LayoutGrid, ChevronDown, Crosshair, Bug, Sun, Moon, PaintbrushVertical, Keyboard, Puzzle, Trash2, Download, TriangleAlert } from 'lucide-react'
import type { BrowserTabTheme } from '../shared'
import { BrowserTabPlaceholder, type BrowserTabPlaceholderHandle } from './BrowserTabPlaceholder'
import { BrowserLoadingAnimation } from './BrowserLoadingAnimation'
import type { BrowserViewState } from './useBrowserView'
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  IconButton,
  Input,
  Separator,
  cn,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuShortcut,
} from '@slayzone/ui'
import { useAppearance } from '@slayzone/settings/client'
import type { BrowserTab, BrowserTabsState, MultiDeviceConfig, GridLayout, DeviceSlot } from '../shared'
import { defaultMultiDeviceConfig } from './device-presets'
import { MultiDeviceGrid } from './MultiDeviceGrid'
import { buildDomElementSnippet, type PickedDomPayload } from './dom-picker'
import { DOM_PICKER_SCRIPT, DOM_PICKER_CANCEL_SCRIPT } from './dom-picker-runtime'

const SLOT_BUTTONS: { slot: DeviceSlot; icon: typeof Monitor; label: string }[] = [
  { slot: 'desktop', icon: Monitor, label: 'Desktop' },
  { slot: 'tablet', icon: Tablet, label: 'Tablet' },
  { slot: 'mobile', icon: Smartphone, label: 'Mobile' },
]

interface TaskUrlEntry {
  taskId: string
  taskTitle: string
  url: string
  tabTitle: string
}

interface InstalledBrowserExtension {
  id: string
  name: string
  version?: string
  icon?: string
  manifestVersion?: number
}

interface DiscoverableBrowserExtension {
  id: string
  name: string
  version: string
  path: string
  alreadyImported: boolean
  manifestVersion?: number
}

interface BrowserExtensionSource {
  name: string
  extensions: DiscoverableBrowserExtension[]
}

// WebviewElement interface removed — using WebContentsView via useBrowserView hook

const THEME_CSS: Record<'light' | 'dark', string> = {
  dark: [
    'html{filter:invert(90%) hue-rotate(180deg)!important}',
    'img,video,canvas,svg,iframe{filter:invert(90%) hue-rotate(180deg)!important}',
  ].join(''),
  light: ':root{color-scheme:light!important}',
}

const THEME_CYCLE: BrowserTabTheme[] = ['system', 'dark', 'light']
const EXTENSIONS_MANAGER_ENABLED = false

interface BrowserPanelProps {
  className?: string
  tabs: BrowserTabsState
  onTabsChange: (tabs: BrowserTabsState) => void
  taskId?: string
  isResizing?: boolean
  isActive?: boolean
  onElementSnippet?: (snippet: string) => void
  canUseDomPicker?: boolean
}

export interface BrowserPanelHandle {
  pickElement: () => void
  reload: () => void
  focusUrlBar: () => void
}

function generateTabId(): string {
  return `tab-${crypto.randomUUID().slice(0, 8)}`
}

interface ExtensionsManagerViewProps {
  extensions: InstalledBrowserExtension[]
  browserExtensions: BrowserExtensionSource[]
  isLoading: boolean
  error: string | null
  onRefresh: () => void
  onClose: () => void
  onActivate: (extensionId: string) => void
  onRemove: (extensionId: string) => void
  onImport: (path: string, name: string) => void
  onLoadUnpacked: () => void
}

function ExtensionsManagerView({
  extensions,
  browserExtensions,
  isLoading,
  error,
  onRefresh,
  onClose,
  onActivate,
  onRemove,
  onImport,
  onLoadUnpacked,
}: ExtensionsManagerViewProps) {
  const availableSources = browserExtensions
    .map((browser) => ({
      ...browser,
      extensions: browser.extensions.filter(extension => !extension.alreadyImported),
    }))
    .filter(browser => browser.extensions.length > 0)
  const availableCount = availableSources.reduce((total, browser) => total + browser.extensions.length, 0)
  const hasManifestV3 = (
    extensions.some(extension => extension.manifestVersion === 3) ||
    availableSources.some(browser => browser.extensions.some(extension => extension.manifestVersion === 3))
  )

  return (
    <div
      data-testid="browser-extensions-manager"
      className="flex-1 min-h-0 overflow-y-auto bg-gradient-to-b from-surface-1 via-background to-surface-1"
    >
      <div className="mx-auto flex max-w-6xl flex-col gap-4 p-4 md:p-6">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div className="space-y-1">
            <h2 className="text-xl font-semibold tracking-tight">Extensions</h2>
            <p className="text-sm text-muted-foreground">
              Manage installed extensions and bring in more from your local browser profiles.
            </p>
          </div>
          <Button variant="outline" onClick={onClose}>
            Done
          </Button>
        </div>

        <div className="grid gap-4 xl:grid-cols-[320px_minmax(0,1fr)]">
          <Card className="gap-0">
            <CardHeader className="gap-1">
              <CardTitle className="text-base">Options</CardTitle>
              <CardDescription>
                Refresh what is installed, import from detected browsers, or load an unpacked extension.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-2">
                <Button onClick={onRefresh} disabled={isLoading}>
                  <RotateCw className={cn('size-4', isLoading && 'animate-spin')} />
                  Refresh lists
                </Button>
                <Button variant="outline" onClick={onLoadUnpacked} disabled={isLoading}>
                  <Plus className="size-4" />
                  Load unpacked extension...
                </Button>
              </div>
              <Separator />
              <dl className="grid gap-3 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-muted-foreground">Installed</dt>
                  <dd className="font-medium">{extensions.length}</dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-muted-foreground">Available to import</dt>
                  <dd className="font-medium">{availableCount}</dd>
                </div>
              </dl>
              {hasManifestV3 && (
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-200">
                  Manifest V3 extensions are marked below. Their popups, background workers, and permissions may not work exactly as they do in Chrome.
                </div>
              )}
              {error && (
                <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                  {error}
                </div>
              )}
            </CardContent>
          </Card>

          <div className="grid gap-4">
            <Card className="gap-0">
              <CardHeader className="gap-1">
                <CardTitle className="text-base">Installed extensions</CardTitle>
                <CardDescription>
                  Open an extension action in the active tab or remove it from this browser session.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {extensions.length === 0 ? (
                  <div className="rounded-lg border border-dashed px-4 py-6 text-sm text-muted-foreground">
                    No installed extensions yet.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {extensions.map(extension => (
                      <div
                        key={extension.id}
                        className={cn(
                          'flex flex-col gap-3 rounded-lg border bg-background/80 px-4 py-3',
                          extension.manifestVersion === 3 && 'border-amber-500/40 bg-amber-500/5'
                        )}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex min-w-0 items-center gap-3">
                            {extension.icon ? (
                              <img src={extension.icon} className="size-10 shrink-0 rounded-md" alt="" />
                            ) : (
                              <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                                <Puzzle className="size-4" />
                              </div>
                            )}
                            <div className="min-w-0">
                              <div className="flex items-center gap-2">
                                <div className="truncate text-sm font-medium">{extension.name}</div>
                                {extension.manifestVersion === 3 && (
                                  <span className="shrink-0 rounded-full border border-amber-500/40 bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-900 dark:text-amber-100">
                                    MV3
                                  </span>
                                )}
                              </div>
                              <div className="truncate text-xs text-muted-foreground">
                                {extension.version ? `Version ${extension.version}` : extension.id}
                              </div>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <Button variant="outline" size="sm" onClick={() => onActivate(extension.id)}>
                              Open
                            </Button>
                            <IconButton
                              aria-label={`Remove ${extension.name}`}
                              variant="ghost"
                              size="icon-sm"
                              className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                              onClick={() => onRemove(extension.id)}
                            >
                              <Trash2 className="size-4" />
                            </IconButton>
                          </div>
                        </div>
                        {extension.manifestVersion === 3 && (
                          <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-100">
                            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                            <span>Manifest V3 extension. Popups, service workers, or permissions may not behave exactly like Chrome.</span>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="gap-0">
              <CardHeader className="gap-1">
                <CardTitle className="text-base">Available extensions</CardTitle>
                <CardDescription>
                  Extensions detected in local browser profiles that can be imported into SlayZone.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {availableSources.length === 0 ? (
                  <div className="rounded-lg border border-dashed px-4 py-6 text-sm text-muted-foreground">
                    No importable extensions were detected.
                  </div>
                ) : (
                  <div className="space-y-4">
                    {availableSources.map(browser => (
                      <div key={browser.name} className="space-y-2">
                        <div className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                          {browser.name}
                        </div>
                        <div className="space-y-2">
                          {browser.extensions.map(extension => (
                            <div
                              key={extension.id}
                              className={cn(
                                'flex flex-col gap-3 rounded-lg border bg-background/80 px-4 py-3',
                                extension.manifestVersion === 3 && 'border-amber-500/40 bg-amber-500/5'
                              )}
                            >
                              <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                  <div className="flex items-center gap-2">
                                    <div className="truncate text-sm font-medium">{extension.name}</div>
                                    {extension.manifestVersion === 3 && (
                                      <span className="shrink-0 rounded-full border border-amber-500/40 bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-900 dark:text-amber-100">
                                        MV3
                                      </span>
                                    )}
                                  </div>
                                  <div className="truncate text-xs text-muted-foreground">
                                    Version {extension.version}
                                  </div>
                                </div>
                                <Button variant="outline" size="sm" onClick={() => onImport(extension.path, extension.name)}>
                                  <Download className="size-4" />
                                  Import
                                </Button>
                              </div>
                              {extension.manifestVersion === 3 && (
                                <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-100">
                                  <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                                  <span>Manifest V3 extension. Expect some behavior differences after import.</span>
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  )
}
export const BrowserPanel = forwardRef<BrowserPanelHandle, BrowserPanelProps>(function BrowserPanel({
  className,
  tabs,
  onTabsChange,
  taskId,
  isResizing,
  isActive,
  onElementSnippet,
  canUseDomPicker = true,
}: BrowserPanelProps, ref) {
  const { browserDefaultUrl, browserDefaultZoom, browserDeviceDefaults } = useAppearance()
  const urlInputRef = useRef<HTMLInputElement>(null)
  const [inputUrl, setInputUrl] = useState('')
  const [isFocused, setIsFocused] = useState(false)
  const [otherTaskUrls, setOtherTaskUrls] = useState<TaskUrlEntry[]>([])
  const [importDropdownOpen, setImportDropdownOpen] = useState(false)
  const [reloadTrigger, setReloadTrigger] = useState(0)
  const [forceReloadTrigger, setForceReloadTrigger] = useState(0)
  const [devToolsOpen, setDevToolsOpen] = useState(false)
  const [isPickingElement, setIsPickingElement] = useState(false)
  const [captureShortcuts, setCaptureShortcuts] = useState(false)
  const [pickError, setPickError] = useState<string | null>(null)
  const [extensionsManagerOpen, setExtensionsManagerOpen] = useState(false)
  const [extensions, setExtensions] = useState<InstalledBrowserExtension[]>([])
  const [browserExtensions, setBrowserExtensions] = useState<BrowserExtensionSource[]>([])
  const [extensionsLoading, setExtensionsLoading] = useState(false)
  const [extensionsError, setExtensionsError] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const darkModeCSSKeyRef = useRef<string | null>(null)

  // Per-tab view refs — each BrowserTabPlaceholder exposes its viewId/state/actions
  const tabRefsRef = useRef<Map<string, React.RefObject<BrowserTabPlaceholderHandle | null>>>(new Map())
  const getTabRef = useCallback((tabId: string) => {
    let existing = tabRefsRef.current.get(tabId)
    if (!existing) {
      existing = createRef<BrowserTabPlaceholderHandle>()
      tabRefsRef.current.set(tabId, existing)
    }
    return existing
  }, [])

  // Active tab's state (updated via onStateChange callback from placeholder)
  const [activeViewState, setActiveViewState] = useState<BrowserViewState>({
    url: '', title: '', favicon: '', canGoBack: false, canGoForward: false,
    isLoading: false, error: null, domReady: false, hasLoadedRealPage: false,
  })
  const [hiddenByOverlay, setHiddenByOverlay] = useState(false)

  // Reset view state when active tab changes so stale hasLoadedRealPage doesn't leak
  useEffect(() => {
    if (!tabs.activeTabId) return
    const handle = tabRefsRef.current.get(tabs.activeTabId)?.current
    if (handle) {
      setActiveViewState(handle.state)
    } else {
      setActiveViewState({
        url: '', title: '', favicon: '', canGoBack: false, canGoForward: false,
        isLoading: false, error: null, domReady: false, hasLoadedRealPage: false,
      })
    }
  }, [tabs.activeTabId])

  // Convenience accessors for active tab
  // getActiveHandle reads the ref at call time — safe for event handlers where
  // the imperative handle may have updated since the last render.
  const activeTabIdRef = useRef(tabs.activeTabId)
  activeTabIdRef.current = tabs.activeTabId
  const getActiveHandle = useCallback(() => {
    const tabId = activeTabIdRef.current
    return tabId ? tabRefsRef.current.get(tabId)?.current ?? null : null
  }, [])
  const activeTabRef = getActiveHandle()
  const activeActions = activeTabRef?.actions
  const activeViewId = activeTabRef?.viewId ?? null
  const canGoBack = activeViewState.canGoBack
  const canGoForward = activeViewState.canGoForward
  const isLoading = activeViewState.isLoading
  const loadError = activeViewState.error
  const webviewReady = activeViewState.domReady

  // Register browser panel for CLI access (strictly tab 0 only)
  const isFirstTabActive = tabs.activeTabId === tabs.tabs[0]?.id
  useEffect(() => {
    if (!taskId || !activeViewId || !isFirstTabActive) return
    void (async () => {
      const wcId = await window.api.browser.getWebContentsId(activeViewId)
      if (wcId) void window.api.webview.registerBrowserPanel(taskId, wcId)
    })()
    return () => { void window.api.webview.unregisterBrowserPanel(taskId) }
  }, [taskId, activeViewId, isFirstTabActive])

  // Sync keyboard passthrough to main process
  useEffect(() => {
    if (!activeViewId) return
    void window.api.browser.setKeyboardPassthrough(activeViewId, captureShortcuts)
  }, [activeViewId, captureShortcuts])

  // Fetch URLs from other tasks when dropdown opens
  useEffect(() => {
    if (!importDropdownOpen || !taskId) return
    window.api.db.getTasks().then(tasks => {
      const entries: TaskUrlEntry[] = []
      for (const t of tasks) {
        if (t.id === taskId) continue
        if (!t.browser_tabs?.tabs) continue
        for (const tab of t.browser_tabs.tabs) {
          if (tab.url && tab.url !== 'about:blank') {
            entries.push({ taskId: t.id, taskTitle: t.title, url: tab.url, tabTitle: tab.title })
          }
        }
      }
      setOtherTaskUrls(entries)
    })
  }, [importDropdownOpen, taskId])

  const activeTab = tabs.tabs.find(t => t.id === tabs.activeTabId) || null
  // Multi-device state (derived from active tab)
  const multiDeviceMode = activeTab?.multiDeviceMode ?? false
  const [defaultConfig] = useState(() => defaultMultiDeviceConfig(browserDeviceDefaults))
  const multiDeviceConfig = activeTab?.multiDeviceConfig ?? defaultConfig
  const multiDeviceLayout: GridLayout = activeTab?.multiDeviceLayout ?? 'horizontal'

  const updateActiveTab = useCallback((patch: Partial<BrowserTab>) => {
    if (!tabs.activeTabId) return
    onTabsChange({
      ...tabs,
      tabs: tabs.tabs.map(t =>
        t.id === tabs.activeTabId ? { ...t, ...patch } : t
      )
    })
  }, [tabs, onTabsChange])

  const toggleMultiDevice = useCallback(() => {
    if (!activeTab) return
    const entering = !multiDeviceMode
    // Each tab has its own view — no need to reset ready state
    track('browser_multidevice_toggled')
    updateActiveTab({
      multiDeviceMode: entering,
      ...(entering && !activeTab.multiDeviceConfig ? { multiDeviceConfig: defaultMultiDeviceConfig(browserDeviceDefaults) } : {}),
      ...(entering && !activeTab.multiDeviceLayout ? { multiDeviceLayout: 'horizontal' as GridLayout } : {}),
    })
  }, [activeTab, multiDeviceMode, updateActiveTab])

  const applyThemeCss = useCallback((mode: BrowserTabTheme) => {
    if (!activeActions) return
    void (async () => {
      const key = darkModeCSSKeyRef.current
      if (key) { darkModeCSSKeyRef.current = null; activeActions.removeCss(key) }
      const css = mode === 'system' ? null : THEME_CSS[mode]
      if (css) darkModeCSSKeyRef.current = await activeActions.insertCss(css) || null
    })()
  }, [activeActions])

  const toggleCaptureShortcuts = useCallback(() => {
    setCaptureShortcuts(prev => !prev)
  }, [])

  const cycleTheme = useCallback(() => {
    if (!activeTab) return
    const current = activeTab.themeMode ?? 'system'
    const next = THEME_CYCLE[(THEME_CYCLE.indexOf(current) + 1) % THEME_CYCLE.length]
    updateActiveTab({ themeMode: next })
    applyThemeCss(next)
  }, [activeTab, updateActiveTab, applyThemeCss])

  const setMultiDeviceLayout = useCallback((layout: GridLayout) => {
    updateActiveTab({ multiDeviceLayout: layout })
  }, [updateActiveTab])

  const setMultiDeviceConfig = useCallback((config: MultiDeviceConfig) => {
    updateActiveTab({ multiDeviceConfig: config })
  }, [updateActiveTab])

  const toggleSlot = useCallback((slot: DeviceSlot) => {
    const newConfig = { ...multiDeviceConfig, [slot]: { ...multiDeviceConfig[slot], enabled: !multiDeviceConfig[slot].enabled } }
    if (!Object.values(newConfig).some(c => c.enabled)) return
    setMultiDeviceConfig(newConfig)
  }, [multiDeviceConfig, setMultiDeviceConfig])

  const setPreset = useCallback((slot: DeviceSlot, preset: import('../shared').DeviceEmulation) => {
    setMultiDeviceConfig({ ...multiDeviceConfig, [slot]: { ...multiDeviceConfig[slot], preset } })
  }, [multiDeviceConfig, setMultiDeviceConfig])

  const refreshExtensions = useCallback(async () => {
    setExtensionsLoading(true)
    setExtensionsError(null)
    try {
      const [installed, discovered] = await Promise.all([
        window.api.browser.getExtensions(),
        window.api.browser.discoverBrowserExtensions(),
      ])
      const installedIds = new Set(installed.map(extension => extension.id))
      setExtensions(installed)
      setBrowserExtensions(
        discovered.map(browser => ({
          ...browser,
          extensions: browser.extensions.map(extension => ({
            ...extension,
            alreadyImported: extension.alreadyImported || installedIds.has(extension.id),
          })),
        }))
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load extensions'
      setExtensionsError(message)
    } finally {
      setExtensionsLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!extensionsManagerOpen) return
    void refreshExtensions()
  }, [extensionsManagerOpen, refreshExtensions])

  const handleToggleExtensionsManager = useCallback(() => {
    setExtensionsManagerOpen(prev => !prev)
  }, [])

  const handleActivateExtension = useCallback((extensionId: string) => {
    setExtensionsManagerOpen(false)
    requestAnimationFrame(() => {
      void window.api.browser.activateExtension(extensionId)
    })
  }, [])

  const handleImportExtension = useCallback(async (path: string, name: string) => {
    try {
      const result = await window.api.browser.importExtension(path)
      if ('id' in result) {
        await refreshExtensions()
        return
      }
      setExtensionsError(result.error)
    } catch (error) {
      const message = error instanceof Error ? error.message : `Failed to import ${name}`
      setExtensionsError(message)
    }
  }, [refreshExtensions])

  const handleLoadExtension = useCallback(async () => {
    try {
      const result = await window.api.browser.loadExtension()
      if (result && 'id' in result) {
        await refreshExtensions()
        return
      }
      if (result && 'error' in result) {
        setExtensionsError(result.error)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load unpacked extension'
      setExtensionsError(message)
    }
  }, [refreshExtensions])

  const handleRemoveExtension = useCallback(async (extensionId: string) => {
    try {
      await window.api.browser.removeExtension(extensionId)
      await refreshExtensions()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to remove extension'
      setExtensionsError(message)
    }
  }, [refreshExtensions])

  // Tab callbacks
  const newTabUrl = browserDefaultUrl || 'about:blank'
  const createNewTab = useCallback((url?: string) => {
    const tabUrl = url ?? newTabUrl
    const newTab: BrowserTab = {
      id: generateTabId(),
      url: tabUrl,
      title: tabUrl === 'about:blank' ? 'New Tab' : tabUrl
    }
    onTabsChange({
      tabs: [...tabs.tabs, newTab],
      activeTabId: newTab.id
    })
    track('web_panel_tab_added', { predefined_vs_custom: 'custom' })
  }, [tabs, onTabsChange, newTabUrl])

  const closeTab = useCallback((tabId: string) => {
    const idx = tabs.tabs.findIndex(t => t.id === tabId)
    const newTabs = tabs.tabs.filter(t => t.id !== tabId)

    let newActiveId = tabs.activeTabId
    if (tabId === tabs.activeTabId) {
      if (newTabs.length === 0) {
        const newTab: BrowserTab = { id: generateTabId(), url: newTabUrl, title: newTabUrl === 'about:blank' ? 'New Tab' : newTabUrl }
        onTabsChange({ tabs: [newTab], activeTabId: newTab.id })
        track('browser_tab_closed')
        return
      }
      newActiveId = newTabs[Math.min(idx, newTabs.length - 1)]?.id || null
    }

    onTabsChange({ tabs: newTabs, activeTabId: newActiveId })
    track('browser_tab_closed')
  }, [tabs, onTabsChange, newTabUrl])

  const switchToTab = useCallback((tabId: string) => {
    onTabsChange({ ...tabs, activeTabId: tabId })
  }, [tabs, onTabsChange])

  const switchToNextTab = useCallback(() => {
    const idx = tabs.tabs.findIndex(t => t.id === tabs.activeTabId)
    switchToTab(tabs.tabs[(idx + 1) % tabs.tabs.length].id)
  }, [tabs, switchToTab])

  const switchToPrevTab = useCallback(() => {
    const idx = tabs.tabs.findIndex(t => t.id === tabs.activeTabId)
    switchToTab(tabs.tabs[(idx - 1 + tabs.tabs.length) % tabs.tabs.length].id)
  }, [tabs, switchToTab])

  // Update URL bar when active tab changes
  useEffect(() => {
    setInputUrl(activeTab?.url || '')
  }, [activeTab?.id, activeTab?.url])

  // Belt-and-suspenders: explicitly sync all view visibility on tab/task switch
  useEffect(() => {
    for (const [tabId, ref] of tabRefsRef.current) {
      const handle = ref.current
      if (!handle?.viewId) continue
      const shouldBeVisible = tabId === tabs.activeTabId && isActive !== false && !extensionsManagerOpen
      void window.api.browser.setVisible(handle.viewId, shouldBeVisible)
    }
  }, [tabs.activeTabId, isActive, extensionsManagerOpen])

  // No longer needed — each tab has its own WebContentsView via BrowserTabPlaceholder

  // Refs for stable event handler closures (avoids tearing down listeners on every tabs change)
  const tabsRef = useRef(tabs)
  const onTabsChangeRef = useRef(onTabsChange)
  const createNewTabRef = useRef(createNewTab)
  tabsRef.current = tabs
  onTabsChangeRef.current = onTabsChange
  createNewTabRef.current = createNewTab

  // Eagerly update tabsRef + notify parent. Prevents stale-ref races when
  // multiple webview events (did-navigate, page-title-updated, page-favicon-updated)
  // fire in the same React batch before a re-render can refresh the ref.
  const commitTabsUpdate = useRef((next: BrowserTabsState) => {
    tabsRef.current = next
    onTabsChangeRef.current(next)
  }).current

  // Sync active view state to tab data (url, title, favicon)
  useEffect(() => {
    if (!activeViewState.url || !tabs.activeTabId) return
    const t = tabsRef.current
    const activeTabData = t.tabs.find(tab => tab.id === t.activeTabId)
    if (activeTabData && activeViewState.url !== activeTabData.url) {
      commitTabsUpdate({
        ...t,
        tabs: t.tabs.map(tab =>
          tab.id === t.activeTabId ? { ...tab, url: activeViewState.url } : tab
        )
      })
    }
  }, [activeViewState.url])

  useEffect(() => {
    if (!activeViewState.title || !tabs.activeTabId) return
    const t = tabsRef.current
    commitTabsUpdate({
      ...t,
      tabs: t.tabs.map(tab =>
        tab.id === t.activeTabId ? { ...tab, title: activeViewState.title } : tab
      )
    })
  }, [activeViewState.title])

  useEffect(() => {
    if (!activeViewState.favicon || !tabs.activeTabId) return
    const t = tabsRef.current
    commitTabsUpdate({
      ...t,
      tabs: t.tabs.map(tab =>
        tab.id === t.activeTabId ? { ...tab, favicon: activeViewState.favicon } : tab
      )
    })
  }, [activeViewState.favicon])

  // Apply default zoom when view is ready
  useEffect(() => {
    if (!webviewReady || !activeActions) return
    activeActions.setZoom(browserDefaultZoom / 100)
  }, [webviewReady, browserDefaultZoom, activeActions])

  // Inline DevTools system removed — using native docked DevTools via WebContentsView

  // Keyboard shortcuts when focused
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isFocused || !captureShortcuts) return
      if (e.metaKey && e.key === 't') { e.preventDefault(); createNewTab() }
      if (e.metaKey && e.key === 'w') { e.preventDefault(); if (tabs.activeTabId) closeTab(tabs.activeTabId) }
      if (e.ctrlKey && e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); switchToNextTab() }
      if (e.ctrlKey && e.key === 'Tab' && e.shiftKey) { e.preventDefault(); switchToPrevTab() }
    }

    container.addEventListener('keydown', handleKeyDown)
    return () => container.removeEventListener('keydown', handleKeyDown)
  }, [isFocused, captureShortcuts, tabs, createNewTab, closeTab, switchToNextTab, switchToPrevTab])

  const handleNavigate = () => {
    if (extensionsManagerOpen || !inputUrl.trim()) return

    let url = inputUrl.trim()
    if (url.startsWith('/')) {
      url = `file://${url}`
    } else if (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('file://')) {
      url = `https://${url}`
    }

    if (multiDeviceMode) {
      setInputUrl(url)
      updateActiveTab({ url })
      return
    }

    // Read ref at call time — activeActions from render may be stale if the
    // child's useImperativeHandle updated after the parent's last render.
    const handle = getActiveHandle()
    if (!handle?.actions) return
    handle.actions.navigate(url)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleNavigate()
  }

  const handleFocus = () => setIsFocused(true)
  const handleBlur = (e: React.FocusEvent) => {
    if (!containerRef.current?.contains(e.relatedTarget as Node)) {
      setIsFocused(false)
    }
  }

  const toggleDevTools = useCallback(() => {
    if (multiDeviceMode || !webviewReady || !activeViewId) {
      return
    }
    track('browser_devtools_toggled')

    void (async () => {
      try {
        const isOpen = await window.api.browser.isDevToolsOpen(activeViewId)
        if (isOpen) {
          await window.api.browser.closeDevTools(activeViewId)
          setDevToolsOpen(false)
        } else {
          await window.api.browser.openDevTools(activeViewId, 'bottom')
          setDevToolsOpen(true)
        }
      } catch {
        // DevTools toggle failed silently
      }
    })()
  }, [multiDeviceMode, webviewReady, activeViewId])

  const cancelPickElement = useCallback(async () => {
    if (!activeActions) return
    try {
      await activeActions.executeJs(DOM_PICKER_CANCEL_SCRIPT)
    } catch {
      // ignore cancellation errors
    }
    setIsPickingElement(false)
  }, [activeActions])

  useEffect(() => {
    if (!extensionsManagerOpen || !isPickingElement) return
    void cancelPickElement()
  }, [extensionsManagerOpen, isPickingElement, cancelPickElement])

  // Escape should always cancel picker mode, even when focus is outside webview.
  useEffect(() => {
    if (!isPickingElement) return

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      void cancelPickElement()
    }

    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [isPickingElement, cancelPickElement])

  const startPickElement = useCallback(async () => {
    if (extensionsManagerOpen || !canUseDomPicker || multiDeviceMode || isPickingElement || !activeActions) return

    setIsPickingElement(true)
    setPickError(null)
    try {
      const payload = await activeActions.executeJs(DOM_PICKER_SCRIPT) as PickedDomPayload | null
      if (!payload) {
        setIsPickingElement(false)
        return
      }
      const snippet = buildDomElementSnippet(payload)
      onElementSnippet?.(snippet)
      setIsPickingElement(false)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to start element picker'
      setPickError(message)
      setIsPickingElement(false)
    }
  }, [extensionsManagerOpen, canUseDomPicker, isPickingElement, multiDeviceMode, activeActions])

  const handlePickElement = useCallback(() => {
    if (isPickingElement) {
      void cancelPickElement()
      return
    }
    void startPickElement()
  }, [isPickingElement, cancelPickElement, startPickElement])

  // Shortcuts from WebContentsView are forwarded via before-input-event → browser-view:shortcut IPC → synthetic KeyboardEvent

  useImperativeHandle(ref, () => ({
    pickElement: () => {
      handlePickElement()
    },
    reload: () => {
      activeActions?.reload()
    },
    focusUrlBar: () => {
      urlInputRef.current?.focus()
      urlInputRef.current?.select()
    }
  }), [handlePickElement, activeActions])

  useEffect(() => {
    return () => {
      if (!isPickingElement) return
      void cancelPickElement()
    }
  }, [isPickingElement, cancelPickElement])

  // DevTools cleanup on unmount handled by view destruction

  return (
    <div
      ref={containerRef}
      data-browser-panel="true"
      data-picker-active={isPickingElement ? 'true' : 'false'}
      className={cn(
        'flex flex-col rounded-md transition-shadow',
        isPickingElement && 'ring-2 ring-amber-500/70',
        className
      )}
      tabIndex={-1}
      onFocus={handleFocus}
      onBlur={handleBlur}
    >
      {/* Tab Bar */}
      <div className="shrink-0 flex items-center h-10 px-2 gap-1 border-b border-border bg-surface-1 overflow-x-auto scrollbar-hide">
        {tabs.tabs.map(tab => {
          const isActive = tab.id === tabs.activeTabId
          const displayUrl = tab.url === 'about:blank' ? 'New Tab' : tab.url
          return (
            <div
              key={tab.id}
              role="button"
              tabIndex={0}
              onClick={() => switchToTab(tab.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); switchToTab(tab.id) }
              }}
              onAuxClick={(e) => {
                if (e.button === 1) { e.preventDefault(); closeTab(tab.id) }
              }}
              className={cn(
                'group flex items-center gap-1.5 h-7 px-3 rounded-md cursor-pointer transition-colors select-none flex-shrink-0',
                'bg-neutral-100 dark:bg-neutral-800/50 hover:bg-neutral-200/80 dark:hover:bg-neutral-700/50',
                'max-w-[300px]',
                isActive ? 'bg-neutral-200 dark:bg-neutral-700 border border-neutral-300 dark:border-neutral-600' : 'text-neutral-500 dark:text-neutral-400',
                isActive && isPickingElement && 'ring-2 ring-amber-500/70 border-amber-500/70'
              )}
            >
              <span className="truncate text-sm">{displayUrl}</span>
              <button
                onClick={(e) => { e.stopPropagation(); closeTab(tab.id) }}
                className="h-4 w-4 rounded hover:bg-muted-foreground/20 flex items-center justify-center"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          )
        })}
        <button
          onClick={() => createNewTab()}
          className="h-7 px-2 rounded-md hover:bg-neutral-200/80 dark:hover:bg-neutral-700/50 text-neutral-500 dark:text-neutral-400 flex items-center"
        >
          <Plus className="size-4" />
        </button>
      </div>

      {/* URL Bar */}
      <div className="shrink-0 p-2 border-b flex items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <IconButton aria-label="Back" variant="ghost" size="icon-sm" disabled={extensionsManagerOpen || !canGoBack || multiDeviceMode} onClick={() => { activeActions?.goBack(); track('browser_navigated') }}>
                <ArrowLeft className="size-4" />
              </IconButton>
            </span>
          </TooltipTrigger>
          <TooltipContent>Back</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <IconButton aria-label="Forward" variant="ghost" size="icon-sm" disabled={extensionsManagerOpen || !canGoForward || multiDeviceMode} onClick={() => { activeActions?.goForward(); track('browser_navigated') }}>
                <ArrowRight className="size-4" />
              </IconButton>
            </span>
          </TooltipTrigger>
          <TooltipContent>Forward</TooltipContent>
        </Tooltip>
        <ContextMenu>
          <Tooltip>
            <ContextMenuTrigger asChild>
              <TooltipTrigger asChild>
                <span>
                  <IconButton
                    aria-label={isLoading && !multiDeviceMode ? 'Stop loading' : 'Reload'}
                    variant="ghost"
                    size="icon-sm"
                    disabled={extensionsManagerOpen}
                    onClick={(e) => {
                      if (multiDeviceMode) {
                        if (e.shiftKey) setForceReloadTrigger(r => r + 1)
                        else setReloadTrigger(r => r + 1)
                      } else if (isLoading) {
                        activeActions?.stop()
                      } else if (e.shiftKey) {
                        activeActions?.reload(true)
                      } else {
                        activeActions?.reload()
                      }
                      track('browser_navigated')
                    }}
                  >
                    {isLoading && !multiDeviceMode ? <X className="size-4" /> : <RotateCw className="size-4" />}
                  </IconButton>
                </span>
              </TooltipTrigger>
            </ContextMenuTrigger>
            <TooltipContent>{isLoading && !multiDeviceMode ? 'Stop loading' : 'Reload'}</TooltipContent>
          </Tooltip>
          <ContextMenuContent>
            <ContextMenuItem onClick={() => {
              if (multiDeviceMode) setReloadTrigger(r => r + 1)
              else activeActions?.reload()
            }}>
              Reload
              <ContextMenuShortcut>⌘R</ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuItem onClick={() => {
              if (multiDeviceMode) setForceReloadTrigger(r => r + 1)
              else activeActions?.reload(true)
            }}>
              Hard Reload
              <ContextMenuShortcut>⇧⌘R</ContextMenuShortcut>
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>

        <Input
          ref={urlInputRef}
          value={inputUrl}
          onChange={(e) => setInputUrl(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Enter URL..."
          disabled={extensionsManagerOpen}
          className="flex-1 h-7 text-sm"
        />

        {taskId && (
          <DropdownMenu open={importDropdownOpen} onOpenChange={setImportDropdownOpen}>
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <DropdownMenuTrigger asChild>
                    <IconButton aria-label="Import URL from another task" variant="ghost" size="icon-sm" disabled={extensionsManagerOpen}>
                      <Import className="size-4" />
                    </IconButton>
                  </DropdownMenuTrigger>
                </span>
              </TooltipTrigger>
              <TooltipContent>Import URL from another task</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end" className="max-h-64 w-auto max-w-[50vw] overflow-y-auto">
              {otherTaskUrls.length === 0 ? (
                <div className="px-2 py-1.5 text-sm text-muted-foreground">
                  No URLs from other tasks
                </div>
              ) : (
                otherTaskUrls.map((entry, idx) => (
                  <DropdownMenuItem
                    key={`${entry.taskId}-${idx}`}
                    onClick={() => {
                      if (multiDeviceMode) {
                        updateActiveTab({ url: entry.url })
                        setInputUrl(entry.url)
                      } else {
                        activeActions?.navigate(entry.url)
                      }
                    }}
                    className="flex flex-col items-start gap-0.5"
                  >
                    <span className="text-xs text-muted-foreground truncate w-full">
                      {entry.taskTitle}
                    </span>
                    <span className="text-sm truncate w-full">{entry.url}</span>
                  </DropdownMenuItem>
                ))
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <IconButton
                aria-label={multiDeviceMode ? 'Exit responsive preview' : 'Responsive preview'}
                variant="ghost"
                size="icon-sm"
                disabled={extensionsManagerOpen}
                className={cn(multiDeviceMode && 'text-blue-500 bg-blue-500/10')}
                onClick={toggleMultiDevice}
              >
                <LayoutGrid className="size-4" />
              </IconButton>
            </span>
          </TooltipTrigger>
          <TooltipContent>{multiDeviceMode ? 'Exit responsive preview' : 'Responsive preview'}</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <IconButton
                aria-label="Pick element"
                data-testid="browser-pick-element"
                variant="ghost"
                size="icon-sm"
                disabled={extensionsManagerOpen || !canUseDomPicker || multiDeviceMode || !webviewReady}
                className={cn(isPickingElement && 'text-amber-600 bg-amber-500/15 hover:bg-amber-500/20')}
                onClick={handlePickElement}
              >
                <Crosshair className="size-4" />
              </IconButton>
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {!canUseDomPicker
              ? 'Open terminal panel to pick element'
                : isPickingElement
                ? 'Element picker active (click again to exit)'
                : 'Pick element (⌘⇧L)'}
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <IconButton
                aria-label="Toggle Chromium DevTools"
                data-testid="browser-devtools"
                variant="ghost"
                size="icon-sm"
                disabled={extensionsManagerOpen || multiDeviceMode || !webviewReady}
                className={cn(devToolsOpen && 'text-blue-500 bg-blue-500/10')}
                onClick={toggleDevTools}
              >
                <Bug className="size-4" />
              </IconButton>
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {multiDeviceMode ? 'DevTools unavailable in responsive preview' : 'Toggle Chromium DevTools'}
          </TooltipContent>
        </Tooltip>

        {(() => {
          const themeMode = activeTab?.themeMode ?? 'system'
          const ThemeIcon = themeMode === 'dark' ? Moon : themeMode === 'light' ? Sun : PaintbrushVertical
          const themeLabel = themeMode === 'dark' ? 'Dark (forced)' : themeMode === 'light' ? 'Light (forced)' : 'System theme'
          return (
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <IconButton
                    aria-label={themeLabel}
                    data-testid="browser-theme-mode"
                    variant="ghost"
                    size="icon-sm"
                    disabled={extensionsManagerOpen || multiDeviceMode || !webviewReady}
                    className={cn(
                      themeMode === 'dark' && 'text-blue-400 bg-blue-500/10',
                      themeMode === 'light' && 'text-amber-400 bg-amber-500/10',
                    )}
                    onClick={cycleTheme}
                  >
                    <ThemeIcon className="size-4" />
                  </IconButton>
                </span>
              </TooltipTrigger>
              <TooltipContent>
                {multiDeviceMode ? 'Theme unavailable in responsive preview' : `${themeLabel} — click to cycle`}
              </TooltipContent>
            </Tooltip>
          )
        })()}

        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <IconButton
                aria-label="Keyboard passthrough"
                data-testid="browser-keyboard-passthrough"
                variant="ghost"
                size="icon-sm"
                disabled={extensionsManagerOpen || multiDeviceMode || !webviewReady}
                className={cn(captureShortcuts && 'text-green-500 bg-green-500/10')}
                onClick={toggleCaptureShortcuts}
              >
                <Keyboard className="size-4" />
              </IconButton>
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {captureShortcuts ? 'Webpage shortcuts enabled' : 'Webpage shortcuts disabled'}
          </TooltipContent>
        </Tooltip>

        {EXTENSIONS_MANAGER_ENABLED && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span>
                <IconButton
                  aria-label="Extensions"
                  variant="ghost"
                  size="icon-sm"
                  aria-pressed={extensionsManagerOpen}
                  className={cn(extensionsManagerOpen && 'text-blue-500 bg-blue-500/10')}
                  onClick={handleToggleExtensionsManager}
                >
                  <Puzzle className="size-4" />
                </IconButton>
              </span>
            </TooltipTrigger>
            <TooltipContent>{extensionsManagerOpen ? 'Close extensions manager' : 'Extensions'}</TooltipContent>
          </Tooltip>
        )}
      </div>

      {pickError && !multiDeviceMode && !extensionsManagerOpen && (
        <div className="shrink-0 px-2 py-1.5 border-b text-xs text-destructive bg-destructive/5 truncate" title={pickError}>
          Element picker error: {pickError}
        </div>
      )}

      {/* Responsive toolbar */}
      {multiDeviceMode && !extensionsManagerOpen && (
        <div className="shrink-0 flex items-center py-2 px-2 gap-3 border-b border-border bg-neutral-900">
          {/* Device toggle buttons */}
          {SLOT_BUTTONS.map(({ slot, icon: Icon, label }) => {
            const enabled = multiDeviceConfig[slot].enabled
            return (
              <button
                key={slot}
                onClick={() => toggleSlot(slot)}
                className={cn(
                  'h-8 px-3 flex items-center gap-1.5 text-xs font-medium rounded-lg border transition-colors',
                  enabled
                    ? 'text-blue-400 bg-blue-500/15 border-blue-500/30 hover:bg-blue-500/25'
                    : 'text-neutral-500 border-neutral-700 hover:text-neutral-300 hover:bg-neutral-800'
                )}
              >
                <Icon className="size-3.5" />
                <span>{label}</span>
              </button>
            )
          })}
          <div className="flex-1" />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" className="h-8 px-2 text-xs text-neutral-500 hover:text-neutral-300 gap-1">
                {multiDeviceLayout === 'horizontal' ? 'Side by side' : 'Stacked'}
                <ChevronDown className="size-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={() => setMultiDeviceLayout('horizontal')}
                className={cn(multiDeviceLayout === 'horizontal' && 'text-blue-500 font-medium')}
              >
                Side by side
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => setMultiDeviceLayout('vertical')}
                className={cn(multiDeviceLayout === 'vertical' && 'text-blue-500 font-medium')}
              >
                Stacked
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}

      {/* Webview / Multi-device */}
      {EXTENSIONS_MANAGER_ENABLED && extensionsManagerOpen ? (
        <ExtensionsManagerView
          extensions={extensions}
          browserExtensions={browserExtensions}
          isLoading={extensionsLoading}
          error={extensionsError}
          onRefresh={() => { void refreshExtensions() }}
          onClose={() => setExtensionsManagerOpen(false)}
          onActivate={handleActivateExtension}
          onRemove={(extensionId) => { void handleRemoveExtension(extensionId) }}
          onImport={(path, name) => { void handleImportExtension(path, name) }}
          onLoadUnpacked={() => { void handleLoadExtension() }}
        />
      ) : multiDeviceMode ? (
        <MultiDeviceGrid
          config={multiDeviceConfig}
          layout={multiDeviceLayout}
          url={activeTab?.url || 'about:blank'}
          isResizing={isResizing}
          reloadTrigger={reloadTrigger}
          forceReloadTrigger={forceReloadTrigger}
          onPresetChange={setPreset}
        />
      ) : (
        <div className="relative flex-1 min-h-0">
          {/* Render a placeholder per tab — each owns its own WebContentsView */}
          {tabs.tabs.map(tab => (
            <BrowserTabPlaceholder
              key={tab.id}
              ref={getTabRef(tab.id)}
              tabId={tab.id}
              taskId={taskId || ''}
              url={tab.url || 'about:blank'}
              partition="persist:browser-tabs"
              visible={tab.id === tabs.activeTabId && isActive !== false && !extensionsManagerOpen}
              hidden={!!loadError || extensionsManagerOpen || !activeViewState.hasLoadedRealPage}
              isResizing={isResizing}
              className="absolute inset-0"
              onStateChange={tab.id === tabs.activeTabId ? setActiveViewState : undefined}
              onOverlayChange={tab.id === tabs.activeTabId ? setHiddenByOverlay : undefined}
            />
          ))}
          {!activeViewState.hasLoadedRealPage && !loadError && !hiddenByOverlay && (
            <div data-testid="browser-loading-animation" className="absolute inset-0 z-10 bg-background">
              <BrowserLoadingAnimation />
            </div>
          )}
          {loadError && (
            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-[#1a1a1a] text-neutral-400 gap-3">
              <div className="text-sm font-medium text-neutral-300">Failed to load page</div>
              <div className="text-xs text-neutral-500 max-w-xs text-center truncate" title={loadError.url}>
                {loadError.description} ({loadError.code})
              </div>
              <button
                className="inline-flex items-center gap-1.5 rounded-md border border-neutral-700 bg-neutral-800 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-700"
                onClick={() => { setActiveViewState(prev => ({ ...prev, error: null })); activeActions?.reload() }}
              >
                <RotateCw className="size-3.5" />
                Retry
              </button>
            </div>
          )}
          {isPickingElement && (
            <div data-testid="browser-picker-active-overlay" className="absolute inset-0 z-10 pointer-events-none border-2 border-amber-500/70 bg-amber-500/8">
              <div className="absolute top-2 left-2 rounded bg-amber-500 text-black text-[11px] px-2 py-1 font-medium">
                Element picker active
              </div>
            </div>
          )}
          {isResizing && <div className="absolute inset-0 z-10" />}
          {hiddenByOverlay && !loadError && (
            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-gradient-to-b from-background/95 via-background/90 to-background/95 overflow-hidden">
              {/* Decorative ornaments */}
              <div className="pointer-events-none absolute inset-0">
                {/* Dot grid */}
                <svg className="absolute inset-0 size-full opacity-[0.07]">
                  <defs>
                    <pattern id="browser-dots" x="0" y="0" width="24" height="24" patternUnits="userSpaceOnUse">
                      <circle cx="2" cy="2" r="1" fill="currentColor" />
                    </pattern>
                  </defs>
                  <rect width="100%" height="100%" fill="url(#browser-dots)" />
                </svg>
                {/* Concentric arcs */}
                <svg className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 size-[32rem]" viewBox="0 0 400 400" fill="none">
                  <circle cx="200" cy="200" r="180" stroke="currentColor" strokeWidth="0.5" strokeDasharray="8 12" className="text-muted-foreground/10" />
                  <circle cx="200" cy="200" r="140" stroke="currentColor" strokeWidth="0.5" strokeDasharray="4 16" className="text-muted-foreground/8" />
                  <path d="M 200 40 A 160 160 0 0 1 360 200" stroke="currentColor" strokeWidth="1" className="text-muted-foreground/15" />
                  <path d="M 200 360 A 160 160 0 0 1 40 200" stroke="currentColor" strokeWidth="1" className="text-muted-foreground/15" />
                </svg>
              </div>
              <p className="text-3xl font-semibold tracking-tight text-muted-foreground/60">Browser paused</p>
              <p className="text-base text-muted-foreground/40">Temporarily hidden while a popup is open</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
})
