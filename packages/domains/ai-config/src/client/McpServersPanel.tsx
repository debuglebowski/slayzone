import { useCallback, useEffect, useMemo, useState } from 'react'
import { ExternalLink, Star, Check, Search, Plus, Trash2 } from 'lucide-react'
import { Button, IconButton, Input, Label, Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@slayzone/ui'
import { CURATED_MCP_SERVERS, CATEGORY_LABELS, type CuratedMcpServer } from '../shared/mcp-registry'
import type { McpConfigFileResult, McpTarget, McpServerConfig } from '../shared'
import { getConfigurableMcpTargets } from '../shared/provider-registry'

// ---------------------------------------------------------------------------
// Shared types & helpers
// ---------------------------------------------------------------------------

interface CustomMcpServer {
  id: string
  name: string
  config: McpServerConfig
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

function ServerCard({ server, actions, footer }: {
  server: CuratedMcpServer
  actions?: React.ReactNode
  footer?: React.ReactNode
}) {
  return (
    <div className="flex flex-col justify-between rounded-lg border p-3 transition-colors hover:bg-muted/50">
      <div>
        <div className="flex items-start justify-between gap-2">
          <span className="text-sm font-medium leading-tight">{server.name}</span>
          <div className="flex shrink-0 items-center gap-1">
            {actions}
            <a href={server.url} target="_blank" rel="noopener noreferrer" className="rounded p-0.5 transition-colors hover:bg-muted">
              <ExternalLink className="size-3 text-muted-foreground" />
            </a>
          </div>
        </div>
        <span className="mt-1 inline-block rounded border px-1.5 py-0 text-[10px] text-muted-foreground">
          {CATEGORY_LABELS[server.category]}
        </span>
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{server.description}</p>
      </div>
      {footer && <div className="mt-2 border-t pt-2">{footer}</div>}
    </div>
  )
}

function CustomServerCard({ server, actions, footer }: {
  server: CustomMcpServer
  actions?: React.ReactNode
  footer?: React.ReactNode
}) {
  return (
    <div className="flex flex-col justify-between rounded-lg border p-3 transition-colors hover:bg-muted/50">
      <div>
        <div className="flex items-start justify-between gap-2">
          <span className="text-sm font-medium leading-tight">{server.name}</span>
          <div className="flex shrink-0 items-center gap-1">{actions}</div>
        </div>
        <span className="mt-1 inline-block rounded border px-1.5 py-0 text-[10px] text-muted-foreground">Custom</span>
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground font-mono">
          {server.config.command} {server.config.args.join(' ')}
        </p>
      </div>
      {footer && <div className="mt-2 border-t pt-2">{footer}</div>}
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

const ALL_PROVIDERS: McpTarget[] = getConfigurableMcpTargets({ writableOnly: true })

function createDefaultProviderFlags(): Partial<Record<McpTarget, boolean>> {
  const flags: Partial<Record<McpTarget, boolean>> = {}
  for (const provider of ALL_PROVIDERS) flags[provider] = true
  return flags
}

// ---------------------------------------------------------------------------
// Add/Edit MCP Server dialog — shared between global and project modes
// ---------------------------------------------------------------------------

function McpServerFormFields({ serverKey, setServerKey, command, setCommand, args, setArgs, envVars, setEnvVars }: {
  serverKey: string; setServerKey: (v: string) => void
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
// Global: Add custom server dialog (saves to settings)
// ---------------------------------------------------------------------------

interface AddGlobalMcpDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onAdded: () => void
}

function AddGlobalMcpDialog({ open, onOpenChange, onAdded }: AddGlobalMcpDialogProps) {
  const [serverKey, setServerKey] = useState('')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [envVars, setEnvVars] = useState<Array<{ key: string; value: string }>>([])
  const [adding, setAdding] = useState(false)

  const reset = () => { setServerKey(''); setCommand(''); setArgs(''); setEnvVars([]) }

  const handleAdd = async () => {
    if (!serverKey.trim() || !command.trim()) return
    setAdding(true)
    try {
      const existing = await loadCustomServers()
      const entry: CustomMcpServer = {
        id: serverKey.trim(),
        name: serverKey.trim(),
        config: buildConfig(command, args, envVars)
      }
      await saveCustomServers([...existing.filter((s) => s.id !== entry.id), entry])
      reset()
      onAdded()
      onOpenChange(false)
    } finally {
      setAdding(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Custom MCP Server</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <McpServerFormFields
            serverKey={serverKey} setServerKey={setServerKey}
            command={command} setCommand={setCommand}
            args={args} setArgs={setArgs}
            envVars={envVars} setEnvVars={setEnvVars}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleAdd} disabled={!serverKey.trim() || !command.trim() || adding}>
            {adding ? 'Adding...' : 'Add Server'}
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
  onAdded: () => void
}

function AddProjectMcpDialog({ open, onOpenChange, projectPath, onAdded }: AddProjectMcpDialogProps) {
  const [serverKey, setServerKey] = useState('')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [envVars, setEnvVars] = useState<Array<{ key: string; value: string }>>([])
  const [providers, setProviders] = useState<Partial<Record<McpTarget, boolean>>>(() => createDefaultProviderFlags())
  const [adding, setAdding] = useState(false)

  const reset = () => {
    setServerKey(''); setCommand(''); setArgs(''); setEnvVars([])
    setProviders(createDefaultProviderFlags())
  }

  const handleAdd = async () => {
    if (!serverKey.trim() || !command.trim()) return
    setAdding(true)
    try {
      const config = buildConfig(command, args, envVars)
      for (const [provider, enabled] of Object.entries(providers)) {
        if (!enabled) continue
        await window.api.aiConfig.writeMcpServer({
          projectPath,
          provider: provider as McpTarget,
          serverKey: serverKey.trim(),
          config
        })
      }
      reset()
      onAdded()
      onOpenChange(false)
    } finally {
      setAdding(false)
    }
  }

  const canSubmit = serverKey.trim() && command.trim() && Object.values(providers).some(Boolean)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Custom MCP Server</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <McpServerFormFields
            serverKey={serverKey} setServerKey={setServerKey}
            command={command} setCommand={setCommand}
            args={args} setArgs={setArgs}
            envVars={envVars} setEnvVars={setEnvVars}
          />
          <div className="space-y-1.5">
            <Label className="text-xs">Write to providers</Label>
            <div className="flex items-center gap-4">
              {ALL_PROVIDERS.map((p) => (
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
          <Button onClick={handleAdd} disabled={!canSubmit || adding}>
            {adding ? 'Adding...' : 'Add Server'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Global mode
// ---------------------------------------------------------------------------

function GlobalMcpPanel() {
  const [favorites, setFavorites] = useState<string[]>([])
  const [customServers, setCustomServers] = useState<CustomMcpServer[]>([])
  const [search, setSearch] = useState('')
  const [addDialogOpen, setAddDialogOpen] = useState(false)

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

  const filteredCurated = useMemo(() =>
    CURATED_MCP_SERVERS
      .filter((s) => matchesSearch(search, s.name, s.description, s.category))
      .sort((a, b) => {
        const af = favorites.includes(a.id) ? 0 : 1
        const bf = favorites.includes(b.id) ? 0 : 1
        return af - bf
      }),
    [favorites, search]
  )

  const filteredCustom = useMemo(() =>
    customServers.filter((s) => matchesSearch(search, s.name, s.id)),
    [customServers, search]
  )

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <div className="flex-1">
          <SearchInput value={search} onChange={setSearch} />
        </div>
        <Button variant="outline" size="sm" className="h-8 text-xs shrink-0" onClick={() => setAddDialogOpen(true)}>
          <Plus className="size-3 mr-1" />
          Custom
        </Button>
      </div>

      <AddGlobalMcpDialog
        open={addDialogOpen}
        onOpenChange={setAddDialogOpen}
        onAdded={loadCustom}
      />

      {/* Custom servers */}
      {filteredCustom.length > 0 && (
        <div className="space-y-2">
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Custom</p>
          <div className="grid grid-cols-2 gap-2 xl:grid-cols-4">
            {filteredCustom.map((s) => (
              <CustomServerCard
                key={s.id}
                server={s}
                actions={
                  <button
                    onClick={() => deleteCustomServer(s.id)}
                    className="rounded p-0.5 transition-colors hover:bg-muted"
                    title="Delete custom server"
                  >
                    <Trash2 className="size-3.5 text-muted-foreground" />
                  </button>
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
          <div className="grid grid-cols-2 gap-2 xl:grid-cols-4">
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

function ProjectMcpPanel({ projectPath }: ProjectMcpPanelProps) {
  const [configs, setConfigs] = useState<McpConfigFileResult[]>([])
  const [customServers, setCustomServers] = useState<CustomMcpServer[]>([])
  const [favorites, setFavorites] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [addDialogOpen, setAddDialogOpen] = useState(false)

  const loadConfigs = useCallback(async () => {
    setLoading(true)
    try {
      const [results, custom] = await Promise.all([
        window.api.aiConfig.discoverMcpConfigs(projectPath),
        loadCustomServers()
      ])
      setConfigs(results)
      setCustomServers(custom)
    } finally {
      setLoading(false)
    }
  }, [projectPath])

  useEffect(() => { void loadConfigs() }, [loadConfigs])

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

  // Merge configs into unified server list: curated → custom global → discovered
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
    for (const provider of ALL_PROVIDERS) {
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

  const isEnabled = (server: MergedServer) => server.providers.length > 0

  const serverName = (s: MergedServer) => s.curated?.name ?? s.custom?.name ?? s.key

  const filterServer = (s: MergedServer) =>
    matchesSearch(search, serverName(s), s.curated?.description, s.curated?.category)

  if (loading) return <p className="text-sm text-muted-foreground">Loading...</p>

  const enabledServers = merged.filter((s) => isEnabled(s) && filterServer(s))
  const availableServers = merged.filter((m) => !isEnabled(m) && (m.curated || m.custom) && filterServer(m))

  const enabledFooter = (s: MergedServer) => (
    <div className="flex items-center justify-between gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {s.providers.map((p) => (
          <span key={p} className="flex items-center gap-0.5 text-[10px] text-green-600 dark:text-green-400">
            <Check className="size-2.5" /> {PROVIDER_LABELS[p]}
          </span>
        ))}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button size="sm" variant="ghost" className="h-6 px-2 text-[10px] text-destructive" onClick={() => disableServer(s)}>
          Disable
        </Button>
      </div>
    </div>
  )

  const enableFooter = (s: MergedServer) => (
    <Button
      size="sm"
      variant="outline"
      className="h-6 w-full text-[10px]"
      onClick={() => enableServer(s)}
    >
      Enable
    </Button>
  )

  const renderServerCard = (s: MergedServer, footer: (s: MergedServer) => React.ReactNode) => {
    if (s.curated) {
      return (
        <ServerCard
          key={s.key}
          server={s.curated}
          actions={
            <button
              onClick={() => toggleFavorite(s.key)}
              className="rounded p-0.5 transition-colors hover:bg-muted"
              title={isFavorite(s.key) ? 'Remove from favorites' : 'Add to favorites'}
            >
              <Star className={isFavorite(s.key) ? 'size-3.5 fill-amber-400 text-amber-400' : 'size-3.5 text-muted-foreground'} />
            </button>
          }
          footer={footer(s)}
        />
      )
    }
    if (s.custom) {
      return (
        <CustomServerCard
          key={s.key}
          server={s.custom}
          footer={footer(s)}
        />
      )
    }
    // Unknown server from config files
    return (
      <div key={s.key} className="flex flex-col justify-between rounded-lg border p-3 transition-colors hover:bg-muted/50">
        <div>
          <span className="text-sm font-medium leading-tight">{s.key}</span>
          <span className="mt-1 inline-block rounded border px-1.5 py-0 text-[10px] text-muted-foreground">Custom</span>
        </div>
        <div className="mt-2 border-t pt-2">{footer(s)}</div>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <div className="flex-1">
          <SearchInput value={search} onChange={setSearch} />
        </div>
        <Button variant="outline" size="sm" className="h-8 text-xs shrink-0" onClick={() => setAddDialogOpen(true)}>
          <Plus className="size-3 mr-1" />
          Custom
        </Button>
      </div>

      <AddProjectMcpDialog
        open={addDialogOpen}
        onOpenChange={setAddDialogOpen}
        projectPath={projectPath}
        onAdded={loadConfigs}
      />

      {/* Enabled servers */}
      {enabledServers.length > 0 && (
        <div className="space-y-2">
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Enabled</p>
          <div className="grid grid-cols-2 gap-2 xl:grid-cols-4">
            {enabledServers.map((s) => renderServerCard(s, enabledFooter))}
          </div>
        </div>
      )}

      {/* Available servers (curated + custom global) */}
      {availableServers.length > 0 && (
        <div className="space-y-2">
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Available</p>
          <div className="grid grid-cols-2 gap-2 xl:grid-cols-4">
            {[...availableServers].sort((a, b) => {
              const af = isFavorite(a.key) ? 0 : 1
              const bf = isFavorite(b.key) ? 0 : 1
              return af - bf
            }).map((s) => renderServerCard(s, enableFooter))}
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
  mode: 'global' | 'project'
  projectPath?: string
  projectId?: string
}

export function McpServersPanel({ mode, projectPath, projectId }: McpServersPanelProps) {
  if (mode === 'project' && projectPath && projectId) {
    return <ProjectMcpPanel projectPath={projectPath} projectId={projectId} />
  }
  return <GlobalMcpPanel />
}
