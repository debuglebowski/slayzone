import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { ExternalLink, Pencil, Star, Search, Plus, Trash2 } from 'lucide-react'
import { Button, cn, IconButton, Input, Label, Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@slayzone/ui'
import { CURATED_MCP_SERVERS, type CuratedMcpServer } from '../shared/mcp-registry'
import type { CliProvider, McpConfigFileResult, McpTarget, McpServerConfig } from '../shared'
import { getConfigurableMcpTargets } from '../shared/provider-registry'

// ---------------------------------------------------------------------------
// Shared types & helpers
// ---------------------------------------------------------------------------

interface CustomMcpServer {
  id: string
  name: string
  description?: string
  config: McpServerConfig
}

interface EditTarget {
  originalKey: string
  server: CustomMcpServer
}

async function loadCustomServers(): Promise<CustomMcpServer[]> {
  const raw = await window.api.settings.get('mcp_custom_servers')
  return raw ? (JSON.parse(raw) as CustomMcpServer[]) : []
}

async function saveCustomServers(servers: CustomMcpServer[]): Promise<void> {
  await window.api.settings.set('mcp_custom_servers', JSON.stringify(servers))
}

function matchesSearch(query: string, ...fields: (string | undefined)[]) {
  if (!query) return true
  const q = query.toLowerCase()
  return fields.some((f) => f?.toLowerCase().includes(q))
}

function ServerCard({ server, actions, footer, className }: {
  server: CuratedMcpServer
  actions?: React.ReactNode
  footer?: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn("flex flex-col justify-between rounded-lg border bg-surface-3 p-4 transition-colors", className)}>
      <div>
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-sm font-medium leading-tight">{server.name}</span>
          <div className="flex shrink-0 items-center gap-1">
            {actions}
            <a href={server.url} target="_blank" rel="noopener noreferrer" className="rounded p-0.5 transition-colors hover:bg-muted">
              <ExternalLink className="size-3 text-muted-foreground" />
            </a>
          </div>
        </div>
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">{server.description}</p>
      </div>
      {footer && <div className="mt-3 border-t pt-2">{footer}</div>}
    </div>
  )
}

function CustomServerCard({ server, actions, footer, className }: {
  server: CustomMcpServer
  actions?: React.ReactNode
  footer?: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn("flex flex-col justify-between rounded-lg border bg-surface-3 p-4 transition-colors", className)}>
      <div>
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-sm font-medium leading-tight">{server.name}</span>
          <div className="flex shrink-0 items-center gap-1">{actions}</div>
        </div>
        {server.description && <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{server.description}</p>}
        <p className={cn("text-xs leading-relaxed text-muted-foreground font-mono", server.description ? 'mt-1' : 'mt-2')}>
          {server.config.command} {server.config.args.join(' ')}
        </p>
      </div>
      {footer && <div className="mt-3 border-t pt-2">{footer}</div>}
    </div>
  )
}

function SearchInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="relative">
      <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search servers..."
        className="h-8 pl-8 text-xs"
      />
    </div>
  )
}

const PROVIDER_LABELS: Partial<Record<McpTarget, string>> = {
  claude: 'Claude Code',
  cursor: 'Cursor',
  gemini: 'Gemini',
  opencode: 'OpenCode',
  copilot: 'Copilot',
}

const HEADER_ACTIONS_ID = 'context-manager-header-actions'

function useHeaderPortal() {
  const [target, setTarget] = useState<HTMLElement | null>(null)
  useEffect(() => {
    setTarget(document.getElementById(HEADER_ACTIONS_ID))
  }, [])
  return target
}

const ALL_PROVIDERS: McpTarget[] = getConfigurableMcpTargets({ writableOnly: true })



// ---------------------------------------------------------------------------
// Add/Edit MCP Server dialog — shared between computer and project modes
// ---------------------------------------------------------------------------

