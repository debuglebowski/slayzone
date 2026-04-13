/**
 * Layout preview components for the Context Manager.
 * All use mocked data — not connected to any real handlers.
 */
import { useState } from 'react'
import {
  Plus, Sparkles, Wrench, Server, FileText, Star,
  ExternalLink, Check, AlertCircle, Trash2, ChevronDown, ChevronRight, Search, ArrowLeft
} from 'lucide-react'
import { Button, cn, Input, Switch, Textarea } from '@slayzone/ui'

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const MOCK_SKILLS = [
  { slug: 'code-review', date: 'Jan 5, 3:02p', synced: true },
  { slug: 'refactor-helper', date: 'Jan 3, 1:15p', synced: true },
  { slug: 'test-generator', date: 'Dec 28, 9:00a', synced: false }
]
const MOCK_COMMANDS = [
  { slug: 'deploy', date: 'Jan 2, 11:30a', synced: true },
  { slug: 'db-migrate', date: 'Dec 30, 4:45p', synced: true }
]
const MOCK_MCP = [
  { id: 'filesystem', name: 'Filesystem', desc: 'Read and write files', cat: 'Files', fav: true, enabled: true },
  { id: 'github', name: 'GitHub', desc: 'Issues, PRs, repos', cat: 'Dev Tools', fav: true, enabled: true },
  { id: 'postgres', name: 'PostgreSQL', desc: 'Query databases', cat: 'Database', fav: false, enabled: true },
  { id: 'memory', name: 'Memory', desc: 'Persistent key-value memory', cat: 'Utilities', fav: false, enabled: false },
  { id: 'brave-search', name: 'Brave Search', desc: 'Web search via Brave', cat: 'Search', fav: true, enabled: false },
  { id: 'puppeteer', name: 'Puppeteer', desc: 'Browser automation', cat: 'Browser', fav: false, enabled: false }
]
const MOCK_INSTRUCTIONS = `This project uses React 19 with TypeScript and TailwindCSS 4.\nFollow existing patterns. Use pnpm for package management.\nAll components should be functional with hooks.`
const MOCK_PROVIDERS = [
  { id: 'claude', name: 'Claude Code', enabled: true },
  { id: 'codex', name: 'Codex', enabled: true }
]

// ---------------------------------------------------------------------------
// Shared small components
// ---------------------------------------------------------------------------

function Pill({ active, children, onClick }: { active: boolean; children: React.ReactNode; onClick?: () => void }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
        active
          ? 'bg-background text-foreground shadow-sm'
          : 'text-muted-foreground hover:text-foreground'
      )}
    >
      {children}
    </button>
  )
}

function ProviderDots() {
  return (
    <div className="flex items-center gap-3">
      {MOCK_PROVIDERS.map(p => (
        <label key={p.id} className="flex items-center gap-1.5 text-xs">
          <div className={cn('size-2 rounded-full', p.enabled ? 'bg-green-500' : 'bg-muted-foreground/30')} />
          {p.name}
        </label>
      ))}
    </div>
  )
}

function ProviderToggles() {
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">Enable the CLI tools you use.</p>
      {MOCK_PROVIDERS.map(p => (
        <div key={p.id} className="flex items-center justify-between rounded-md border px-3 py-2.5">
          <span className="text-sm font-medium">{p.name}</span>
          <Switch checked={p.enabled} />
        </div>
      ))}
    </div>
  )
}

function SkillRow({ slug, date, synced }: { slug: string; date: string; synced?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2.5 transition-colors hover:bg-muted/50">
      <span className="truncate font-mono text-sm">{slug}</span>
      <div className="flex items-center gap-2">
        {synced !== undefined && (
          <span className={cn(
            'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase',
            synced ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
          )}>
            {synced ? <Check className="size-2.5" /> : <AlertCircle className="size-2.5" />}
            Claude
          </span>
        )}
        <span className="shrink-0 text-[11px] text-muted-foreground">{date}</span>
      </div>
    </div>
  )
}

function ProjectSkillRow({ slug, local }: { slug: string; local?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2.5 transition-colors hover:bg-muted/50">
      <span className="truncate font-mono text-sm">{slug}</span>
      <div className="flex items-center gap-2">
        {local ? (
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">Local</span>
        ) : (
          <>
            <span className="inline-flex items-center gap-1 rounded bg-green-100 px-1.5 py-0.5 text-[10px] font-medium uppercase text-green-700 dark:bg-green-900/30 dark:text-green-400">
              <Check className="size-2.5" />Claude
            </span>
            <span className="inline-flex items-center gap-1 rounded bg-green-100 px-1.5 py-0.5 text-[10px] font-medium uppercase text-green-700 dark:bg-green-900/30 dark:text-green-400">
              <Check className="size-2.5" />Codex
            </span>
          </>
        )}
        <button className="rounded p-1 text-muted-foreground hover:text-destructive">
          <Trash2 className="size-3.5" />
        </button>
      </div>
    </div>
  )
}

