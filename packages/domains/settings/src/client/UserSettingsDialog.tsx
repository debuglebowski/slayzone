import { useState, useEffect, useRef } from 'react'
import { XIcon, Pencil, Trash2, Plus, Settings2, SquareTerminal, Globe, FileCode, GitCompare, SlidersHorizontal, FolderOpen } from 'lucide-react'
import { SettingsLayout, Tooltip, TooltipTrigger, TooltipContent } from '@slayzone/ui'
import { Button } from '@slayzone/ui'
import { Input } from '@slayzone/ui'
import { Label } from '@slayzone/ui'
import { Switch } from '@slayzone/ui'
import { toast } from '@slayzone/ui'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@slayzone/ui'
import type { Tag } from '@slayzone/tags/shared'
import type { TerminalMode } from '@slayzone/terminal/shared'
import type { PanelConfig, WebPanelDefinition } from '@slayzone/task/shared'
import {
  DEFAULT_PANEL_CONFIG,
  PROVIDER_DEFAULTS,
  inferHostScopeFromUrl,
  inferProtocolFromUrl,
  mergePredefinedWebPanels,
  normalizeDesktopProtocol,
} from '@slayzone/task/shared'
import type { DiagnosticsConfig } from '@slayzone/types'
import type { IntegrationConnectionPublic } from '@slayzone/integrations/shared'
import { useTelemetry, TelemetrySettings } from '@slayzone/telemetry/client'
import { ContextManagerSettings } from '../../../ai-config/src/client/ContextManagerSettings'
function TelemetrySettingsTab() {
  const { tier, setTier } = useTelemetry()
  return <TelemetrySettings tier={tier} onTierChange={setTier} />
}

interface UserSettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialTab?: string
  onTabChange?: (tab: string) => void
}

