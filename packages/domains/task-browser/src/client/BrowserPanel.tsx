import { useState, useRef, useEffect, useCallback, forwardRef, useImperativeHandle } from 'react'
import { ArrowLeft, ArrowRight, RotateCw, X, Plus, Import, Smartphone, Monitor, Tablet, LayoutGrid, ChevronDown, Crosshair, Bug, Sun, Moon, PaintbrushVertical } from 'lucide-react'
import type { BrowserTabTheme } from '../shared'
import {
  Button,
  Input,
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

// Minimal webview interface for type safety
interface WebviewElement extends HTMLElement {
  canGoBack(): boolean
  canGoForward(): boolean
  goBack(): void
  goForward(): void
  reload(): void
  reloadIgnoringCache(): void
  stop(): void
  loadURL(url: string): void
  getURL(): string
  getWebContentsId(): number
  isDevToolsOpened?(): boolean
  openDevTools?(): void
  closeDevTools?(): void
  executeJavaScript<T = unknown>(code: string, userGesture?: boolean): Promise<T>
  insertCSS(css: string): Promise<string>
  removeInsertedCSS(key: string): Promise<void>
}

const THEME_CSS: Record<'light' | 'dark', string> = {
  dark: [
    'html{filter:invert(90%) hue-rotate(180deg)!important}',
    'img,video,canvas,svg,iframe{filter:invert(90%) hue-rotate(180deg)!important}',
  ].join(''),
  light: ':root{color-scheme:light!important}',
}

const THEME_CYCLE: BrowserTabTheme[] = ['system', 'dark', 'light']

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
}