function McpServerFormFields({ serverKey, setServerKey, description, setDescription, command, setCommand, args, setArgs, envVars, setEnvVars }: {
  serverKey: string; setServerKey: (v: string) => void
  description: string; setDescription: (v: string) => void
  command: string; setCommand: (v: string) => void
  args: string; setArgs: (v: string) => void
  envVars: Array<{ key: string; value: string }>; setEnvVars: (v: Array<{ key: string; value: string }>) => void
}) {
  return (
    <>
      <div className="space-y-1.5">
        <Label className="text-xs">Server key</Label>
        <Input
          value={serverKey}
          onChange={(e) => setServerKey(e.target.value)}
          placeholder="my-server"
          className="h-8 text-xs"
        />
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs">Description</Label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What does this server do?"
          rows={2}
          className="border-input dark:bg-input/30 w-full rounded-md border bg-transparent px-3 py-2 text-xs placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] outline-none resize-y"
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs">Command</Label>
          <Input
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            placeholder="npx"
            className="h-8 text-xs"
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Args</Label>
          <Input
            value={args}
            onChange={(e) => setArgs(e.target.value)}
            placeholder="-y @foo/bar"
            className="h-8 text-xs"
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs">Environment variables</Label>
        {envVars.map((env, i) => (
          <div key={i} className="grid grid-cols-[1fr_1fr_32px] gap-2">
            <Input
              placeholder="KEY"
              value={env.key}
              onChange={(e) => {
                const next = [...envVars]
                next[i] = { ...next[i], key: e.target.value }
                setEnvVars(next)
              }}
              className="h-8 text-xs font-mono"
            />
            <Input
              placeholder="value"
              value={env.value}
              onChange={(e) => {
                const next = [...envVars]
                next[i] = { ...next[i], value: e.target.value }
                setEnvVars(next)
              }}
              className="h-8 text-xs"
            />
            <IconButton
              aria-label="Remove variable"
              variant="ghost"
              size="icon-sm"
              onClick={() => setEnvVars(envVars.filter((_, idx) => idx !== i))}
            >
              <Trash2 className="size-3.5" />
            </IconButton>
          </div>
        ))}
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          onClick={() => setEnvVars([...envVars, { key: '', value: '' }])}
        >
          <Plus className="size-3 mr-1" />
          Add variable
        </Button>
      </div>
    </>
  )
}

function buildConfig(command: string, args: string, envVars: Array<{ key: string; value: string }>): McpServerConfig {
  const config: McpServerConfig = {
    command: command.trim(),
    args: args.trim() ? args.trim().split(/\s+/) : []
  }
  const env = Object.fromEntries(
    envVars.filter((e) => e.key.trim()).map((e) => [e.key.trim(), e.value])
  )
  if (Object.keys(env).length > 0) config.env = env
  return config
}

// ---------------------------------------------------------------------------
// Computer: Add custom server dialog (saves to settings)
// ---------------------------------------------------------------------------

interface AddComputerMcpDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onAdded: () => void
  editTarget?: EditTarget | null
}