function McpCard({ s, showStar }: { s: typeof MOCK_MCP[0]; showStar?: boolean }) {
  const [fav, setFav] = useState(s.fav)
  return (
    <div className="flex flex-col justify-between rounded-lg border p-3 transition-colors hover:bg-muted/50">
      <div>
        <div className="flex items-start justify-between gap-2">
          <span className="text-sm font-medium leading-tight">{s.name}</span>
          <div className="flex shrink-0 items-center gap-1">
            {showStar !== false && (
              <button onClick={() => setFav(!fav)} className="rounded p-0.5 transition-colors hover:bg-muted">
                <Star className={fav ? 'size-3.5 fill-amber-400 text-amber-400' : 'size-3.5 text-muted-foreground'} />
              </button>
            )}
            <span className="rounded p-0.5"><ExternalLink className="size-3 text-muted-foreground" /></span>
          </div>
        </div>
        <span className="mt-1 inline-block rounded border px-1.5 py-0 text-[10px] text-muted-foreground">{s.cat}</span>
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{s.desc}</p>
      </div>
    </div>
  )
}

function SyncBar() {
  return (
    <div className="sticky bottom-0 -mx-6 mt-4 flex items-center justify-end gap-2 border-t bg-background px-6 py-3">
      <span className="text-[11px] text-muted-foreground">2 written</span>
      <Button size="sm" disabled>Sync</Button>
    </div>
  )
}