function generateTabId(): string {
  return `tab-${crypto.randomUUID().slice(0, 8)}`
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
  const [inputUrl, setInputUrl] = useState('')
  const [canGoBack, setCanGoBack] = useState(false)
  const [canGoForward, setCanGoForward] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [isFocused, setIsFocused] = useState(false)
  const [webviewReady, setWebviewReady] = useState(false)
  const [otherTaskUrls, setOtherTaskUrls] = useState<TaskUrlEntry[]>([])
  const [importDropdownOpen, setImportDropdownOpen] = useState(false)
  const [reloadTrigger, setReloadTrigger] = useState(0)
  const [forceReloadTrigger, setForceReloadTrigger] = useState(0)
  const [webviewId, setWebviewId] = useState<number | null>(null)
  const [devToolsStatus, setDevToolsStatus] = useState<string | null>(null)
  const [inlineDevToolsOpen, setInlineDevToolsOpen] = useState(false)
  const [inlineDevToolsAttached, setInlineDevToolsAttached] = useState(false)
  const [inlineAttachTick, setInlineAttachTick] = useState(0)
  const [inlineDevToolsHeight, setInlineDevToolsHeight] = useState(300)
  const [isDraggingInlineDevTools, setIsDraggingInlineDevTools] = useState(false)
  const [isPickingElement, setIsPickingElement] = useState(false)
  const [pickError, setPickError] = useState<string | null>(null)
  const webviewRef = useRef<WebviewElement>(null)
  const inlineDevToolsPanelRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const inlineAttachAttemptRef = useRef(0)
  const darkModeCSSKeyRef = useRef<string | null>(null)

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
  const [defaultConfig] = useState(defaultMultiDeviceConfig)
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
    if (!entering) setWebviewReady(false) // reset — single webview will remount
    updateActiveTab({
      multiDeviceMode: entering,
      ...(entering && !activeTab.multiDeviceConfig ? { multiDeviceConfig: defaultMultiDeviceConfig() } : {}),
      ...(entering && !activeTab.multiDeviceLayout ? { multiDeviceLayout: 'horizontal' as GridLayout } : {}),
    })
  }, [activeTab, multiDeviceMode, updateActiveTab])

  const applyThemeCss = useCallback((mode: BrowserTabTheme) => {
    const wv = webviewRef.current
    if (!wv) return
    const removeOld = async () => {
      const key = darkModeCSSKeyRef.current
      if (key) { darkModeCSSKeyRef.current = null; await wv.removeInsertedCSS(key).catch(() => {}) }
    }
    void (async () => {
      await removeOld()
      const css = mode === 'system' ? null : THEME_CSS[mode]
      if (css) darkModeCSSKeyRef.current = await wv.insertCSS(css).catch(() => null)
    })()
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

  // Tab callbacks
  const createNewTab = useCallback((url = 'about:blank') => {
    const newTab: BrowserTab = {
      id: generateTabId(),
      url,
      title: url === 'about:blank' ? 'New Tab' : url
    }
    onTabsChange({
      tabs: [...tabs.tabs, newTab],
      activeTabId: newTab.id
    })
  }, [tabs, onTabsChange])

  const closeTab = useCallback((tabId: string) => {
    const idx = tabs.tabs.findIndex(t => t.id === tabId)
    const newTabs = tabs.tabs.filter(t => t.id !== tabId)

    let newActiveId = tabs.activeTabId
    if (tabId === tabs.activeTabId) {
      if (newTabs.length === 0) {
        const newTab: BrowserTab = { id: generateTabId(), url: 'about:blank', title: 'New Tab' }
        onTabsChange({ tabs: [newTab], activeTabId: newTab.id })
        return
      }
      newActiveId = newTabs[Math.min(idx, newTabs.length - 1)]?.id || null
    }

    onTabsChange({ tabs: newTabs, activeTabId: newActiveId })
  }, [tabs, onTabsChange])

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

  // Load URL when active tab changes (single webview only)
  useEffect(() => {
    const wv = webviewRef.current
    if (!wv || !activeTab || !webviewReady || multiDeviceMode) return

    const currentUrl = wv.getURL()
    if (activeTab.url && activeTab.url !== currentUrl && activeTab.url !== 'about:blank') {
      wv.loadURL(activeTab.url.replace(/^file:\/\//, 'slz-file://'))
    }
  }, [activeTab?.id, webviewReady, multiDeviceMode])

  // Refs for stable event handler closures (avoids tearing down listeners on every tabs change)
  const tabsRef = useRef(tabs)
  const onTabsChangeRef = useRef(onTabsChange)
  const createNewTabRef = useRef(createNewTab)
  tabsRef.current = tabs
  onTabsChangeRef.current = onTabsChange
  createNewTabRef.current = createNewTab

  // Webview event listeners — attach once, read latest state via refs
  useEffect(() => {
    const wv = webviewRef.current
    if (!wv) return

    const handleNavigate = () => {
      setCanGoBack(wv.canGoBack())
      setCanGoForward(wv.canGoForward())
      const url = wv.getURL().replace(/^slz-file:\/\//, 'file://')
      setInputUrl(url)

      const t = tabsRef.current
      if (t.activeTabId) {
        onTabsChangeRef.current({
          ...t,
          tabs: t.tabs.map(tab =>
            tab.id === t.activeTabId ? { ...tab, url } : tab
          )
        })
      }
    }

    const handleStartLoading = () => setIsLoading(true)
    const handleStopLoading = () => setIsLoading(false)

    const handleTitleUpdate = (e: Event) => {
      const title = (e as CustomEvent).detail?.title || ''
      const t = tabsRef.current
      if (t.activeTabId && title) {
        onTabsChangeRef.current({
          ...t,
          tabs: t.tabs.map(tab =>
            tab.id === t.activeTabId ? { ...tab, title } : tab
          )
        })
      }
    }

    const handleFaviconUpdate = (e: Event) => {
      const favicons = (e as CustomEvent).detail?.favicons as string[] | undefined
      const favicon = favicons?.[0]
      const t = tabsRef.current
      if (t.activeTabId && favicon) {
        onTabsChangeRef.current({
          ...t,
          tabs: t.tabs.map(tab =>
            tab.id === t.activeTabId ? { ...tab, favicon } : tab
          )
        })
      }
    }

    const handleNewWindow = (e: Event) => {
      const url = (e as CustomEvent).detail?.url
      if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) return
      createNewTabRef.current(url)
    }

    const handleDomReady = () => {
      setWebviewReady(true)
      darkModeCSSKeyRef.current = null
      try {
        const id = wv.getWebContentsId()
        setWebviewId(id)
        void window.api.webview.registerShortcuts(id)
      } catch {
        setWebviewId(null)
      }
      const t = tabsRef.current
      const activeTabData = t.tabs.find(tab => tab.id === t.activeTabId)
      const mode = activeTabData?.themeMode ?? 'system'
      if (mode !== 'system') {
        void wv.insertCSS(THEME_CSS[mode]).then(key => { darkModeCSSKeyRef.current = key }).catch(() => {})
      }
    }

    const handleWebviewFocus = () => wv.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))

    wv.addEventListener('dom-ready', handleDomReady)
    wv.addEventListener('did-navigate', handleNavigate)
    wv.addEventListener('did-navigate-in-page', handleNavigate)
    wv.addEventListener('did-start-loading', handleStartLoading)
    wv.addEventListener('did-stop-loading', handleStopLoading)
    wv.addEventListener('page-title-updated', handleTitleUpdate)
    wv.addEventListener('page-favicon-updated', handleFaviconUpdate)
    wv.addEventListener('new-window', handleNewWindow)
    wv.addEventListener('focus', handleWebviewFocus)

    return () => {
      wv.removeEventListener('dom-ready', handleDomReady)
      wv.removeEventListener('did-navigate', handleNavigate)
      wv.removeEventListener('did-navigate-in-page', handleNavigate)
      wv.removeEventListener('did-start-loading', handleStartLoading)
      wv.removeEventListener('did-stop-loading', handleStopLoading)
      wv.removeEventListener('page-title-updated', handleTitleUpdate)
      wv.removeEventListener('page-favicon-updated', handleFaviconUpdate)
      wv.removeEventListener('focus', handleWebviewFocus)
      wv.removeEventListener('new-window', handleNewWindow)
    }
  }, []) // stable callbacks via refs

  const getInlineDevToolsBounds = useCallback(() => {
    const el = inlineDevToolsPanelRef.current
    if (!el) return null
    const rect = el.getBoundingClientRect()
    if (rect.width < 2 || rect.height < 2) return null
    return {
      x: Math.floor(rect.left),
      y: Math.floor(rect.top),
      width: Math.floor(rect.width),
      height: Math.floor(rect.height)
    }
  }, [])

  const syncInlineDevToolsBounds = useCallback(() => {
    const bounds = getInlineDevToolsBounds()
    if (!bounds) return
    void window.api.webview.updateDevToolsInlineBounds(bounds)
  }, [getInlineDevToolsBounds])

  const startInlineDevToolsResize = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault()
    setIsDraggingInlineDevTools(true)
    const startY = event.clientY
    const startHeight = inlineDevToolsHeight

    const onMouseMove = (moveEvent: MouseEvent) => {
      const delta = startY - moveEvent.clientY
      const maxHeight = Math.max(300, Math.floor(window.innerHeight * 0.75))
      const nextHeight = Math.max(200, Math.min(maxHeight, startHeight + delta))
      setInlineDevToolsHeight(nextHeight)
    }

    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
      setIsDraggingInlineDevTools(false)
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }, [inlineDevToolsHeight])

  useEffect(() => {
    if (!inlineDevToolsOpen) return undefined
    if (inlineDevToolsAttached) return undefined
    if (webviewId === null) return undefined
    const bounds = getInlineDevToolsBounds()
    if (!bounds) {
      const retry = window.setTimeout(() => setInlineAttachTick((n) => n + 1), 120)
      return () => window.clearTimeout(retry)
    }

    const attempt = ++inlineAttachAttemptRef.current
    void (async () => {
      try {
        setDevToolsStatus(`Attaching inline Chromium DevTools (target:${webviewId})...`)
        const result = await Promise.race<Awaited<ReturnType<typeof window.api.webview.openDevToolsInline>> | 'timeout'>([
          window.api.webview.openDevToolsInline(webviewId, bounds),
          new Promise<'timeout'>((resolve) => window.setTimeout(() => resolve('timeout'), 10000))
        ])
        if (attempt !== inlineAttachAttemptRef.current) return
        if (result === 'timeout') {
          setInlineDevToolsAttached(false)
          setDevToolsStatus('Inline Chromium DevTools attach timed out (10s)')
          return
        }
        if (!result.ok) {
          setInlineDevToolsAttached(false)
          setInlineDevToolsOpen(false)
          const details = [
            `reason=${result.reason}`,
            result.targetType ? `targetType=${result.targetType}` : null,
            result.hostType ? `hostType=${result.hostType}` : null,
            result.attempts?.length ? `attempts=[${result.attempts.join(', ')}]` : null,
          ].filter(Boolean).join(' ')
          setDevToolsStatus(`Inline DevTools failed (${details || 'no details'}) — opening native`)
          void window.api.webview.openDevToolsDetached(webviewId)
          return
        }
        setInlineDevToolsAttached(true)
        setDevToolsStatus(
          result.mode
            ? `Chromium DevTools opened inline (mode=${result.mode}${result.deviceToolbar ? ` deviceToolbar=${result.deviceToolbar}` : ''})`
            : 'Chromium DevTools opened inline'
        )
      } catch (err) {
        if (attempt !== inlineAttachAttemptRef.current) return
        const message = err instanceof Error ? err.message : String(err)
        setInlineDevToolsOpen(false)
        setInlineDevToolsAttached(false)
        setDevToolsStatus(`Inline DevTools error: ${message} — opening native`)
        if (webviewId !== null) void window.api.webview.openDevToolsDetached(webviewId)
      }
    })()
    return undefined
  }, [inlineDevToolsOpen, inlineDevToolsAttached, webviewId, inlineAttachTick, getInlineDevToolsBounds])

  useEffect(() => {
    if (!inlineDevToolsOpen) return
    if (!inlineDevToolsAttached) return

    syncInlineDevToolsBounds()
    const onWindowResize = () => syncInlineDevToolsBounds()
    window.addEventListener('resize', onWindowResize)
    const timer = window.setInterval(syncInlineDevToolsBounds, 250)
    return () => {
      window.removeEventListener('resize', onWindowResize)
      window.clearInterval(timer)
    }
  }, [inlineDevToolsOpen, inlineDevToolsAttached, syncInlineDevToolsBounds])

  useEffect(() => {
    if (!inlineDevToolsOpen || !inlineDevToolsAttached) return
    const timer = window.setTimeout(() => {
      syncInlineDevToolsBounds()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [inlineDevToolsOpen, inlineDevToolsAttached, inlineDevToolsHeight, syncInlineDevToolsBounds])

  // Keyboard shortcuts when focused
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isFocused) return
      if (e.metaKey && e.key === 't') { e.preventDefault(); createNewTab() }
      if (e.metaKey && e.key === 'w') { e.preventDefault(); if (tabs.activeTabId) closeTab(tabs.activeTabId) }
      if (e.ctrlKey && e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); switchToNextTab() }
      if (e.ctrlKey && e.key === 'Tab' && e.shiftKey) { e.preventDefault(); switchToPrevTab() }
    }

    container.addEventListener('keydown', handleKeyDown)
    return () => container.removeEventListener('keydown', handleKeyDown)
  }, [isFocused, tabs, createNewTab, closeTab, switchToNextTab, switchToPrevTab])

  const handleNavigate = () => {
    if (!inputUrl.trim()) return

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

    const wv = webviewRef.current
    if (!wv) return
    if (url.startsWith('file://')) {
      url = url.replace('file://', 'slz-file://')
    }
    wv.loadURL(url)
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
    if (multiDeviceMode || !webviewReady) {
      setDevToolsStatus(multiDeviceMode ? 'DevTools unavailable in responsive preview' : 'Webview not ready yet')
      return
    }
    const wv = webviewRef.current
    if (!wv) {
      setDevToolsStatus('No active webview')
      return
    }

    void (async () => {
      try {
        const id = webviewId ?? wv.getWebContentsId()
        if (inlineDevToolsOpen) {
          // Keep DevTools attached (off-screen) — just hide the panel to avoid popup on next open
          setInlineDevToolsOpen(false)
          setDevToolsStatus('Chromium DevTools closed')
          return
        }
        if (inlineDevToolsAttached) {
          // Already attached (stay-attached after close) — no IPC, just show the panel
          setInlineDevToolsOpen(true)
          setDevToolsStatus('Chromium DevTools opened inline')
          return
        }
        // Not yet attached — start attach
        const opened = await window.api.webview.isDevToolsOpened(id)
        if (opened) await window.api.webview.closeDevTools(id)
        setInlineDevToolsOpen(true)
        setDevToolsStatus('Preparing inline Chromium DevTools...')
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        setDevToolsStatus(`DevTools error: ${message}`)
      }
    })()
  }, [multiDeviceMode, webviewReady, webviewId, inlineDevToolsOpen, inlineDevToolsAttached])

  useEffect(() => {
    if (multiDeviceMode) {
      void window.api.webview.closeDevToolsInline(webviewId ?? undefined)
      setInlineDevToolsOpen(false)
      setInlineDevToolsAttached(false)
    }
  }, [multiDeviceMode, activeTab?.id, webviewId])

  useEffect(() => {
    if (!inlineDevToolsAttached) return
    if (isActive === false || !inlineDevToolsOpen) {
      void window.api.webview.updateDevToolsInlineBounds({ x: -10000, y: -10000, width: 1, height: 1 })
    } else {
      syncInlineDevToolsBounds()
    }
  }, [isActive, inlineDevToolsOpen, inlineDevToolsAttached, syncInlineDevToolsBounds])

  useEffect(() => {
    if (!inlineDevToolsOpen || inlineDevToolsAttached) return
    const timer = window.setTimeout(() => {
      setDevToolsStatus(
        `Still preparing inline Chromium DevTools (target:${webviewId ?? 'pending'})`
      )
    }, 4000)
    return () => window.clearTimeout(timer)
  }, [inlineDevToolsOpen, inlineDevToolsAttached, webviewId])

  const cancelPickElement = useCallback(async () => {
    const wv = webviewRef.current
    if (!wv) return
    try {
      await wv.executeJavaScript<boolean>(DOM_PICKER_CANCEL_SCRIPT, true)
    } catch {
      // ignore cancellation errors
    }
    setIsPickingElement(false)
  }, [])

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
    if (!canUseDomPicker || multiDeviceMode || isPickingElement) return
    const wv = webviewRef.current
    const activeTabId = tabs.activeTabId
    if (!wv || !activeTabId) return

    setIsPickingElement(true)
    setPickError(null)
    try {
      const payload = await wv.executeJavaScript<PickedDomPayload | null>(DOM_PICKER_SCRIPT, true)
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
  }, [canUseDomPicker, isPickingElement, multiDeviceMode, tabs.activeTabId])

  const handlePickElement = useCallback(() => {
    if (isPickingElement) {
      void cancelPickElement()
      return
    }
    void startPickElement()
  }, [isPickingElement, cancelPickElement, startPickElement])

  useEffect(() => {
    return window.api.webview.onShortcut(({ key, shift, webviewId: incomingId }) => {
      if (webviewId === null || incomingId !== webviewId) return
      if (!shift) return
      if (key === 'l') {
        handlePickElement()
      }
    })
  }, [webviewId, handlePickElement])

  useImperativeHandle(ref, () => ({
    pickElement: () => {
      handlePickElement()
    }
  }), [handlePickElement])

  useEffect(() => {
    return () => {
      if (!isPickingElement) return
      void cancelPickElement()
    }
  }, [isPickingElement, cancelPickElement])

  useEffect(() => {
    return () => {
      void window.api.webview.closeDevToolsInline(webviewId ?? undefined)
    }
  }, [webviewId])

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
      <div className="shrink-0 flex items-center h-10 px-2 gap-1 border-b border-border overflow-x-auto scrollbar-hide">
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
                aria-label="Close tab"
                onClick={(e) => { e.stopPropagation(); closeTab(tab.id) }}
                className="h-4 w-4 rounded hover:bg-muted-foreground/20 flex items-center justify-center"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          )
        })}
        <button
          aria-label="New tab"
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
              <Button aria-label="Back" variant="ghost" size="icon-sm" disabled={!canGoBack || multiDeviceMode} onClick={() => webviewRef.current?.goBack()}>
                <ArrowLeft className="size-4" />
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>Back</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <Button aria-label="Forward" variant="ghost" size="icon-sm" disabled={!canGoForward || multiDeviceMode} onClick={() => webviewRef.current?.goForward()}>
                <ArrowRight className="size-4" />
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>Forward</TooltipContent>
        </Tooltip>
        <ContextMenu>
          <Tooltip>
            <ContextMenuTrigger asChild>
              <TooltipTrigger asChild>
                <span>
                  <Button
                    aria-label="Reload"
                    variant="ghost"
                    size="icon-sm"
                    onClick={(e) => {
                      if (multiDeviceMode) {
                        if (e.shiftKey) setForceReloadTrigger(r => r + 1)
                        else setReloadTrigger(r => r + 1)
                      } else if (isLoading) {
                        webviewRef.current?.stop()
                      } else if (e.shiftKey) {
                        webviewRef.current?.reloadIgnoringCache()
                      } else {
                        webviewRef.current?.reload()
                      }
                    }}
                  >
                    {isLoading && !multiDeviceMode ? <X className="size-4" /> : <RotateCw className="size-4" />}
                  </Button>
                </span>
              </TooltipTrigger>
            </ContextMenuTrigger>
            <TooltipContent>{isLoading && !multiDeviceMode ? 'Stop loading' : 'Reload'}</TooltipContent>
          </Tooltip>
          <ContextMenuContent>
            <ContextMenuItem onClick={() => {
              if (multiDeviceMode) setReloadTrigger(r => r + 1)
              else webviewRef.current?.reload()
            }}>
              Reload
              <ContextMenuShortcut>⌘R</ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuItem onClick={() => {
              if (multiDeviceMode) setForceReloadTrigger(r => r + 1)
              else webviewRef.current?.reloadIgnoringCache()
            }}>
              Hard Reload
              <ContextMenuShortcut>⇧⌘R</ContextMenuShortcut>
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>

        <Input
          value={inputUrl}
          onChange={(e) => setInputUrl(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Enter URL..."
          className="flex-1 h-7 text-sm"
        />

        {taskId && (
          <DropdownMenu open={importDropdownOpen} onOpenChange={setImportDropdownOpen}>
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <DropdownMenuTrigger asChild>
                    <Button aria-label="Import URL from another task" variant="ghost" size="icon-sm">
                      <Import className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                </span>
              </TooltipTrigger>
              <TooltipContent>Import URL from another task</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end" className="max-h-64 overflow-y-auto w-80">
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
                        webviewRef.current?.loadURL(entry.url)
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
              <Button
                aria-label="Responsive preview"
                variant="ghost"
                size="icon-sm"
                className={cn(multiDeviceMode && 'text-blue-500 bg-blue-500/10')}
                onClick={toggleMultiDevice}
              >
                <LayoutGrid className="size-4" />
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>{multiDeviceMode ? 'Exit responsive preview' : 'Responsive preview'}</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <Button
                aria-label="Pick element"
                data-testid="browser-pick-element"
                variant="ghost"
                size="icon-sm"
                disabled={!canUseDomPicker || multiDeviceMode || !webviewReady}
                className={cn(isPickingElement && 'text-amber-600 bg-amber-500/15 hover:bg-amber-500/20')}
                onClick={handlePickElement}
              >
                <Crosshair className="size-4" />
              </Button>
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
              <Button
                aria-label="Toggle DevTools"
                data-testid="browser-devtools"
                variant="ghost"
                size="icon-sm"
                disabled={multiDeviceMode || !webviewReady}
                className={cn(inlineDevToolsOpen && 'text-blue-500 bg-blue-500/10')}
                onClick={toggleDevTools}
              >
                <Bug className="size-4" />
              </Button>
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
                  <Button
                    aria-label="Cycle theme"
                    data-testid="browser-theme-mode"
                    variant="ghost"
                    size="icon-sm"
                    disabled={multiDeviceMode || !webviewReady}
                    className={cn(
                      themeMode === 'dark' && 'text-blue-400 bg-blue-500/10',
                      themeMode === 'light' && 'text-amber-400 bg-amber-500/10',
                    )}
                    onClick={cycleTheme}
                  >
                    <ThemeIcon className="size-4" />
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>
                {multiDeviceMode ? 'Theme unavailable in responsive preview' : `${themeLabel} — click to cycle`}
              </TooltipContent>
            </Tooltip>
          )
        })()}
      </div>

      {pickError && !multiDeviceMode && (
        <div className="shrink-0 px-2 py-1.5 border-b text-xs text-destructive bg-destructive/5 truncate" title={pickError}>
          Element picker error: {pickError}
        </div>
      )}
      {devToolsStatus && !multiDeviceMode && (
        <div
          data-testid="browser-devtools-status"
          className="shrink-0 px-2 py-1 border-b text-[11px] text-muted-foreground bg-muted/10 truncate"
          title={devToolsStatus}
        >
          {devToolsStatus}
        </div>
      )}

      {/* Responsive toolbar */}
      {multiDeviceMode && (
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
      {multiDeviceMode ? (
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
        <div className="relative flex-1 min-h-0 flex flex-col">
          <div className="relative min-w-0 flex-1 min-h-0">
            <webview
              ref={webviewRef}
              src={(activeTab?.url || 'about:blank').replace(/^file:\/\//, 'slz-file://')}
              partition="persist:browser-tabs"
              className="absolute inset-0"
              // @ts-expect-error - webview attributes not in React types
              allowpopups="true"
            />
            {isPickingElement && (
              <div data-testid="browser-picker-active-overlay" className="absolute inset-0 z-10 pointer-events-none border-2 border-amber-500/70 bg-amber-500/8">
                <div className="absolute top-2 left-2 rounded bg-amber-500 text-black text-[11px] px-2 py-1 font-medium">
                  Element picker active
                </div>
              </div>
            )}
            {isResizing && <div className="absolute inset-0 z-10" />}
          </div>
          {inlineDevToolsOpen && (
            <>
              <div
                className="w-full h-1 shrink-0 cursor-row-resize bg-border/30 hover:bg-border/60"
                onMouseDown={startInlineDevToolsResize}
                title="Drag to resize DevTools"
              />
              <div
                ref={inlineDevToolsPanelRef}
                data-testid="browser-devtools-panel"
                className="shrink-0 border-t border-border bg-black/90 w-full"
                style={{ height: `${inlineDevToolsHeight}px` }}
              >
                {!inlineDevToolsAttached && (
                  <div className="h-full w-full flex items-center justify-center text-xs text-neutral-400">
                    Attaching Chromium DevTools...
                  </div>
                )}
              </div>
            </>
          )}
          {inlineDevToolsOpen && isDraggingInlineDevTools && (
            <div className="absolute inset-0 z-20 cursor-row-resize" />
          )}
        </div>
      )}
    </div>
  )
})