function AddComputerMcpDialog({ open, onOpenChange, onAdded, editTarget }: AddComputerMcpDialogProps) {
  const [serverKey, setServerKey] = useState('')
  const [description, setDescription] = useState('')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [envVars, setEnvVars] = useState<Array<{ key: string; value: string }>>([])
  const [saving, setSaving] = useState(false)

  const reset = () => { setServerKey(''); setDescription(''); setCommand(''); setArgs(''); setEnvVars([]) }

  useEffect(() => {
    if (!open) return
    if (editTarget) {
      setServerKey(editTarget.server.id)
      setDescription(editTarget.server.description ?? '')
      setCommand(editTarget.server.config.command)
      setArgs(editTarget.server.config.args?.join(' ') ?? '')
      setEnvVars(Object.entries(editTarget.server.config.env ?? {}).map(([key, value]) => ({ key, value })))
    } else {
      reset()
    }
  }, [open, editTarget])

  const handleSave = async () => {
    if (!serverKey.trim() || !command.trim()) return
    setSaving(true)
    try {
      let existing = await loadCustomServers()
      if (editTarget && editTarget.originalKey !== serverKey.trim()) {
        existing = existing.filter((s) => s.id !== editTarget.originalKey)
      }
      const entry: CustomMcpServer = {
        id: serverKey.trim(),
        name: serverKey.trim(),
        description: description.trim() || undefined,
        config: buildConfig(command, args, envVars)
      }
      await saveCustomServers([...existing.filter((s) => s.id !== entry.id), entry])
      reset()
      onAdded()
      onOpenChange(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editTarget ? 'Edit Custom MCP Server' : 'Add Custom MCP Server'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <McpServerFormFields
            serverKey={serverKey} setServerKey={setServerKey}
            description={description} setDescription={setDescription}
            command={command} setCommand={setCommand}
            args={args} setArgs={setArgs}
            envVars={envVars} setEnvVars={setEnvVars}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={!serverKey.trim() || !command.trim() || saving}>
            {saving ? 'Saving...' : editTarget ? 'Save Changes' : 'Add Server'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Project: Add custom server dialog (writes to provider config files)
// ---------------------------------------------------------------------------

interface AddProjectMcpDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectPath: string
  availableProviders: McpTarget[]
  onAdded: () => void
  editTarget?: EditTarget | null
  editProviders?: McpTarget[]
}

function AddProjectMcpDialog({ open, onOpenChange, projectPath, availableProviders, onAdded, editTarget, editProviders }: AddProjectMcpDialogProps) {
  const [serverKey, setServerKey] = useState('')
  const [description, setDescription] = useState('')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [envVars, setEnvVars] = useState<Array<{ key: string; value: string }>>([])
  const [providers, setProviders] = useState<Partial<Record<McpTarget, boolean>>>({})
  const [saving, setSaving] = useState(false)

  const reset = () => {
    setServerKey(''); setDescription(''); setCommand(''); setArgs(''); setEnvVars([])
    const flags: Partial<Record<McpTarget, boolean>> = {}
    for (const p of availableProviders) flags[p] = true
    setProviders(flags)
  }

  useEffect(() => {
    if (!open) return
    if (editTarget) {
      setServerKey(editTarget.server.id)
      setDescription(editTarget.server.description ?? '')
      setCommand(editTarget.server.config.command)
      setArgs(editTarget.server.config.args?.join(' ') ?? '')
      setEnvVars(Object.entries(editTarget.server.config.env ?? {}).map(([key, value]) => ({ key, value })))
      const flags: Partial<Record<McpTarget, boolean>> = {}
      for (const p of availableProviders) flags[p] = editProviders?.includes(p) ?? false
      setProviders(flags)
    } else {
      reset()
    }
  }, [open, editTarget])

  const handleSave = async () => {
    if (!serverKey.trim() || !command.trim()) return
    setSaving(true)
    try {
      const config = buildConfig(command, args, envVars)
      const keyChanged = editTarget && editTarget.originalKey !== serverKey.trim()

      if (keyChanged && editProviders) {
        for (const provider of editProviders) {
          await window.api.aiConfig.removeMcpServer({
            projectPath,
            provider,
            serverKey: editTarget.originalKey
          })
        }
      }

      for (const [provider, enabled] of Object.entries(providers)) {
        if (!enabled) continue
        await window.api.aiConfig.writeMcpServer({
          projectPath,
          provider: provider as McpTarget,
          serverKey: serverKey.trim(),
          config
        })
      }

      // Persist metadata (description) to computer custom servers list
      let existing = await loadCustomServers()
      if (keyChanged && editTarget) {
        existing = existing.filter((s) => s.id !== editTarget.originalKey)
      }
      const entry: CustomMcpServer = {
        id: serverKey.trim(),
        name: serverKey.trim(),
        description: description.trim() || undefined,
        config
      }
      await saveCustomServers([...existing.filter((s) => s.id !== entry.id), entry])

      reset()
      onAdded()
      onOpenChange(false)
    } finally {
      setSaving(false)
    }
  }

  const canSubmit = serverKey.trim() && command.trim() && Object.values(providers).some(Boolean)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editTarget ? 'Edit Custom MCP Server' : 'Add Custom MCP Server'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <McpServerFormFields
            serverKey={serverKey} setServerKey={setServerKey}
            description={description} setDescription={setDescription}
            command={command} setCommand={setCommand}
            args={args} setArgs={setArgs}
            envVars={envVars} setEnvVars={setEnvVars}
          />
          <div className="space-y-1.5">
            <Label className="text-xs">Write to providers</Label>
            <div className="flex items-center gap-4">
              {availableProviders.map((p) => (
                <label key={p} className="flex items-center gap-1.5 text-xs cursor-pointer">
                  <input
                    type="checkbox"
                    checked={providers[p]}
                    onChange={(e) => setProviders({ ...providers, [p]: e.target.checked })}
                  />
                  {PROVIDER_LABELS[p] ?? p}
                </label>
              ))}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={!canSubmit || saving}>
            {saving ? 'Saving...' : editTarget ? 'Save Changes' : 'Add Server'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Computer mode
// ---------------------------------------------------------------------------

function ComputerMcpPanel() {
  const headerPortal = useHeaderPortal()
  const [favorites, setFavorites] = useState<string[]>([])
  const [customServers, setCustomServers] = useState<CustomMcpServer[]>([])
  const [search, setSearch] = useState('')
  const [addDialogOpen, setAddDialogOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null)

  const loadCustom = useCallback(async () => {
    setCustomServers(await loadCustomServers())
  }, [])

  useEffect(() => {
    void window.api.settings.get('mcp_favorites').then((raw) => {
      if (raw) setFavorites(JSON.parse(raw) as string[])
    })
    void loadCustom()
  }, [loadCustom])

  const toggleFavorite = async (id: string) => {
    const next = favorites.includes(id)
      ? favorites.filter((f) => f !== id)
      : [...favorites, id]
    setFavorites(next)
    await window.api.settings.set('mcp_favorites', JSON.stringify(next))
  }

  const deleteCustomServer = async (id: string) => {
    const next = customServers.filter((s) => s.id !== id)
    setCustomServers(next)
    await saveCustomServers(next)
  }

  const editCustomServer = (server: CustomMcpServer) => {
    setEditTarget({ originalKey: server.id, server })
    setAddDialogOpen(true)
  }

  const filteredCurated = useMemo(() =>
    CURATED_MCP_SERVERS
      .filter((s) => matchesSearch(search, s.name, s.description, s.category))
      .sort((a, b) => {
        const af = favorites.includes(a.id) ? 0 : 1
        const bf = favorites.includes(b.id) ? 0 : 1
        return af - bf || a.name.localeCompare(b.name)
      }),
    [favorites, search]
  )

  const filteredCustom = useMemo(() =>
    customServers
      .filter((s) => matchesSearch(search, s.name, s.id))
      .sort((a, b) => a.name.localeCompare(b.name)),
    [customServers, search]
  )

  const headerActions = (
    <div className="flex items-center gap-2">
      <SearchInput value={search} onChange={setSearch} />
      <Button variant="outline" size="sm" className="h-8 text-xs shrink-0" onClick={() => setAddDialogOpen(true)}>
        <Plus className="size-3 mr-1" />
        Custom
      </Button>
    </div>
  )

  return (
    <div className="space-y-4">
      {headerPortal ? createPortal(headerActions, headerPortal) : headerActions}

      <AddComputerMcpDialog
        open={addDialogOpen}
        onOpenChange={(open) => { setAddDialogOpen(open); if (!open) setEditTarget(null) }}
        onAdded={loadCustom}
        editTarget={editTarget}
      />

      {/* Custom servers */}
      {filteredCustom.length > 0 && (
        <div className="space-y-2">
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Custom</p>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(360px,1fr))] gap-2">
            {filteredCustom.map((s) => (
              <CustomServerCard
                key={s.id}
                server={s}
                actions={
                  <>
                    <button
                      onClick={() => editCustomServer(s)}
                      className="rounded p-0.5 transition-colors hover:bg-muted"
                      title="Edit custom server"
                    >
                      <Pencil className="size-3.5 text-muted-foreground" />
                    </button>
                    <button
                      onClick={() => deleteCustomServer(s.id)}
                      className="rounded p-0.5 transition-colors hover:bg-muted"
                      title="Delete custom server"
                    >
                      <Trash2 className="size-3.5 text-muted-foreground" />
                    </button>
                  </>
                }
              />
            ))}
          </div>
        </div>
      )}

      {/* Curated servers */}
      {filteredCurated.length > 0 && (
        <div className="space-y-2">
          {filteredCustom.length > 0 && (
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Curated</p>
          )}
          <div className="grid grid-cols-[repeat(auto-fill,minmax(360px,1fr))] gap-2">
            {filteredCurated.map((s) => (
              <ServerCard
                key={s.id}
                server={s}
                actions={
                  <button
                    onClick={() => toggleFavorite(s.id)}
                    className="rounded p-0.5 transition-colors hover:bg-muted"
                    title={favorites.includes(s.id) ? 'Remove from favorites' : 'Add to favorites'}
                  >
                    <Star className={favorites.includes(s.id) ? 'size-3.5 fill-amber-400 text-amber-400' : 'size-3.5 text-muted-foreground'} />
                  </button>
                }
              />
            ))}
          </div>
        </div>
      )}

      {search && filteredCurated.length === 0 && filteredCustom.length === 0 && (
        <p className="text-sm text-muted-foreground">No servers match your search.</p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Project mode
// ---------------------------------------------------------------------------

interface ProjectMcpPanelProps {
  projectPath: string
  projectId: string
}

interface MergedServer {
  key: string
  curated: CuratedMcpServer | null
  custom: CustomMcpServer | null
  config: McpServerConfig | null
  providers: McpTarget[]
}

function ProjectMcpPanel({ projectPath, projectId }: ProjectMcpPanelProps) {
  const headerPortal = useHeaderPortal()
  const [enabledProviders, setEnabledProviders] = useState<CliProvider[]>([])
  const [configs, setConfigs] = useState<McpConfigFileResult[]>([])
  const [customServers, setCustomServers] = useState<CustomMcpServer[]>([])
  const [favorites, setFavorites] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [addDialogOpen, setAddDialogOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null)
  const [editProviders, setEditProviders] = useState<McpTarget[]>([])

  const loadConfigs = useCallback(async () => {
    setLoading(true)
    try {
      const [results, custom, providers] = await Promise.all([
        window.api.aiConfig.discoverMcpConfigs(projectPath),
        loadCustomServers(),
        window.api.aiConfig.getProjectProviders(projectId)
      ])
      setConfigs(results)
      setCustomServers(custom)
      setEnabledProviders(providers)
    } finally {
      setLoading(false)
    }
  }, [projectPath, projectId])

  useEffect(() => { void loadConfigs() }, [loadConfigs])

  const enabledMcpTargets = useMemo(
    () => ALL_PROVIDERS.filter((p) => enabledProviders.includes(p)),
    [enabledProviders]
  )

  useEffect(() => {
    void window.api.settings.get('mcp_favorites').then((raw) => {
      if (raw) setFavorites(JSON.parse(raw) as string[])
    })
  }, [])

  const writableProviders = useMemo(
    () => new Set(configs.filter((cfg) => cfg.writable).map((cfg) => cfg.provider)),
    [configs]
  )

  const toggleFavorite = async (id: string) => {
    const next = favorites.includes(id)
      ? favorites.filter((f) => f !== id)
      : [...favorites, id]
    setFavorites(next)
    await window.api.settings.set('mcp_favorites', JSON.stringify(next))
  }

  const isFavorite = (id: string) => favorites.includes(id)

  // Merge configs into unified server list: curated → custom computer → discovered
  const merged: MergedServer[] = []
  const seen = new Set<string>()

  for (const curated of CURATED_MCP_SERVERS) {
    const providers: McpTarget[] = []
    let foundConfig: McpServerConfig | null = null
    for (const cfg of configs) {
      if (cfg.servers[curated.id]) {
        providers.push(cfg.provider)
        if (!foundConfig) foundConfig = cfg.servers[curated.id]
      }
    }
    merged.push({ key: curated.id, curated, custom: null, config: foundConfig, providers })
    seen.add(curated.id)
  }

  for (const cs of customServers) {
    if (seen.has(cs.id)) continue
    const providers: McpTarget[] = []
    let foundConfig: McpServerConfig | null = null
    for (const cfg of configs) {
      if (cfg.servers[cs.id]) {
        providers.push(cfg.provider)
        if (!foundConfig) foundConfig = cfg.servers[cs.id]
      }
    }
    merged.push({ key: cs.id, curated: null, custom: cs, config: foundConfig ?? cs.config, providers })
    seen.add(cs.id)
  }

  for (const cfg of configs) {
    for (const [key, config] of Object.entries(cfg.servers)) {
      if (seen.has(key)) continue
      const existing = merged.find((m) => m.key === key)
      if (existing) {
        existing.providers.push(cfg.provider)
      } else {
        merged.push({ key, curated: null, custom: null, config, providers: [cfg.provider] })
        seen.add(key)
      }
    }
  }

  const enableServer = async (server: MergedServer) => {
    const config = server.curated
      ? { ...server.curated.template }
      : server.custom
        ? { ...server.custom.config }
        : server.config
    if (!config) return
    for (const provider of enabledMcpTargets) {
      if (server.providers.includes(provider)) continue
      await window.api.aiConfig.writeMcpServer({
        projectPath,
        provider,
        serverKey: server.key,
        config
      })
    }
    await loadConfigs()
  }

  const disableServer = async (server: MergedServer) => {
    for (const provider of server.providers) {
      if (!writableProviders.has(provider)) continue
      await window.api.aiConfig.removeMcpServer({
        projectPath,
        provider,
        serverKey: server.key
      })
    }
    await loadConfigs()
  }

  const editServer = (s: MergedServer) => {
    const config = s.custom?.config ?? s.config
    if (!config) return
    setEditTarget({ originalKey: s.key, server: { id: s.key, name: s.custom?.name ?? s.key, description: s.custom?.description, config } })
    setEditProviders([...s.providers])
    setAddDialogOpen(true)
  }

  const isEnabled = (server: MergedServer) => server.providers.length > 0

  const serverName = (s: MergedServer) => s.curated?.name ?? s.custom?.name ?? s.key

  const filterServer = (s: MergedServer) =>
    matchesSearch(search, serverName(s), s.curated?.description, s.curated?.category)

  if (loading) return <p className="text-sm text-muted-foreground">Loading...</p>

  const enabledServers = merged.filter((s) => isEnabled(s) && filterServer(s)).sort((a, b) => serverName(a).localeCompare(serverName(b)))
  const availableServers = merged.filter((m) => !isEnabled(m) && (m.curated || m.custom) && filterServer(m))

  const warningFooter = (s: MergedServer) => {
    const missing = enabledMcpTargets.filter((p) => !s.providers.includes(p))
    if (missing.length === 0) return null
    return (
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] text-amber-600 dark:text-amber-400">
          Missing from: {missing.map((p) => PROVIDER_LABELS[p] ?? p).join(', ')}
        </span>
        <Button
          size="sm"
          variant="outline"
          className="h-6 px-2 text-[10px] shrink-0"
          onClick={() => enableServer(s)}
        >
          Sync
        </Button>
      </div>
    )
  }

  const toggleAction = (s: MergedServer) => {
    const enabled = isEnabled(s)
    return enabled
      ? <Button size="sm" variant="ghost" className="h-6 px-2 text-[10px] text-destructive" onClick={() => disableServer(s)}>Disable</Button>
      : <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]" onClick={() => enableServer(s)}>Enable</Button>
  }

  const availableCardClass = 'opacity-60'

  const renderServerCard = (s: MergedServer, footer?: (s: MergedServer) => React.ReactNode, cardClass?: string) => {
    const cardActions = (
      <>
        {!s.curated && (
          <button
            onClick={() => editServer(s)}
            className="rounded p-0.5 transition-colors hover:bg-muted"
            title="Edit server"
          >
            <Pencil className="size-3.5 text-muted-foreground" />
          </button>
        )}
        {toggleAction(s)}
        <button
          onClick={() => toggleFavorite(s.key)}
          className="rounded p-0.5 transition-colors hover:bg-muted"
          title={isFavorite(s.key) ? 'Remove from favorites' : 'Add to favorites'}
        >
          <Star className={isFavorite(s.key) ? 'size-3.5 fill-amber-400 text-amber-400' : 'size-3.5 text-muted-foreground'} />
        </button>
      </>
    )
    if (s.curated) {
      return (
        <ServerCard
          key={s.key}
          server={s.curated}
          actions={cardActions}
          footer={footer?.(s)}
          className={cardClass}
        />
      )
    }
    if (s.custom) {
      return (
        <CustomServerCard
          key={s.key}
          server={s.custom}
          actions={cardActions}
          footer={footer?.(s)}
          className={cardClass}
        />
      )
    }
    // Unknown server from config files
    return (
      <div key={s.key} className={cn("flex flex-col justify-between rounded-lg border bg-surface-3 p-4 transition-colors", cardClass)}>
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-sm font-medium leading-tight">{s.key}</span>
          <div className="flex shrink-0 items-center gap-1">{cardActions}</div>
        </div>
        {footer && <div className="mt-3 border-t pt-2">{footer(s)}</div>}
      </div>
    )
  }

  const headerActions = (
    <div className="flex items-center gap-2">
      <SearchInput value={search} onChange={setSearch} />
      <Button variant="outline" size="sm" className="h-8 text-xs shrink-0" onClick={() => setAddDialogOpen(true)}>
        <Plus className="size-3 mr-1" />
        Custom
      </Button>
    </div>
  )

  return (
    <div className="space-y-16">
      {headerPortal ? createPortal(headerActions, headerPortal) : headerActions}

      <AddProjectMcpDialog
        open={addDialogOpen}
        onOpenChange={(open) => { setAddDialogOpen(open); if (!open) { setEditTarget(null); setEditProviders([]) } }}
        projectPath={projectPath}
        availableProviders={enabledMcpTargets}
        onAdded={loadConfigs}
        editTarget={editTarget}
        editProviders={editProviders}
      />

      {/* Enabled servers */}
      {enabledServers.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-sm font-semibold">Enabled <span className="text-muted-foreground">{enabledServers.length}</span></h3>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(360px,1fr))] gap-2">
            {enabledServers.map((s) => renderServerCard(s, warningFooter))}
          </div>
        </div>
      )}

      {/* Available servers (curated + custom computer) */}
      {availableServers.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-sm font-semibold">Available <span className="text-muted-foreground">{availableServers.length}</span></h3>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(360px,1fr))] gap-2">
            {[...availableServers].sort((a, b) => {
              const af = isFavorite(a.key) ? 0 : 1
              const bf = isFavorite(b.key) ? 0 : 1
              return af - bf || serverName(a).localeCompare(serverName(b))
            }).map((s) => renderServerCard(s, undefined, availableCardClass))}
          </div>
        </div>
      )}

      {search && enabledServers.length === 0 && availableServers.length === 0 && (
        <p className="text-sm text-muted-foreground">No servers match your search.</p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

interface McpServersPanelProps {
  mode: 'computer' | 'project'
  projectPath?: string
  projectId?: string
}

export function McpServersPanel({ mode, projectPath, projectId }: McpServersPanelProps) {
  if (mode === 'project' && projectPath && projectId) {
    return <ProjectMcpPanel projectPath={projectPath} projectId={projectId} />
  }
  return <ComputerMcpPanel />
}