export function UserSettingsDialog({
  open,
  onOpenChange,
  initialTab = 'general',
  onTabChange
}: UserSettingsDialogProps) {
  const [activeTab, setActiveTab] = useState(initialTab)
  const [tags, setTags] = useState<Tag[]>([])
  const [newTagName, setNewTagName] = useState('')
  const [newTagColor, setNewTagColor] = useState('#6b7280')
  const [editingTag, setEditingTag] = useState<Tag | null>(null)
  const [dbPath, setDbPath] = useState<string>('')
  const [worktreeBasePath, setWorktreeBasePath] = useState('')
  const [autoCreateWorktreeOnTaskCreate, setAutoCreateWorktreeOnTaskCreate] = useState(false)
  const [projectColorTints, setProjectColorTints] = useState(true)
  const [terminalFontSize, setTerminalFontSize] = useState('13')
  const [editorFontSize, setEditorFontSize] = useState('13')
  const [reduceMotion, setReduceMotion] = useState(false)
  const [devServerToastEnabled, setDevServerToastEnabled] = useState(true)
  const [devServerAutoOpenBrowser, setDevServerAutoOpenBrowser] = useState(false)
  const [mcpPort, setMcpPort] = useState('45678')
  const [defaultTerminalMode, setDefaultTerminalMode] = useState<TerminalMode>('claude-code')
  const [defaultProviderFlags, setDefaultProviderFlags] = useState<Record<string, string>>(
    Object.fromEntries(Object.entries(PROVIDER_DEFAULTS).map(([mode, def]) => [mode, def.fallback]))
  )
  const [diagnosticsConfig, setDiagnosticsConfig] = useState<DiagnosticsConfig | null>(null)
  const [retentionDaysInput, setRetentionDaysInput] = useState('14')
  const [exportRange, setExportRange] = useState<'15m' | '1h' | '24h' | '7d'>('1h')
  const [exportingDiagnostics, setExportingDiagnostics] = useState(false)
  const [diagnosticsMessage, setDiagnosticsMessage] = useState('')
  const [linearApiKey, setLinearApiKey] = useState('')
  const [linearAccountLabel, setLinearAccountLabel] = useState('')
  const [connections, setConnections] = useState<IntegrationConnectionPublic[]>([])
  const [syncingIntegrations, setSyncingIntegrations] = useState(false)
  const [integrationsMessage, setIntegrationsMessage] = useState('')
  // Panel config state
  const [panelConfig, setPanelConfig] = useState<PanelConfig>(DEFAULT_PANEL_CONFIG)
  const [newPanelName, setNewPanelName] = useState('')
  const [newPanelUrl, setNewPanelUrl] = useState('')
  const [newPanelShortcut, setNewPanelShortcut] = useState('')
  const [newPanelBlockDesktopHandoff, setNewPanelBlockDesktopHandoff] = useState(false)
  const [newPanelHandoffProtocol, setNewPanelHandoffProtocol] = useState('')
  const [newPanelProtocolError, setNewPanelProtocolError] = useState('')
  const [panelShortcutError, setPanelShortcutError] = useState('')
  const [configuringNativeId, setConfiguringNativeId] = useState<string | null>(null)
  // Edit mode for external panels
  const [editingPanelId, setEditingPanelId] = useState<string | null>(null)
  const [editPanelName, setEditPanelName] = useState('')
  const [editPanelUrl, setEditPanelUrl] = useState('')
  const [editPanelShortcut, setEditPanelShortcut] = useState('')
  const [editPanelBlockDesktopHandoff, setEditPanelBlockDesktopHandoff] = useState(false)
  const [editPanelHandoffProtocol, setEditPanelHandoffProtocol] = useState('')
  const [editPanelProtocolError, setEditPanelProtocolError] = useState('')
  const [editShortcutError, setEditShortcutError] = useState('')
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([])
  const [exportProjectId, setExportProjectId] = useState('')
  const [importedProjects, setImportedProjects] = useState<Array<{ id: string; name: string; path: string }>>([])
  const [cliInstalled, setCliInstalled] = useState(false)
  const [cliInstalling, setCliInstalling] = useState(false)
  const [cliMessage, setCliMessage] = useState('')
  const [leaderboardEnabled, setLeaderboardEnabled] = useState(false)
  const loadRequestIdRef = useRef(0)

  useEffect(() => {
    if (open) {
      setActiveTab(initialTab)
      loadData()
    }
  }, [open, initialTab])

  useEffect(() => {
    if (!open) return

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onOpenChange(false)
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onOpenChange])

  const loadData = async () => {
    const requestId = ++loadRequestIdRef.current
    const isStale = () => requestId !== loadRequestIdRef.current

    try {
      const providerFlagKeys = Object.values(PROVIDER_DEFAULTS).map(d => d.settingsKey)
      const [loadedTags, loadedProjects, path, wtBasePath, autoCreateWorktree, termMode, ...flagResults] = await Promise.allSettled([
        window.api.tags.getTags(),
        window.api.db.getProjects(),
        window.api.settings.get('database_path'),
        window.api.settings.get('worktree_base_path'),
        window.api.settings.get('auto_create_worktree_on_task_create'),
        window.api.settings.get('default_terminal_mode'),
        ...providerFlagKeys.map(k => window.api.settings.get(k)),
      ])
      const [devToast, devAutoOpen, mcpPortSetting, cliStatus, colorTints, termFontSize, editorFontSizeVal, reduceMotionVal, leaderboardVal] = await Promise.allSettled([
        window.api.settings.get('dev_server_toast_enabled'),
        window.api.settings.get('dev_server_auto_open_browser'),
        window.api.settings.get('mcp_server_port'),
        window.api.app.cliStatus(),
        window.api.settings.get('project_color_tints_enabled'),
        window.api.settings.get('terminal_font_size'),
        window.api.settings.get('editor_font_size'),
        window.api.settings.get('reduce_motion'),
        window.api.settings.get('leaderboard_enabled')
      ])
      if (isStale()) return

      setCliInstalled(cliStatus.status === 'fulfilled' ? cliStatus.value.installed : false)
      setLeaderboardEnabled(leaderboardVal.status === 'fulfilled' ? leaderboardVal.value === '1' : false)

      setTags(loadedTags.status === 'fulfilled' ? loadedTags.value : [])
      setProjects(loadedProjects.status === 'fulfilled' ? loadedProjects.value : [])
      setDbPath(path.status === 'fulfilled' ? (path.value ?? 'Default location (userData)') : 'Default location (userData)')
      setWorktreeBasePath(wtBasePath.status === 'fulfilled' ? (wtBasePath.value ?? '') : '')
      setAutoCreateWorktreeOnTaskCreate(
        autoCreateWorktree.status === 'fulfilled' ? autoCreateWorktree.value === '1' : false
      )
      setProjectColorTints(colorTints.status === 'fulfilled' ? colorTints.value !== '0' : true)
      setTerminalFontSize(termFontSize.status === 'fulfilled' && termFontSize.value ? termFontSize.value : '13')
      setEditorFontSize(editorFontSizeVal.status === 'fulfilled' && editorFontSizeVal.value ? editorFontSizeVal.value : '13')
      setReduceMotion(reduceMotionVal.status === 'fulfilled' ? reduceMotionVal.value === '1' : false)
      setDevServerToastEnabled(
        devToast.status === 'fulfilled' ? devToast.value !== '0' : true
      )
      setDevServerAutoOpenBrowser(
        devAutoOpen.status === 'fulfilled' ? devAutoOpen.value === '1' : false
      )
      setMcpPort(
        mcpPortSetting.status === 'fulfilled' && mcpPortSetting.value ? mcpPortSetting.value : '45678'
      )

      const validModes: TerminalMode[] = ['claude-code', 'codex', 'cursor-agent', 'gemini', 'opencode', 'terminal']
      const safeMode =
        termMode.status === 'fulfilled' &&
        validModes.includes(termMode.value as TerminalMode)
          ? (termMode.value as TerminalMode)
          : 'claude-code'
      setDefaultTerminalMode(safeMode)

      // Load provider flags dynamically
      const loadedFlags: Record<string, string> = {}
      const providerEntries = Object.entries(PROVIDER_DEFAULTS)
      providerEntries.forEach(([mode, def], i) => {
        const result = flagResults[i]
        loadedFlags[mode] = result?.status === 'fulfilled' ? (result.value ?? def.fallback) : def.fallback
      })
      setDefaultProviderFlags(loadedFlags)

      try {
        const diagConfig = await window.api.diagnostics.getConfig()
        if (isStale()) return
        setDiagnosticsConfig(diagConfig)
        setRetentionDaysInput(String(diagConfig.retentionDays))
        setDiagnosticsMessage('')
      } catch (err) {
        if (isStale()) return
        setDiagnosticsMessage(err instanceof Error ? err.message : String(err))
      }

      try {
        const loadedConnections = await window.api.integrations.listConnections('linear')
        if (isStale()) return
        setConnections(loadedConnections)
        setIntegrationsMessage('')
      } catch (err) {
        if (isStale()) return
        setIntegrationsMessage(err instanceof Error ? err.message : String(err))
      }

      // Load panel config
      try {
        const panelConfigRaw = await window.api.settings.get('panel_config')
        if (isStale()) return
        if (panelConfigRaw) {
          setPanelConfig(mergePredefinedWebPanels(JSON.parse(panelConfigRaw) as PanelConfig))
        }
      } catch { /* ignore */ }

    } catch (err) {
      if (isStale()) return
      setIntegrationsMessage(err instanceof Error ? err.message : String(err))
    }
  }

  const handleConnectLinear = async () => {
    if (!linearApiKey.trim()) return
    try {
      const connection = await window.api.integrations.connectLinear({
        apiKey: linearApiKey.trim(),
        accountLabel: linearAccountLabel.trim() || undefined
      })
      await loadData()
      setLinearApiKey('')
      setIntegrationsMessage(`Connected to ${connection.workspace_name}`)
    } catch (err) {
      setIntegrationsMessage(err instanceof Error ? err.message : String(err))
    }
  }

  const handleDisconnectLinear = async (connectionId: string) => {
    await window.api.integrations.disconnect(connectionId)
    await loadData()
  }

  const handleSyncAll = async () => {
    setSyncingIntegrations(true)
    setIntegrationsMessage('')
    try {
      const result = await window.api.integrations.syncNow({})
      const errSuffix = result.errors.length > 0 ? `, ${result.errors.length} errors` : ''
      setIntegrationsMessage(`Sync complete: ${result.scanned} links, ${result.pulled} pulled, ${result.pushed} pushed${errSuffix}`)
    } finally {
      setSyncingIntegrations(false)
    }
  }

  const updateDiagnosticsConfig = async (partial: Partial<DiagnosticsConfig>) => {
    const next = await window.api.diagnostics.setConfig(partial)
    setDiagnosticsConfig(next)
    setRetentionDaysInput(String(next.retentionDays))
    return next
  }

  const handleExportDiagnostics = async () => {
    setExportingDiagnostics(true)
    setDiagnosticsMessage('')
    try {
      const now = Date.now()
      const fromByRange: Record<typeof exportRange, number> = {
        '15m': now - 15 * 60 * 1000,
        '1h': now - 60 * 60 * 1000,
        '24h': now - 24 * 60 * 60 * 1000,
        '7d': now - 7 * 24 * 60 * 60 * 1000
      }
      const result = await window.api.diagnostics.export({
        fromTsMs: fromByRange[exportRange],
        toTsMs: now
      })
      if (result.success) {
        setDiagnosticsMessage(`Exported ${result.eventCount ?? 0} events`)
      } else if (result.canceled) {
        setDiagnosticsMessage('Export canceled')
      } else {
        setDiagnosticsMessage(result.error ?? 'Export failed')
      }
    } finally {
      setExportingDiagnostics(false)
    }
  }

  const handleCreateTag = async () => {
    if (!newTagName.trim()) return
    const tag = await window.api.tags.createTag({
      name: newTagName.trim(),
      color: newTagColor
    })
    setTags([...tags, tag])
    setNewTagName('')
    setNewTagColor('#6b7280')
  }

  const handleUpdateTag = async () => {
    if (!editingTag || !editingTag.name.trim()) return
    const updated = await window.api.tags.updateTag({
      id: editingTag.id,
      name: editingTag.name.trim(),
      color: editingTag.color
    })
    setTags(tags.map((t) => (t.id === updated.id ? updated : t)))
    setEditingTag(null)
  }

  const handleDeleteTag = async (id: string) => {
    await window.api.tags.deleteTag(id)
    setTags(tags.filter((t) => t.id !== id))
  }

  // Panel config helpers
  const savePanelConfig = async (next: PanelConfig) => {
    setPanelConfig(next)
    await window.api.settings.set('panel_config', JSON.stringify(next))
    window.dispatchEvent(new CustomEvent('panel-config-changed'))
  }

  const toggleBuiltinPanel = (id: string, enabled: boolean) => {
    savePanelConfig({
      ...panelConfig,
      builtinEnabled: { ...panelConfig.builtinEnabled, [id]: enabled }
    })
  }

  const toggleWebPanel = (id: string, enabled: boolean) => {
    savePanelConfig({
      ...panelConfig,
      builtinEnabled: { ...panelConfig.builtinEnabled, [id]: enabled }
    })
  }

  const RESERVED_SHORTCUTS = new Set(['t', 'b', 'e', 'g', 's'])

  const validateShortcut = (letter: string, excludeId?: string): string | null => {
    if (!letter) return null
    const l = letter.toLowerCase()
    if (l.length !== 1 || !/[a-z]/.test(l)) return 'Must be a single letter'
    if (RESERVED_SHORTCUTS.has(l)) return `⌘${l.toUpperCase()} is reserved for a built-in panel`
    const existing = panelConfig.webPanels.find(wp => wp.shortcut === l && wp.id !== excludeId)
    if (existing) return `⌘${l.toUpperCase()} is already used by ${existing.name}`
    return null
  }

  const handleAddCustomPanel = async () => {
    if (!newPanelName.trim() || !newPanelUrl.trim()) return
    const shortcutErr = validateShortcut(newPanelShortcut)
    if (shortcutErr) { setPanelShortcutError(shortcutErr); return }

    let url = newPanelUrl.trim()
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = `https://${url}`
    }
    const handoffProtocol = newPanelBlockDesktopHandoff
      ? normalizeDesktopProtocol(newPanelHandoffProtocol) ?? inferProtocolFromUrl(url)
      : null
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

    await savePanelConfig({
      ...panelConfig,
      webPanels: [...panelConfig.webPanels, newPanel]
    })
    setNewPanelName('')
    setNewPanelUrl('')
    setNewPanelShortcut('')
    setNewPanelBlockDesktopHandoff(false)
    setNewPanelHandoffProtocol('')
    setNewPanelProtocolError('')
    setPanelShortcutError('')
  }

  const handleDeleteWebPanel = async (id: string) => {
    const wp = panelConfig.webPanels.find(p => p.id === id)
    const next: PanelConfig = {
      ...panelConfig,
      webPanels: panelConfig.webPanels.filter(p => p.id !== id)
    }
    // Track deleted predefined panels so mergePredefined doesn't re-add them
    if (wp?.predefined) {
      next.deletedPredefined = [...(panelConfig.deletedPredefined ?? []), id]
    }
    await savePanelConfig(next)
    if (editingPanelId === id) setEditingPanelId(null)
  }

  const startEditingPanel = (wp: WebPanelDefinition) => {
    setEditingPanelId(wp.id)
    setEditPanelName(wp.name)
    setEditPanelUrl(wp.baseUrl)
    setEditPanelShortcut(wp.shortcut || '')
    setEditPanelBlockDesktopHandoff(wp.blockDesktopHandoff ?? false)
    setEditPanelHandoffProtocol(wp.handoffProtocol ?? inferProtocolFromUrl(wp.baseUrl) ?? '')
    setEditPanelProtocolError('')
    setEditShortcutError('')
  }

  const handleSaveEditPanel = async () => {
    if (!editingPanelId || !editPanelName.trim() || !editPanelUrl.trim()) return
    const shortcutErr = editPanelShortcut ? validateShortcut(editPanelShortcut, editingPanelId) : null
    if (shortcutErr) { setEditShortcutError(shortcutErr); return }

    let url = editPanelUrl.trim()
    if (!url.startsWith('http://') && !url.startsWith('https://')) url = `https://${url}`
    const handoffProtocol = editPanelBlockDesktopHandoff
      ? normalizeDesktopProtocol(editPanelHandoffProtocol) ?? inferProtocolFromUrl(url)
      : null
    if (editPanelBlockDesktopHandoff && !handoffProtocol) {
      setEditPanelProtocolError('Enter a valid protocol (for example: figma)')
      return
    }
    setEditPanelProtocolError('')

    await savePanelConfig({
      ...panelConfig,
      webPanels: panelConfig.webPanels.map(wp =>
        wp.id === editingPanelId
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
    setEditingPanelId(null)
  }

  const BUILTIN_PANEL_LABELS: Record<string, string> = {
    terminal: 'Terminal',
    browser: 'Browser',
    editor: 'Editor',
    diff: 'Diff',
    settings: 'Settings'
  }

  const navItems: Array<{ key: string; label: string }> = [
    { key: 'general', label: 'General' },
    { key: 'appearance', label: 'Appearance' },
    { key: 'panels', label: 'Panels' },
    { key: 'integrations', label: 'Integrations' },
    { key: 'diagnostics', label: 'Diagnostics' },
    // { key: 'ai-config', label: 'Context Manager' },
    { key: 'tags', label: 'Tags' },
    { key: 'telemetry', label: 'Telemetry' },
    { key: 'data', label: 'Import & Export' },
    { key: 'labs', label: 'Labs' },
    { key: 'about', label: 'About' }
  ]

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label="Settings">
      <div className="fixed inset-0 bg-white/80 dark:bg-black/60 backdrop-blur-sm" onMouseDown={() => onOpenChange(false)} />
      <div className="fixed top-[50%] left-[50%] z-50 grid h-[88vh] !w-[94vw] !max-w-[94vw] translate-x-[-50%] translate-y-[-50%] overflow-hidden rounded-lg border bg-background p-0 shadow-lg outline-none sm:!w-[94vw] sm:!max-w-[94vw] xl:!max-w-[1320px]" onMouseDown={(e) => e.stopPropagation()}>
        <div className="border-b px-6 py-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-lg leading-none font-semibold">Settings</h2>
            <button
              type="button"
              className="ring-offset-background focus:ring-ring hover:bg-accent rounded-xs p-1 opacity-70 transition-opacity hover:opacity-100 focus:ring-2 focus:ring-offset-2 focus:outline-hidden"
              onClick={() => onOpenChange(false)}
              aria-label="Close"
            >
              <XIcon className="size-4" />
            </button>
          </div>
        </div>

        <SettingsLayout
          items={navItems}
          activeKey={activeTab}
          onSelect={(key) => {
            const tab = key as typeof activeTab
            setActiveTab(tab)
            onTabChange?.(tab)
          }}
        >
          <div className="mx-auto w-full max-w-4xl space-y-8">
            {activeTab === 'appearance' && (
              <>
                <div className="space-y-3">
                  <Label className="text-base font-semibold">Colors</Label>
                  <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
                    <span className="text-sm">Project color tints</span>
                    <Switch
                      checked={projectColorTints}
                      onCheckedChange={(checked) => {
                        setProjectColorTints(checked)
                        window.api.settings.set('project_color_tints_enabled', checked ? '1' : '0')
                      }}
                    />
                  </div>
                </div>

                <div className="space-y-3">
                  <Label className="text-base font-semibold">Fonts</Label>
                  {([
                    { label: 'Terminal font size', value: terminalFontSize, set: setTerminalFontSize, key: 'terminal_font_size' },
                    { label: 'Editor font size', value: editorFontSize, set: setEditorFontSize, key: 'editor_font_size' },
                  ] as const).map(({ label, value, set, key }) => (
                    <div key={key} className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
                      <span className="text-sm">{label}</span>
                      <Select value={value} onValueChange={(v) => { set(v); window.api.settings.set(key, v) }}>
                        <SelectTrigger className="w-24">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {[10, 11, 12, 13, 14, 15, 16, 18, 20].map((s) => (
                            <SelectItem key={s} value={String(s)}>{s}px</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  ))}
                </div>

                <div className="space-y-3">
                  <Label className="text-base font-semibold">Motion</Label>
                  <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
                    <span className="text-sm">Reduce motion</span>
                    <Switch
                      checked={reduceMotion}
                      onCheckedChange={(checked) => {
                        setReduceMotion(checked)
                        window.api.settings.set('reduce_motion', checked ? '1' : '0')
                      }}
                    />
                  </div>
                </div>
              </>
            )}

            {activeTab === 'general' && (
              <>
                <div className="space-y-3">
                  <Label className="text-base font-semibold">Git</Label>
                  <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="text-sm cursor-default">Worktree base path</span>
                      </TooltipTrigger>
                      <TooltipContent side="right" className="max-w-64">
                        Where git worktrees are created when starting a task on a new branch. Use {'{project}'} as a placeholder for the project directory.
                      </TooltipContent>
                    </Tooltip>
                    <Input
                      className="w-full max-w-lg"
                      placeholder="{project}/.."
                      value={worktreeBasePath}
                      onChange={(e) => setWorktreeBasePath(e.target.value)}
                      onBlur={() => {
                        window.api.settings.set('worktree_base_path', worktreeBasePath.trim())
                      }}
                    />
                  </div>
                  <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
                    <span className="text-sm">Auto-create worktree</span>
                    <label className="inline-flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={autoCreateWorktreeOnTaskCreate}
                        onChange={(e) => {
                          const enabled = e.target.checked
                          setAutoCreateWorktreeOnTaskCreate(enabled)
                          window.api.settings.set(
                            'auto_create_worktree_on_task_create',
                            enabled ? '1' : '0'
                          )
                        }}
                      />
                      <span>Create worktree for every new task</span>
                    </label>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Use {'{project}'} as a token. Leave empty to use {'{project}/..'}.
                    Project settings can override auto-create behavior.
                  </p>
                </div>

                <div className="space-y-3">
                  <Label className="text-base font-semibold">MCP Server</Label>
                  <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
                    <span className="text-sm">Port</span>
                    <Input
                      className="w-full max-w-[120px]"
                      type="number"
                      placeholder="45678"
                      value={mcpPort}
                      onChange={(e) => setMcpPort(e.target.value)}
                      onBlur={() => {
                        const port = parseInt(mcpPort, 10)
                        if (port >= 1024 && port <= 65535) {
                          window.api.settings.set('mcp_server_port', String(port))
                        }
                      }}
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Restart required after changing. Default: 45678
                  </p>
                </div>

              </>
            )}

            {activeTab === 'panels' && (
              <>
                {/* Native panels */}
                <div className="space-y-3">
                  <div>
                    <Label className="text-base font-semibold">Native</Label>
                    <p className="text-xs text-muted-foreground mt-1">Built-in panels. Disabled panels won't appear in any task.</p>
                  </div>

                  <div className="space-y-2">
                    {/* Terminal */}
                    <div className="rounded-lg border">
                      <div className="flex items-center gap-3 h-11 px-4">
                        <SquareTerminal className="size-4 text-muted-foreground shrink-0" />
                        <span className="text-sm font-medium flex-1">Terminal</span>
                        <Button variant="ghost" size="icon-sm" onClick={() => setConfiguringNativeId(configuringNativeId === 'terminal' ? null : 'terminal')}>
                          <Settings2 className="size-3.5" />
                        </Button>
                        <kbd className="text-[10px] font-mono bg-muted px-1.5 py-0.5 rounded border shrink-0">⌘T</kbd>
                        <Switch
                          checked={panelConfig.builtinEnabled.terminal !== false}
                          onCheckedChange={(checked) => toggleBuiltinPanel('terminal', checked)}
                        />
                      </div>
                      {configuringNativeId === 'terminal' && (
                        <div className="border-t px-4 py-3 space-y-3">
                          <div className="grid grid-cols-[140px_minmax(0,1fr)] items-center gap-3">
                            <span className="text-xs text-muted-foreground">Default mode</span>
                            <Select
                              value={defaultTerminalMode}
                              onValueChange={(v) => {
                                const mode = v as TerminalMode
                                setDefaultTerminalMode(mode)
                                window.api.settings.set('default_terminal_mode', mode)
                              }}
                            >
                              <SelectTrigger className="h-8 text-xs">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="claude-code">Claude Code</SelectItem>
                                <SelectItem value="codex">Codex</SelectItem>
                                <SelectItem value="cursor-agent">Cursor Agent</SelectItem>
                                <SelectItem value="gemini">Gemini</SelectItem>
                                <SelectItem value="opencode">OpenCode</SelectItem>
                                <SelectItem value="terminal">Terminal</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                          {Object.entries(PROVIDER_DEFAULTS).map(([mode, def]) => (
                          <div key={mode} className="grid grid-cols-[140px_minmax(0,1fr)] items-center gap-3">
                            <span className="text-xs text-muted-foreground">{def.label} flags</span>
                            <Input
                              className="h-8 text-xs"
                              value={defaultProviderFlags[mode] ?? def.fallback}
                              onChange={(e) => setDefaultProviderFlags(prev => ({ ...prev, [mode]: e.target.value }))}
                              onBlur={() => window.api.settings.set(def.settingsKey, (defaultProviderFlags[mode] ?? '').trim())}
                            />
                          </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Browser */}
                    <div className="rounded-lg border">
                      <div className="flex items-center gap-3 h-11 px-4">
                        <Globe className="size-4 text-muted-foreground shrink-0" />
                        <span className="text-sm font-medium flex-1">Browser</span>
                        <Button variant="ghost" size="icon-sm" onClick={() => setConfiguringNativeId(configuringNativeId === 'browser' ? null : 'browser')}>
                          <Settings2 className="size-3.5" />
                        </Button>
                        <kbd className="text-[10px] font-mono bg-muted px-1.5 py-0.5 rounded border shrink-0">⌘B</kbd>
                        <Switch
                          checked={panelConfig.builtinEnabled.browser !== false}
                          onCheckedChange={(checked) => toggleBuiltinPanel('browser', checked)}
                        />
                      </div>
                      {configuringNativeId === 'browser' && (
                        <div className="border-t px-4 py-3 space-y-2.5">
                          <label className="flex items-center gap-2 text-xs cursor-pointer">
                            <input
                              type="checkbox"
                              checked={devServerToastEnabled}
                              onChange={(e) => {
                                const enabled = e.target.checked
                                setDevServerToastEnabled(enabled)
                                window.api.settings.set('dev_server_toast_enabled', enabled ? '1' : '0')
                              }}
                            />
                            <span className="text-muted-foreground">Show toast when dev server detected</span>
                          </label>
                          <label className="flex items-center gap-2 text-xs cursor-pointer">
                            <input
                              type="checkbox"
                              checked={devServerAutoOpenBrowser}
                              onChange={(e) => {
                                const enabled = e.target.checked
                                setDevServerAutoOpenBrowser(enabled)
                                window.api.settings.set('dev_server_auto_open_browser', enabled ? '1' : '0')
                              }}
                            />
                            <span className="text-muted-foreground">Auto-open when dev server detected</span>
                          </label>
                        </div>
                      )}
                    </div>

                    {/* Editor, Diff, Settings (no config) */}
                    {([
                      { id: 'editor', icon: FileCode, shortcut: 'E' },
                      { id: 'diff', icon: GitCompare, shortcut: 'G' },
                      { id: 'settings', icon: SlidersHorizontal, shortcut: 'S' }
                    ] as const).map(({ id, icon: Icon, shortcut }) => (
                      <div key={id} className="flex items-center gap-3 h-11 rounded-lg border px-4">
                        <Icon className="size-4 text-muted-foreground shrink-0" />
                        <span className="text-sm font-medium flex-1">{BUILTIN_PANEL_LABELS[id]}</span>
                        <kbd className="text-[10px] font-mono bg-muted px-1.5 py-0.5 rounded border shrink-0">⌘{shortcut}</kbd>
                        <Switch
                          checked={panelConfig.builtinEnabled[id] !== false}
                          onCheckedChange={(checked) => toggleBuiltinPanel(id, checked)}
                        />
                      </div>
                    ))}
                  </div>
                </div>

                {/* External panels */}
                <div className="space-y-3">
                  <div>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Label className="text-base font-semibold cursor-default">External</Label>
                      </TooltipTrigger>
                      <TooltipContent side="right" className="max-w-64">
                        Custom web panels embedded inside each task. Toggle them via the panel bar. Assign a keyboard shortcut for quick access.
                      </TooltipContent>
                    </Tooltip>
                    <p className="text-xs text-muted-foreground mt-1">Web views embedded as panels inside tasks.</p>
                  </div>

                  <div className="space-y-2">
                    {panelConfig.webPanels.map(wp => (
                      <div key={wp.id} className="rounded-lg border">
                        {editingPanelId === wp.id ? (
                          <div className="px-4 py-3 space-y-3">
                            <div className="grid grid-cols-[1fr_1fr_80px] gap-2">
                              <Input
                                placeholder="Name"
                                value={editPanelName}
                                onChange={(e) => setEditPanelName(e.target.value)}
                              />
                              <Input
                                placeholder="URL"
                                value={editPanelUrl}
                                onChange={(e) => setEditPanelUrl(e.target.value)}
                              />
                              <Input
                                placeholder="Key"
                                maxLength={1}
                                value={editPanelShortcut}
                                onChange={(e) => {
                                  const v = e.target.value.slice(-1)
                                  setEditPanelShortcut(v)
                                  setEditShortcutError(validateShortcut(v, editingPanelId) || '')
                                }}
                              />
                            </div>
                            {editShortcutError && (
                              <p className="text-xs text-destructive">{editShortcutError}</p>
                            )}
                            <label className="flex items-center gap-2 text-xs cursor-pointer">
                              <input
                                type="checkbox"
                                checked={editPanelBlockDesktopHandoff}
                                onChange={(e) => {
                                  const checked = e.target.checked
                                  setEditPanelBlockDesktopHandoff(checked)
                                  if (checked && !editPanelHandoffProtocol.trim()) {
                                    setEditPanelHandoffProtocol(inferProtocolFromUrl(editPanelUrl) ?? '')
                                  }
                                  if (!checked) setEditPanelProtocolError('')
                                }}
                              />
                              <span className="text-muted-foreground">Block desktop app handoff links</span>
                            </label>
                            {editPanelBlockDesktopHandoff && (
                              <div className="space-y-1">
                                <Input
                                  placeholder="Protocol (e.g. figma)"
                                  value={editPanelHandoffProtocol}
                                  onChange={(e) => {
                                    setEditPanelHandoffProtocol(e.target.value)
                                    setEditPanelProtocolError('')
                                  }}
                                />
                                <p className="text-[11px] text-muted-foreground">
                                  Custom protocol only, no :// (example: figma)
                                </p>
                              </div>
                            )}
                            {editPanelProtocolError && (
                              <p className="text-xs text-destructive">{editPanelProtocolError}</p>
                            )}
                            <div className="flex items-center gap-2">
                              <Button size="sm" onClick={handleSaveEditPanel} disabled={!editPanelName.trim() || !editPanelUrl.trim()}>Save</Button>
                              <Button size="sm" variant="ghost" onClick={() => setEditingPanelId(null)}>Cancel</Button>
                              <div className="flex-1" />
                              <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => handleDeleteWebPanel(wp.id)}>
                                <Trash2 className="size-3.5 mr-1" />
                                Delete
                              </Button>
                            </div>
                          </div>
                        ) : (
                          <div className="flex items-center gap-3 h-11 px-4">
                            <Globe className="size-4 text-muted-foreground shrink-0" />
                            <span className="text-sm font-medium">{wp.name}</span>
                            <span className="text-xs text-muted-foreground truncate flex-1 min-w-0">{wp.baseUrl}</span>
                            {wp.blockDesktopHandoff && (
                              <span className="text-[10px] font-medium text-amber-700 dark:text-amber-300 bg-amber-500/10 px-1.5 py-0.5 rounded border border-amber-500/20 shrink-0">
                                Handoff: {(wp.handoffProtocol ?? 'custom').toLowerCase()}
                              </span>
                            )}
                            <Button variant="ghost" size="icon-sm" onClick={() => handleDeleteWebPanel(wp.id)}>
                              <Trash2 className="size-3.5" />
                            </Button>
                            <Button variant="ghost" size="icon-sm" onClick={() => startEditingPanel(wp)}>
                              <Pencil className="size-3.5" />
                            </Button>
                            {wp.shortcut && (
                              <kbd className="text-[10px] font-mono bg-muted px-1.5 py-0.5 rounded border shrink-0">⌘{wp.shortcut.toUpperCase()}</kbd>
                            )}
                            <Switch
                              checked={panelConfig.builtinEnabled[wp.id] !== false}
                              onCheckedChange={(checked) => toggleWebPanel(wp.id, checked)}
                            />
                          </div>
                        )}
                      </div>
                    ))}
                    {panelConfig.webPanels.length === 0 && (
                      <p className="text-sm text-muted-foreground">No external panels configured.</p>
                    )}
                  </div>

                  {/* Add custom panel */}
                  <div className="grid grid-cols-[1fr_1fr_80px] gap-2 pt-2">
                    <Input
                      placeholder="Name (e.g. Miro)"
                      value={newPanelName}
                      onChange={(e) => setNewPanelName(e.target.value)}
                    />
                    <Input
                      placeholder="URL (e.g. miro.com)"
                      value={newPanelUrl}
                      onChange={(e) => setNewPanelUrl(e.target.value)}
                    />
                    <Input
                      placeholder="Key"
                      maxLength={1}
                      value={newPanelShortcut}
                      onChange={(e) => {
                        const v = e.target.value.slice(-1)
                        setNewPanelShortcut(v)
                        setPanelShortcutError(validateShortcut(v) || '')
                      }}
                    />
                  </div>
                  {panelShortcutError && (
                    <p className="text-xs text-destructive">{panelShortcutError}</p>
                  )}
                  <label className="flex items-center gap-2 text-xs cursor-pointer">
                    <input
                      type="checkbox"
                      checked={newPanelBlockDesktopHandoff}
                      onChange={(e) => {
                        const checked = e.target.checked
                        setNewPanelBlockDesktopHandoff(checked)
                        if (checked && !newPanelHandoffProtocol.trim()) {
                          setNewPanelHandoffProtocol(inferProtocolFromUrl(newPanelUrl) ?? '')
                        }
                        if (!checked) setNewPanelProtocolError('')
                      }}
                    />
                    <span className="text-muted-foreground">Block desktop app handoff links</span>
                  </label>
                  {newPanelBlockDesktopHandoff && (
                    <div className="space-y-1">
                      <Input
                        placeholder="Protocol (e.g. figma)"
                        value={newPanelHandoffProtocol}
                        onChange={(e) => {
                          setNewPanelHandoffProtocol(e.target.value)
                          setNewPanelProtocolError('')
                        }}
                      />
                      <p className="text-[11px] text-muted-foreground">
                        Custom protocol only, no :// (example: figma)
                      </p>
                    </div>
                  )}
                  {newPanelProtocolError && (
                    <p className="text-xs text-destructive">{newPanelProtocolError}</p>
                  )}
                  <Button size="sm" onClick={handleAddCustomPanel} disabled={!newPanelName.trim() || !newPanelUrl.trim()}>
                    <Plus className="size-3.5 mr-1" />
                    Add Panel
                  </Button>
                </div>

              </>
            )}

            {activeTab === 'integrations' && (
              <div className="space-y-8">
                <Label className="text-base font-semibold">Linear</Label>
                <div className="space-y-3">
                  <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
                    <span className="text-sm">Account label</span>
                    <Input
                      id="linear-account-label"
                      value={linearAccountLabel}
                      onChange={(e) => setLinearAccountLabel(e.target.value)}
                      placeholder="Work email label (optional)"
                    />
                  </div>
                  <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
                    <span className="text-sm">Personal API key</span>
                    <Input
                      id="linear-api-key"
                      type="password"
                      value={linearApiKey}
                      onChange={(e) => setLinearApiKey(e.target.value)}
                      placeholder="lin_api_***"
                    />
                  </div>
                  <Button onClick={handleConnectLinear} disabled={!linearApiKey.trim()}>
                    Connect Linear
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    API key is stored using OS-backed secure storage.
                  </p>
                </div>

                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <Label className="text-sm font-medium">Connections</Label>
                    <Button variant="outline" size="sm" onClick={handleSyncAll} disabled={syncingIntegrations}>
                      {syncingIntegrations ? 'Syncing…' : 'Sync Now'}
                    </Button>
                  </div>
                  {connections.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No Linear connection yet.</p>
                  ) : (
                    <div className="space-y-2">
                      {connections.map((connection) => (
                        <div key={connection.id} className="flex items-center gap-2 rounded bg-muted/40 p-2 text-sm">
                          <div className="min-w-0 flex-1">
                            <p className="truncate font-medium">{connection.workspace_name}</p>
                            <p className="truncate text-xs text-muted-foreground">{connection.account_label}</p>
                          </div>
                          <Button variant="ghost" size="sm" onClick={() => handleDisconnectLinear(connection.id)}>
                            Disconnect
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                  {integrationsMessage ? (
                    <p className="text-xs text-muted-foreground">{integrationsMessage}</p>
                  ) : null}
                </div>
              </div>
            )}

            {activeTab === 'diagnostics' && (
              <>
                <div className="space-y-3">
                  <Label className="text-base font-semibold">Logging</Label>
                  <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
                    <span className="text-sm">Diagnostics enabled</span>
                    <input
                      type="checkbox"
                      checked={diagnosticsConfig?.enabled ?? true}
                      onChange={(e) => {
                        updateDiagnosticsConfig({ enabled: e.target.checked })
                      }}
                    />
                  </div>
                  <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
                    <span className="text-sm">Verbose logging</span>
                    <input
                      type="checkbox"
                      checked={diagnosticsConfig?.verbose ?? false}
                      onChange={(e) => {
                        updateDiagnosticsConfig({ verbose: e.target.checked })
                      }}
                    />
                  </div>
                  <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
                    <span className="text-sm">Include PTY output content</span>
                    <input
                      type="checkbox"
                      checked={diagnosticsConfig?.includePtyOutput ?? false}
                      onChange={(e) => {
                        updateDiagnosticsConfig({ includePtyOutput: e.target.checked })
                      }}
                    />
                  </div>
                  <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
                    <span className="text-sm">Retention days</span>
                    <Input
                      className="w-full max-w-24"
                      inputMode="numeric"
                      value={retentionDaysInput}
                      onChange={(e) => setRetentionDaysInput(e.target.value)}
                      onBlur={() => {
                        const parsed = Number.parseInt(retentionDaysInput, 10)
                        if (Number.isFinite(parsed) && parsed > 0) {
                          updateDiagnosticsConfig({ retentionDays: parsed })
                        } else if (diagnosticsConfig) {
                          setRetentionDaysInput(String(diagnosticsConfig.retentionDays))
                        }
                      }}
                    />
                  </div>
                </div>

                <div className="space-y-3">
                  <Label className="text-base font-semibold">Export</Label>
                  <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
                    <span className="text-sm">Time range</span>
                    <Select value={exportRange} onValueChange={(v) => setExportRange(v as typeof exportRange)}>
                      <SelectTrigger className="w-full max-w-sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="15m">Last 15 minutes</SelectItem>
                        <SelectItem value="1h">Last 1 hour</SelectItem>
                        <SelectItem value="24h">Last 24 hours</SelectItem>
                        <SelectItem value="7d">Last 7 days</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <Button onClick={handleExportDiagnostics} disabled={exportingDiagnostics}>
                    {exportingDiagnostics ? 'Exporting…' : 'Export Diagnostics'}
                  </Button>
                  {diagnosticsMessage ? (
                    <p className="text-xs text-muted-foreground">{diagnosticsMessage}</p>
                  ) : null}
                </div>
              </>
            )}

            {activeTab === 'ai-config' && (
              <ContextManagerSettings scope="global" projectId={null} />
            )}

            {activeTab === 'tags' && (
              <div className="space-y-6">
                <Label className="text-base font-semibold">Tags</Label>
                <div className="space-y-2">
                  {tags.map((tag) => (
                    <div key={tag.id} className="flex items-center gap-2">
                      {editingTag?.id === tag.id ? (
                        <>
                          <div
                            className="w-4 h-4 rounded-full flex-shrink-0"
                            style={{ backgroundColor: editingTag.color }}
                          />
                          <Input
                            value={editingTag.name}
                            onChange={(e) => setEditingTag({ ...editingTag, name: e.target.value })}
                            className="flex-1 h-8"
                          />
                          <Button size="sm" variant="ghost" onClick={handleUpdateTag}>
                            Save
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setEditingTag(null)}>
                            Cancel
                          </Button>
                        </>
                      ) : (
                        <>
                          <div
                            className="w-4 h-4 rounded-full flex-shrink-0"
                            style={{ backgroundColor: tag.color }}
                          />
                          <span className="flex-1">{tag.name}</span>
                          <Button size="sm" variant="ghost" onClick={() => setEditingTag({ ...tag })}>
                            Edit
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-destructive"
                            onClick={() => handleDeleteTag(tag.id)}
                          >
                            Delete
                          </Button>
                        </>
                      )}
                    </div>
                  ))}
                </div>

                <div className="flex items-end gap-2">
                  <div className="flex-1 space-y-1">
                    <Label htmlFor="new-tag" className="text-xs">New tag</Label>
                    <Input
                      id="new-tag"
                      value={newTagName}
                      onChange={(e) => setNewTagName(e.target.value)}
                      placeholder="Tag name"
                      onKeyDown={(e) => e.key === 'Enter' && handleCreateTag()}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Color</Label>
                    <Input
                      type="color"
                      value={newTagColor}
                      onChange={(e) => setNewTagColor(e.target.value)}
                      className="w-12 h-9 p-1 cursor-pointer"
                    />
                  </div>
                  <Button onClick={handleCreateTag} disabled={!newTagName.trim()}>
                    Add
                  </Button>
                </div>
              </div>
            )}

            {activeTab === 'telemetry' && (
              <TelemetrySettingsTab />
            )}

            {activeTab === 'data' && (
              <>
                <div className="space-y-3">
                  <Label className="text-base font-semibold">Export</Label>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      onClick={async () => {
                        const result = await window.api.exportImport.exportAll()
                        if (result.canceled) return
                        if (result.success) toast.success(`Exported to ${result.path}`)
                        else toast.error(`Export failed: ${result.error}`)
                      }}
                    >
                      Export All Projects
                    </Button>
                  </div>
                  <div className="flex items-center gap-2">
                    <Select value={exportProjectId} onValueChange={setExportProjectId}>
                      <SelectTrigger className="w-full max-w-sm">
                        <SelectValue placeholder="Select project to export" />
                      </SelectTrigger>
                      <SelectContent>
                        {projects.map((p) => (
                          <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      variant="outline"
                      disabled={!exportProjectId}
                      onClick={async () => {
                        const result = await window.api.exportImport.exportProject(exportProjectId)
                        if (result.canceled) return
                        if (result.success) toast.success(`Exported to ${result.path}`)
                        else toast.error(`Export failed: ${result.error}`)
                      }}
                    >
                      Export Project
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Exports to a .slay file containing projects, tasks, tags, and configuration.
                  </p>
                </div>

                <div className="space-y-3">
                  <Label className="text-base font-semibold">Import</Label>
                  <Button
                    variant="outline"
                    onClick={async () => {
                      const result = await window.api.exportImport.import()
                      if (result.canceled) return
                      if (result.success) {
                        toast.success(`Imported ${result.projectCount} project(s), ${result.taskCount} task(s)`)
                        if (result.importedProjects?.length) {
                          setImportedProjects(result.importedProjects.map((p) => ({ ...p, path: '' })))
                        }
                      } else {
                        toast.error(`Import failed: ${result.error}`)
                      }
                    }}
                  >
                    Import .slay
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    Imports projects and tasks from a .slay file. Existing data is preserved.
                  </p>
                </div>

                {importedProjects.length > 0 && (
                  <div className="space-y-3">
                    <Label className="text-base font-semibold">Set Project Paths</Label>
                    <p className="text-xs text-muted-foreground">
                      Set the repository path for each imported project.
                    </p>
                    {importedProjects.map((p, i) => (
                      <div key={p.id} className="space-y-1">
                        <span className="text-sm font-medium">{p.name}</span>
                        <div className="flex items-center gap-2">
                          <Input
                            className="flex-1 max-w-lg"
                            placeholder="/path/to/repo"
                            value={p.path}
                            onChange={(e) => {
                              setImportedProjects((prev) =>
                                prev.map((proj, j) => (j === i ? { ...proj, path: e.target.value } : proj))
                              )
                            }}
                          />
                          <Button
                            type="button"
                            variant="outline"
                            size="icon"
                            onClick={async () => {
                              const result = await window.api.dialog.showOpenDialog({
                                title: 'Select Project Directory',
                                defaultPath: p.path || undefined,
                                properties: ['openDirectory']
                              })
                              if (!result.canceled && result.filePaths[0]) {
                                setImportedProjects((prev) =>
                                  prev.map((proj, j) => (j === i ? { ...proj, path: result.filePaths[0] } : proj))
                                )
                              }
                            }}
                          >
                            <FolderOpen className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    ))}
                    <div className="flex gap-2">
                      <Button
                        onClick={async () => {
                          for (const p of importedProjects) {
                            if (p.path.trim()) {
                              await window.api.db.updateProject({ id: p.id, path: p.path.trim() })
                            }
                          }
                          const saved = importedProjects.filter((p) => p.path.trim()).length
                          if (saved > 0) toast.success(`Set paths for ${saved} project(s)`)
                          setImportedProjects([])
                        }}
                      >
                        Save Paths
                      </Button>
                      <Button variant="ghost" onClick={() => setImportedProjects([])}>
                        Skip
                      </Button>
                    </div>
                  </div>
                )}
              </>
            )}

            {activeTab === 'labs' && (
              <>
                <div className="space-y-3">
                  <Label className="text-base font-semibold">Experimental Features</Label>
                  <p className="text-sm text-muted-foreground">These features are in development and may change.</p>
                </div>
                <div className="rounded-lg border p-4 space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <Label htmlFor="leaderboard-toggle">Leaderboard</Label>
                      <p className="text-xs text-muted-foreground">Show leaderboard tab with token usage stats</p>
                    </div>
                    <Switch
                      id="leaderboard-toggle"
                      checked={leaderboardEnabled}
                      onCheckedChange={async (checked) => {
                        setLeaderboardEnabled(checked)
                        await window.api.settings.set('leaderboard_enabled', checked ? '1' : '0')
                      }}
                    />
                  </div>
                </div>
              </>
            )}

            {activeTab === 'about' && (
              <>
                <div className="space-y-3">
                  <Label className="text-base font-semibold">Database</Label>
                  <div className="text-sm text-muted-foreground">
                    <p>Location: {dbPath}</p>
                    <p className="text-xs mt-1">Database path can be changed via command line. Restart required.</p>
                  </div>
                </div>

                <div className="space-y-3">
                  <Label className="text-base font-semibold">CLI Tool</Label>
                  <div className="flex items-center gap-3">
                    <span className="text-sm text-muted-foreground flex items-center gap-1.5">
                      <span className={cliInstalled ? 'text-green-500' : 'text-muted-foreground'}>●</span>
                      {cliInstalled ? 'Installed at /usr/local/bin/slay' : 'Not installed'}
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={cliInstalling}
                      onClick={async () => {
                        setCliInstalling(true)
                        setCliMessage('')
                        try {
                          const result = await window.api.app.installCli()
                          if (result.ok) {
                            setCliInstalled(true)
                            setCliMessage('Installed successfully.')
                          } else if (result.permissionDenied) {
                            setCliMessage(`Permission denied. Run in Terminal:\n${result.error}`)
                          } else {
                            setCliMessage(result.error ?? 'Install failed.')
                          }
                        } catch (err) {
                          setCliMessage(err instanceof Error ? err.message : 'Install failed.')
                        } finally {
                          setCliInstalling(false)
                        }
                      }}
                    >
                      {cliInstalling ? 'Installing…' : cliInstalled ? 'Reinstall' : 'Install'}
                    </Button>
                  </div>
                  {cliMessage && (
                    <pre className="text-xs text-muted-foreground whitespace-pre-wrap">{cliMessage}</pre>
                  )}
                </div>
              </>
            )}


          </div>
        </SettingsLayout>
      </div>
    </div>
  )
}