function SearchBar() {
  return (
    <div className="relative">
      <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input placeholder="Search servers..." className="h-8 pl-8 text-xs" />
    </div>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{children}</p>
}

function InstructionsEditor({ placeholder }: { placeholder?: string }) {
  return (
    <Textarea
      className="min-h-[200px] resize-y font-mono text-sm"
      placeholder={placeholder}
      defaultValue={MOCK_INSTRUCTIONS}
    />
  )
}

function ProviderStatus() {
  return (
    <div className="flex items-center gap-3">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Check className="size-3 text-green-600 dark:text-green-400" />
        <span>CLAUDE.md</span>
      </div>
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Check className="size-3 text-green-600 dark:text-green-400" />
        <span>AGENTS.md</span>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Inline editor mock (for two-panel)
// ---------------------------------------------------------------------------

function InlineEditor({ slug }: { slug: string }) {
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground">Filename</label>
        <Input className="font-mono text-sm" defaultValue={slug} />
      </div>
      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground">Content</label>
        <Textarea
          className="min-h-48 font-mono text-sm"
          defaultValue={`---\ndescription: Auto-generated\ntrigger: auto\n---\n\nReview the code for correctness...`}
        />
      </div>
      <div className="flex items-center justify-between pt-1">
        <span className="text-[11px] text-muted-foreground">Autosave on blur</span>
        <Button size="sm" variant="ghost" className="text-destructive"><Trash2 className="mr-1 size-3" />Delete</Button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Overview panel — shared by all layouts
// ---------------------------------------------------------------------------

function OverviewPanel({ isProject }: { isProject: boolean }) {
  const syncedSkills = MOCK_SKILLS.filter(s => s.synced).length
  const syncedCommands = MOCK_COMMANDS.filter(s => s.synced).length
  const enabledMcp = MOCK_MCP.filter(s => s.enabled).length

  const StatusBadge = ({ ok, total, label }: { ok: number; total: number; label: string }) => {
    const allGood = ok === total
    return (
      <span className={cn(
        'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium',
        allGood
          ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
          : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
      )}>
        {allGood ? <Check className="size-2.5" /> : <AlertCircle className="size-2.5" />}
        {label} {ok}/{total}
      </span>
    )
  }

  return (
    <div className="space-y-3">
      {/* Instructions */}
      <div className="rounded-lg border p-3.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FileText className="size-4 text-muted-foreground" />
            <span className="text-sm font-medium">Instructions</span>
          </div>
          {isProject ? (
            <ProviderStatus />
          ) : (
            <span className="inline-flex items-center gap-1 rounded bg-green-100 px-1.5 py-0.5 text-[10px] font-medium text-green-700 dark:bg-green-900/30 dark:text-green-400">
              <Check className="size-2.5" /> Saved
            </span>
          )}
        </div>
        <p className="mt-1.5 line-clamp-2 text-xs text-muted-foreground">{MOCK_INSTRUCTIONS.slice(0, 100)}...</p>
      </div>

      {/* Skills */}
      <div className="rounded-lg border p-3.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sparkles className="size-4 text-muted-foreground" />
            <span className="text-sm font-medium">Skills</span>
            <span className="text-xs text-muted-foreground">{MOCK_SKILLS.length} defined</span>
          </div>
          {isProject ? (
            <div className="flex items-center gap-1.5">
              <StatusBadge ok={syncedSkills} total={MOCK_SKILLS.length} label="Claude" />
              <StatusBadge ok={syncedSkills} total={MOCK_SKILLS.length} label="Codex" />
            </div>
          ) : (
            <StatusBadge ok={syncedSkills} total={MOCK_SKILLS.length} label="synced" />
          )}
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {MOCK_SKILLS.map(s => (
            <span key={s.slug} className="rounded border bg-muted/30 px-2 py-0.5 font-mono text-[11px]">{s.slug}</span>
          ))}
        </div>
      </div>

      {/* Commands */}
      <div className="rounded-lg border p-3.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Wrench className="size-4 text-muted-foreground" />
            <span className="text-sm font-medium">Commands</span>
            <span className="text-xs text-muted-foreground">{MOCK_COMMANDS.length} defined</span>
          </div>
          {isProject ? (
            <div className="flex items-center gap-1.5">
              <StatusBadge ok={syncedCommands} total={MOCK_COMMANDS.length} label="Claude" />
              <StatusBadge ok={syncedCommands} total={MOCK_COMMANDS.length} label="Codex" />
            </div>
          ) : (
            <StatusBadge ok={syncedCommands} total={MOCK_COMMANDS.length} label="synced" />
          )}
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {MOCK_COMMANDS.map(s => (
            <span key={s.slug} className="rounded border bg-muted/30 px-2 py-0.5 font-mono text-[11px]">{s.slug}</span>
          ))}
        </div>
      </div>

      {/* MCP Servers */}
      <div className="rounded-lg border p-3.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Server className="size-4 text-muted-foreground" />
            <span className="text-sm font-medium">MCP Servers</span>
          </div>
          <span className="text-xs text-muted-foreground">{enabledMcp} enabled</span>
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {MOCK_MCP.filter(s => s.enabled).map(s => (
            <span key={s.id} className="inline-flex items-center gap-1 rounded border bg-muted/30 px-2 py-0.5 text-[11px]">
              {s.fav && <Star className="size-2.5 fill-amber-400 text-amber-400" />}
              {s.name}
            </span>
          ))}
        </div>
      </div>

      {/* Providers (project only) */}
      {isProject && (
        <div className="rounded-lg border p-3.5">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Providers</span>
            <ProviderDots />
          </div>
        </div>
      )}
    </div>
  )
}

// ============================================================================
// LAYOUT A: Refined Tabs
// ============================================================================

export function LayoutPreviewA({ scope }: { scope: 'library' | 'project' }) {
  const isProject = scope === 'project'
  const [tab, setTab] = useState<string>('overview')

  return (
    <div className={cn(isProject && 'flex min-h-full flex-col')}>
      <div className="flex items-center justify-between gap-3 pb-4">
        <div className="flex items-center gap-1 rounded-lg border bg-muted/30 p-1">
          <Pill active={tab === 'overview'} onClick={() => setTab('overview')}>Overview</Pill>
          <Pill active={tab === 'instructions'} onClick={() => setTab('instructions')}>Instructions</Pill>
          <Pill active={tab === 'skills'} onClick={() => setTab('skills')}>Skills</Pill>
          <Pill active={tab === 'commands'} onClick={() => setTab('commands')}>Commands</Pill>
          <Pill active={tab === 'mcp'} onClick={() => setTab('mcp')}>MCP Servers</Pill>
          {isProject && (
            <>
              <div className="mx-1 h-4 w-px bg-border" />
              <Pill active={tab === 'files'} onClick={() => setTab('files')}>Files</Pill>
            </>
          )}
        </div>
        {(tab === 'skills' || tab === 'commands') && (
          <div className="flex items-center gap-2">
            <Button size="sm"><Plus className="mr-1 size-3.5" />New</Button>
            {isProject && <Button size="sm" variant="outline"><Plus className="mr-1 size-3.5" />Add from Library</Button>}
          </div>
        )}
      </div>

      {/* Provider bar — always visible */}
      <div className="mb-4 flex items-center gap-2 rounded-md border bg-muted/20 px-3 py-2">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {isProject ? 'Sync to:' : 'Providers:'}
        </span>
        <ProviderDots />
      </div>

      <div className="flex-1">
        {tab === 'overview' && <OverviewPanel isProject={isProject} />}
        {tab === 'instructions' && (
          <div className="space-y-4">
            <InstructionsEditor />
            {isProject && <ProviderStatus />}
          </div>
        )}
        {tab === 'skills' && (
          <div className="space-y-2">
            {isProject
              ? <>
                  <ProjectSkillRow slug="code-review" />
                  <ProjectSkillRow slug="local-helper" local />
                </>
              : MOCK_SKILLS.map(s => <SkillRow key={s.slug} {...s} />)
            }
          </div>
        )}
        {tab === 'commands' && (
          <div className="space-y-2">
            {isProject
              ? <ProjectSkillRow slug="deploy" />
              : MOCK_COMMANDS.map(s => <SkillRow key={s.slug} {...s} />)
            }
          </div>
        )}
        {tab === 'mcp' && (
          <div className="space-y-3">
            <SearchBar />
            <div className="grid grid-cols-2 gap-2 xl:grid-cols-4">
              {MOCK_MCP.map(s => <McpCard key={s.id} s={s} />)}
            </div>
          </div>
        )}
        {tab === 'files' && (
          <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
            File tree preview
          </div>
        )}
      </div>

      {isProject && <SyncBar />}
    </div>
  )
}

// ============================================================================
// LAYOUT B: Secondary Sidebar
// ============================================================================

export function LayoutPreviewB({ scope }: { scope: 'library' | 'project' }) {
  const isProject = scope === 'project'
  const items = isProject
    ? [
        { key: 'overview', label: 'Overview', icon: FileText },
        { key: 'instructions', label: 'Instructions', icon: FileText },
        { key: 'skills', label: 'Skills', icon: Sparkles },
        { key: 'commands', label: 'Commands', icon: Wrench },
        { key: 'mcp', label: 'MCP Servers', icon: Server },
        { key: 'sep', label: '', icon: null },
        { key: 'files', label: 'Files', icon: FileText },
        { key: 'providers', label: 'Providers', icon: null }
      ]
    : [
        { key: 'overview', label: 'Overview', icon: FileText },
        { key: 'instructions', label: 'Instructions', icon: FileText },
        { key: 'skills', label: 'Skills', icon: Sparkles },
        { key: 'commands', label: 'Commands', icon: Wrench },
        { key: 'mcp', label: 'MCP Servers', icon: Server },
        { key: 'sep', label: '', icon: null },
        { key: 'providers', label: 'Providers', icon: null }
      ]
  const [tab, setTab] = useState('overview')

  return (
    <div className={cn('flex gap-0 rounded-lg border', isProject && 'min-h-[500px]')}>
      {/* Inner sidebar */}
      <div className="w-40 shrink-0 border-r bg-muted/20 p-2">
        <div className="space-y-0.5">
          {items.map(item => item.key === 'sep' ? (
            <div key="sep" className="my-2 h-px bg-border" />
          ) : (
            <button
              key={item.key}
              onClick={() => setTab(item.key)}
              className={cn(
                'flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-xs font-medium transition-colors',
                tab === item.key
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {item.icon && <item.icon className="size-3.5" />}
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="flex flex-1 flex-col overflow-hidden p-4">
        <div className="flex items-center justify-between pb-3">
          <h3 className="text-sm font-medium">
            {tab === 'skills' ? 'Skills' : tab === 'commands' ? 'Commands' : tab === 'instructions' ? 'Instructions' : tab === 'mcp' ? 'MCP Servers' : tab === 'providers' ? 'Providers' : 'Files'}
          </h3>
          {(tab === 'skills' || tab === 'commands') && (
            <div className="flex items-center gap-2">
              <Button size="sm"><Plus className="mr-1 size-3.5" />New</Button>
              {isProject && <Button size="sm" variant="outline"><Plus className="mr-1 size-3.5" />Add from Library</Button>}
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto">
          {tab === 'overview' && <OverviewPanel isProject={isProject} />}
          {tab === 'instructions' && (
            <div className="space-y-4">
              <InstructionsEditor />
              {isProject && <ProviderStatus />}
            </div>
          )}
          {tab === 'skills' && (
            <div className="space-y-2">
              {isProject
                ? <><ProjectSkillRow slug="code-review" /><ProjectSkillRow slug="local-helper" local /></>
                : MOCK_SKILLS.map(s => <SkillRow key={s.slug} {...s} />)
              }
            </div>
          )}
          {tab === 'commands' && (
            <div className="space-y-2">
              {isProject ? <ProjectSkillRow slug="deploy" /> : MOCK_COMMANDS.map(s => <SkillRow key={s.slug} {...s} />)}
            </div>
          )}
          {tab === 'mcp' && (
            <div className="space-y-3">
              <SearchBar />
              <div className="grid grid-cols-2 gap-2 xl:grid-cols-3">
                {MOCK_MCP.map(s => <McpCard key={s.id} s={s} />)}
              </div>
            </div>
          )}
          {tab === 'providers' && <ProviderToggles />}
          {tab === 'files' && (
            <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">File tree preview</div>
          )}
        </div>

        {isProject && (
          <div className="mt-3 flex items-center justify-end gap-2 border-t pt-3">
            <span className="text-[11px] text-muted-foreground">2 written</span>
            <Button size="sm" disabled>Sync</Button>
          </div>
        )}
      </div>
    </div>
  )
}

// ============================================================================
// LAYOUT C: Two-Panel Master-Detail
// ============================================================================

export function LayoutPreviewC({ scope }: { scope: 'library' | 'project' }) {
  const isProject = scope === 'project'
  const [tab, setTab] = useState<string>('overview')
  const [selected, setSelected] = useState<string | null>('code-review')

  const allItems = [
    { group: 'Instructions', items: [{ slug: 'Root instructions', type: 'inst' }] },
    { group: 'Skills', items: MOCK_SKILLS.map(s => ({ slug: s.slug, type: 'skill' })) },
    { group: 'Commands', items: MOCK_COMMANDS.map(s => ({ slug: s.slug, type: 'cmd' })) }
  ]

  return (
    <div className={cn(isProject && 'flex min-h-full flex-col')}>
      <div className="flex items-center justify-between gap-3 pb-4">
        <div className="flex items-center gap-1 rounded-lg border bg-muted/30 p-1">
          <Pill active={tab === 'overview'} onClick={() => setTab('overview')}>Overview</Pill>
          <Pill active={tab === 'content'} onClick={() => setTab('content')}>Content</Pill>
          <Pill active={tab === 'mcp'} onClick={() => setTab('mcp')}>MCP Servers</Pill>
          {isProject && <Pill active={tab === 'files'} onClick={() => setTab('files')}>Files</Pill>}
          <Pill active={tab === 'providers'} onClick={() => setTab('providers')}>Providers</Pill>
        </div>
        {tab === 'content' && (
          <div className="flex items-center gap-2">
            <Button size="sm"><Plus className="mr-1 size-3.5" />New</Button>
            {isProject && <Button size="sm" variant="outline"><Plus className="mr-1 size-3.5" />Add from Library</Button>}
          </div>
        )}
      </div>

      <div className="flex-1">
        {tab === 'overview' && <OverviewPanel isProject={isProject} />}
        {tab === 'content' && (
          <div className="flex gap-0 rounded-lg border" style={{ minHeight: 420 }}>
            {/* Master list */}
            <div className="w-56 shrink-0 overflow-y-auto border-r">
              {allItems.map(group => (
                <div key={group.group}>
                  <div className="px-3 pt-3 pb-1">
                    <SectionLabel>{group.group}</SectionLabel>
                  </div>
                  {group.items.map(item => (
                    <button
                      key={item.slug}
                      onClick={() => setSelected(item.slug)}
                      className={cn(
                        'flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors',
                        selected === item.slug ? 'bg-muted/50 font-medium text-foreground' : 'text-muted-foreground hover:bg-muted/30'
                      )}
                    >
                      {item.type === 'skill' && <Sparkles className="size-3 shrink-0" />}
                      {item.type === 'cmd' && <Wrench className="size-3 shrink-0" />}
                      {item.type === 'inst' && <FileText className="size-3 shrink-0" />}
                      <span className="truncate font-mono text-xs">{item.slug}</span>
                    </button>
                  ))}
                </div>
              ))}
            </div>

            {/* Detail pane */}
            <div className="flex-1 p-4">
              {selected === 'Root instructions' ? (
                <div className="space-y-4">
                  <InstructionsEditor />
                  {isProject && <ProviderStatus />}
                </div>
              ) : selected ? (
                <InlineEditor slug={selected} />
              ) : (
                <p className="text-sm text-muted-foreground">Select an item to edit</p>
              )}
            </div>
          </div>
        )}
        {tab === 'mcp' && (
          <div className="space-y-3">
            <SearchBar />
            <div className="grid grid-cols-2 gap-2 xl:grid-cols-4">
              {MOCK_MCP.map(s => <McpCard key={s.id} s={s} />)}
            </div>
          </div>
        )}
        {tab === 'providers' && <ProviderToggles />}
        {tab === 'files' && (
          <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">File tree preview</div>
        )}
      </div>

      {isProject && <SyncBar />}
    </div>
  )
}

// ============================================================================
// LAYOUT D: Dashboard Cards
// ============================================================================

export function LayoutPreviewD({ scope }: { scope: 'library' | 'project' }) {
  const isProject = scope === 'project'
  const [drill, setDrill] = useState<string | null>(null)

  if (drill) {
    return (
      <div className={cn(isProject && 'flex min-h-full flex-col')}>
        <div className="flex items-center justify-between pb-4">
          <button onClick={() => setDrill(null)} className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="size-3.5" /> Back to Overview
          </button>
          {(drill === 'skills' || drill === 'commands') && (
            <div className="flex items-center gap-2">
              <Button size="sm"><Plus className="mr-1 size-3.5" />New</Button>
              {isProject && <Button size="sm" variant="outline"><Plus className="mr-1 size-3.5" />Add from Library</Button>}
            </div>
          )}
        </div>
        <div className="flex-1">
          {drill === 'instructions' && (
            <div className="space-y-4">
              <InstructionsEditor />
              {isProject && <ProviderStatus />}
            </div>
          )}
          {drill === 'skills' && (
            <div className="space-y-2">
              {isProject
                ? <><ProjectSkillRow slug="code-review" /><ProjectSkillRow slug="local-helper" local /></>
                : MOCK_SKILLS.map(s => <SkillRow key={s.slug} {...s} />)
              }
            </div>
          )}
          {drill === 'commands' && (
            <div className="space-y-2">
              {isProject ? <ProjectSkillRow slug="deploy" /> : MOCK_COMMANDS.map(s => <SkillRow key={s.slug} {...s} />)}
            </div>
          )}
          {drill === 'mcp' && (
            <div className="space-y-3">
              <SearchBar />
              <div className="grid grid-cols-2 gap-2 xl:grid-cols-4">
                {MOCK_MCP.map(s => <McpCard key={s.id} s={s} />)}
              </div>
            </div>
          )}
          {drill === 'files' && (
            <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">File tree preview</div>
          )}
          {drill === 'providers' && <ProviderToggles />}
        </div>
        {isProject && <SyncBar />}
      </div>
    )
  }

  return (
    <div className={cn(isProject && 'flex min-h-full flex-col')}>
      {/* Provider bar */}
      <div className="mb-4 flex items-center gap-2 rounded-md border bg-muted/20 px-3 py-2">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Providers:</span>
        <ProviderDots />
      </div>

      {/* Cards grid */}
      <div className="grid grid-cols-2 gap-3">
        {/* Instructions card */}
        <button onClick={() => setDrill('instructions')} className="rounded-lg border p-4 text-left transition-colors hover:bg-muted/50">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <FileText className="size-4 text-muted-foreground" />
              <span className="text-sm font-medium">Instructions</span>
            </div>
            <ChevronRight className="size-4 text-muted-foreground" />
          </div>
          {isProject && <div className="mt-2"><ProviderStatus /></div>}
          <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">{MOCK_INSTRUCTIONS.slice(0, 80)}...</p>
        </button>

        {/* Skills card */}
        <button onClick={() => setDrill('skills')} className="rounded-lg border p-4 text-left transition-colors hover:bg-muted/50">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Sparkles className="size-4 text-muted-foreground" />
              <span className="text-sm font-medium">Skills</span>
            </div>
            <ChevronRight className="size-4 text-muted-foreground" />
          </div>
          <p className="mt-2 text-xs text-muted-foreground">{MOCK_SKILLS.length} skills defined</p>
          <div className="mt-1.5 space-y-0.5">
            {MOCK_SKILLS.slice(0, 3).map(s => (
              <p key={s.slug} className="truncate font-mono text-xs text-muted-foreground">{s.slug}</p>
            ))}
          </div>
        </button>

        {/* Commands card */}
        <button onClick={() => setDrill('commands')} className="rounded-lg border p-4 text-left transition-colors hover:bg-muted/50">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Wrench className="size-4 text-muted-foreground" />
              <span className="text-sm font-medium">Commands</span>
            </div>
            <ChevronRight className="size-4 text-muted-foreground" />
          </div>
          <p className="mt-2 text-xs text-muted-foreground">{MOCK_COMMANDS.length} commands defined</p>
          <div className="mt-1.5 space-y-0.5">
            {MOCK_COMMANDS.map(s => (
              <p key={s.slug} className="truncate font-mono text-xs text-muted-foreground">{s.slug}</p>
            ))}
          </div>
        </button>

        {/* MCP card */}
        <button onClick={() => setDrill('mcp')} className="rounded-lg border p-4 text-left transition-colors hover:bg-muted/50">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Server className="size-4 text-muted-foreground" />
              <span className="text-sm font-medium">MCP Servers</span>
            </div>
            <ChevronRight className="size-4 text-muted-foreground" />
          </div>
          <p className="mt-2 text-xs text-muted-foreground">{MOCK_MCP.filter(s => s.enabled).length} enabled</p>
          <div className="mt-1.5 space-y-0.5">
            {MOCK_MCP.filter(s => s.enabled).map(s => (
              <p key={s.id} className="truncate text-xs text-muted-foreground">
                {s.fav && <Star className="mr-1 inline size-2.5 fill-amber-400 text-amber-400" />}{s.name}
              </p>
            ))}
          </div>
        </button>
      </div>

      {/* Files row (project only) */}
      {isProject && (
        <button onClick={() => setDrill('files')} className="mt-3 flex w-full items-center justify-between rounded-lg border p-4 text-left transition-colors hover:bg-muted/50">
          <div className="flex items-center gap-2">
            <FileText className="size-4 text-muted-foreground" />
            <span className="text-sm font-medium">Files</span>
            <span className="text-xs text-muted-foreground">12 context files across 3 providers</span>
          </div>
          <ChevronRight className="size-4 text-muted-foreground" />
        </button>
      )}

      {isProject && <SyncBar />}
    </div>
  )
}

// ============================================================================
// LAYOUT E: Stacked Accordion
// ============================================================================

export function LayoutPreviewE({ scope }: { scope: 'library' | 'project' }) {
  const isProject = scope === 'project'
  const [open, setOpen] = useState<Record<string, boolean>>({ instructions: true, skills: true })
  const toggle = (key: string) => setOpen(prev => ({ ...prev, [key]: !prev[key] }))

  const AccordionHeader = ({ id, label, badge, actions }: { id: string; label: string; badge?: string; actions?: React.ReactNode }) => (
    <button
      onClick={() => toggle(id)}
      className="flex w-full items-center justify-between rounded-t-lg border px-4 py-3 text-left transition-colors hover:bg-muted/30"
    >
      <div className="flex items-center gap-2">
        {open[id] ? <ChevronDown className="size-4 text-muted-foreground" /> : <ChevronRight className="size-4 text-muted-foreground" />}
        <span className="text-sm font-medium">{label}</span>
        {badge && !open[id] && <span className="text-xs text-muted-foreground">{badge}</span>}
      </div>
      {open[id] && actions && <div onClick={e => e.stopPropagation()}>{actions}</div>}
    </button>
  )

  return (
    <div className={cn(isProject && 'flex min-h-full flex-col')}>
      {/* Provider bar */}
      <div className="mb-4 flex items-center gap-2 rounded-md border bg-muted/20 px-3 py-2">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Providers:</span>
        <ProviderDots />
      </div>

      <div className="flex-1 space-y-3">
        {/* Instructions */}
        <div>
          <AccordionHeader
            id="instructions"
            label="Instructions"
            badge={isProject ? 'CLAUDE.md ✓' : undefined}
          />
          {open.instructions && (
            <div className="rounded-b-lg border border-t-0 p-4">
              <div className="space-y-4">
                <InstructionsEditor />
                {isProject && <ProviderStatus />}
              </div>
            </div>
          )}
        </div>

        {/* Skills */}
        <div>
          <AccordionHeader
            id="skills"
            label="Skills"
            badge={`${MOCK_SKILLS.length} skills`}
            actions={
              <div className="flex items-center gap-2">
                <Button size="sm"><Plus className="mr-1 size-3.5" />New</Button>
                {isProject && <Button size="sm" variant="outline"><Plus className="mr-1 size-3.5" />Library</Button>}
              </div>
            }
          />
          {open.skills && (
            <div className="space-y-2 rounded-b-lg border border-t-0 p-4">
              {isProject
                ? <><ProjectSkillRow slug="code-review" /><ProjectSkillRow slug="local-helper" local /></>
                : MOCK_SKILLS.map(s => <SkillRow key={s.slug} {...s} />)
              }
            </div>
          )}
        </div>

        {/* Commands */}
        <div>
          <AccordionHeader
            id="commands"
            label="Commands"
            badge={`${MOCK_COMMANDS.length} commands`}
            actions={
              <div className="flex items-center gap-2">
                <Button size="sm"><Plus className="mr-1 size-3.5" />New</Button>
                {isProject && <Button size="sm" variant="outline"><Plus className="mr-1 size-3.5" />Library</Button>}
              </div>
            }
          />
          {open.commands && (
            <div className="space-y-2 rounded-b-lg border border-t-0 p-4">
              {isProject ? <ProjectSkillRow slug="deploy" /> : MOCK_COMMANDS.map(s => <SkillRow key={s.slug} {...s} />)}
            </div>
          )}
        </div>

        {/* MCP */}
        <div>
          <AccordionHeader
            id="mcp"
            label="MCP Servers"
            badge={`${MOCK_MCP.filter(s => s.enabled).length} enabled, ${MOCK_MCP.filter(s => s.fav).length} ★`}
          />
          {open.mcp && (
            <div className="space-y-3 rounded-b-lg border border-t-0 p-4">
              <SearchBar />
              <div className="grid grid-cols-2 gap-2 xl:grid-cols-3">
                {MOCK_MCP.map(s => <McpCard key={s.id} s={s} />)}
              </div>
            </div>
          )}
        </div>

        {/* Files (project) */}
        {isProject && (
          <div>
            <AccordionHeader id="files" label="Files" badge="12 files" />
            {open.files && (
              <div className="rounded-b-lg border border-t-0 p-4">
                <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">File tree preview</div>
              </div>
            )}
          </div>
        )}
      </div>

      {isProject && <SyncBar />}
    </div>
  )
}

// ============================================================================
// LAYOUT F: Hybrid (2 tabs)
// ============================================================================

export function LayoutPreviewF({ scope }: { scope: 'library' | 'project' }) {
  const isProject = scope === 'project'
  const [tab, setTab] = useState<string>('overview')

  return (
    <div className={cn(isProject && 'flex min-h-full flex-col')}>
      {/* Provider bar + Files link */}
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2 rounded-md border bg-muted/20 px-3 py-2">
          <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Providers:</span>
          <ProviderDots />
        </div>
        {isProject && (
          <button className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
            Files ↗
          </button>
        )}
      </div>

      <div className="flex items-center gap-3 pb-4">
        <div className="flex items-center gap-1 rounded-lg border bg-muted/30 p-1">
          <Pill active={tab === 'overview'} onClick={() => setTab('overview')}>Overview</Pill>
          <Pill active={tab === 'content'} onClick={() => setTab('content')}>Content</Pill>
          <Pill active={tab === 'mcp'} onClick={() => setTab('mcp')}>MCP Servers</Pill>
        </div>
      </div>

      <div className="flex-1">
        {tab === 'overview' && <OverviewPanel isProject={isProject} />}
        {tab === 'content' && (
          <div className="space-y-6">
            {/* Instructions section */}
            <div>
              <div className="flex items-center justify-between pb-2">
                <SectionLabel>Instructions</SectionLabel>
                {isProject && <ProviderStatus />}
              </div>
              <InstructionsEditor />
            </div>

            {/* Skills section */}
            <div>
              <div className="flex items-center justify-between pb-2">
                <SectionLabel>Skills</SectionLabel>
                <div className="flex items-center gap-2">
                  <Button size="sm"><Plus className="mr-1 size-3.5" />New</Button>
                  {isProject && <Button size="sm" variant="outline"><Plus className="mr-1 size-3.5" />Add from Library</Button>}
                </div>
              </div>
              <div className="space-y-2">
                {isProject
                  ? <><ProjectSkillRow slug="code-review" /><ProjectSkillRow slug="local-helper" local /></>
                  : MOCK_SKILLS.map(s => <SkillRow key={s.slug} {...s} />)
                }
              </div>
            </div>

            {/* Commands section */}
            <div>
              <div className="flex items-center justify-between pb-2">
                <SectionLabel>Commands</SectionLabel>
                <div className="flex items-center gap-2">
                  <Button size="sm"><Plus className="mr-1 size-3.5" />New</Button>
                  {isProject && <Button size="sm" variant="outline"><Plus className="mr-1 size-3.5" />Add from Library</Button>}
                </div>
              </div>
              <div className="space-y-2">
                {isProject ? <ProjectSkillRow slug="deploy" /> : MOCK_COMMANDS.map(s => <SkillRow key={s.slug} {...s} />)}
              </div>
            </div>
          </div>
        )}

        {tab === 'mcp' && (
          <div className="space-y-3">
            <SearchBar />
            <div className="grid grid-cols-2 gap-2 xl:grid-cols-4">
              {MOCK_MCP.map(s => <McpCard key={s.id} s={s} />)}
            </div>
          </div>
        )}
      </div>

      {isProject && <SyncBar />}
    </div>
  )
}

// ============================================================================
// LAYOUT G: Minimal Tabs (3 tabs)
// ============================================================================

export function LayoutPreviewG({ scope }: { scope: 'library' | 'project' }) {
  const isProject = scope === 'project'
  const [tab, setTab] = useState<string>('overview')

  return (
    <div className={cn(isProject && 'flex min-h-full flex-col')}>
      <div className="flex items-center gap-3 pb-4">
        <div className="flex items-center gap-1 rounded-lg border bg-muted/30 p-1">
          <Pill active={tab === 'overview'} onClick={() => setTab('overview')}>Overview</Pill>
          <Pill active={tab === 'content'} onClick={() => setTab('content')}>Content</Pill>
          <Pill active={tab === 'mcp'} onClick={() => setTab('mcp')}>MCP Servers</Pill>
          <Pill active={tab === 'providers'} onClick={() => setTab('providers')}>Providers</Pill>
          {isProject && (
            <>
              <div className="mx-1 h-4 w-px bg-border" />
              <Pill active={tab === 'files'} onClick={() => setTab('files')}>Files</Pill>
            </>
          )}
        </div>
      </div>

      <div className="flex-1">
        {tab === 'overview' && <OverviewPanel isProject={isProject} />}
        {tab === 'content' && (
          <div className="space-y-8">
            {/* Instructions */}
            <div>
              <div className="flex items-center justify-between border-b pb-2">
                <span className="text-sm font-medium">Instructions</span>
                {isProject && <ProviderStatus />}
              </div>
              <div className="pt-3">
                <InstructionsEditor />
              </div>
            </div>

            {/* Skills */}
            <div>
              <div className="flex items-center justify-between border-b pb-2">
                <span className="text-sm font-medium">Skills</span>
                <div className="flex items-center gap-2">
                  <Button size="sm"><Plus className="mr-1 size-3.5" />New</Button>
                  {isProject && <Button size="sm" variant="outline"><Plus className="mr-1 size-3.5" />Add from Library</Button>}
                </div>
              </div>
              <div className="space-y-2 pt-3">
                {isProject
                  ? <><ProjectSkillRow slug="code-review" /><ProjectSkillRow slug="local-helper" local /></>
                  : MOCK_SKILLS.map(s => <SkillRow key={s.slug} {...s} />)
                }
              </div>
            </div>

            {/* Commands */}
            <div>
              <div className="flex items-center justify-between border-b pb-2">
                <span className="text-sm font-medium">Commands</span>
                <div className="flex items-center gap-2">
                  <Button size="sm"><Plus className="mr-1 size-3.5" />New</Button>
                  {isProject && <Button size="sm" variant="outline"><Plus className="mr-1 size-3.5" />Add from Library</Button>}
                </div>
              </div>
              <div className="space-y-2 pt-3">
                {isProject ? <ProjectSkillRow slug="deploy" /> : MOCK_COMMANDS.map(s => <SkillRow key={s.slug} {...s} />)}
              </div>
            </div>
          </div>
        )}

        {tab === 'mcp' && (
          <div className="space-y-3">
            <SearchBar />
            <div className="grid grid-cols-2 gap-2 xl:grid-cols-4">
              {MOCK_MCP.map(s => <McpCard key={s.id} s={s} />)}
            </div>
          </div>
        )}

        {tab === 'providers' && <ProviderToggles />}

        {tab === 'files' && (
          <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">File tree preview</div>
        )}
      </div>

      {isProject && <SyncBar />}
    </div>
  )
}
