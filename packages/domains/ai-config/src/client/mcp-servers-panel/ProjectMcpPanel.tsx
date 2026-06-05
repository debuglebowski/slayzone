import { createPortal } from 'react-dom'
import { Pencil, Plus, Star } from 'lucide-react'
import { Button, cn } from '@slayzone/ui'
import { CustomServerCard, ServerCard } from './cards/ServerCard'
import { AddProjectMcpDialog } from './dialogs/AddProjectMcpDialog'
import { PROVIDER_LABELS } from './mcp-helpers'
import { SearchInput } from './SearchInput'
import type { MergedServer } from './types'
import { useHeaderPortal } from './useHeaderPortal'
import { useProjectMcpServers } from './useProjectMcpServers'

interface ProjectMcpPanelProps {
  projectPath: string
  projectId: string
}

export function ProjectMcpPanel({ projectPath, projectId }: ProjectMcpPanelProps) {
  const headerPortal = useHeaderPortal()
  const {
    loading,
    search,
    setSearch,
    addDialogOpen,
    setAddDialogOpen,
    editTarget,
    setEditTarget,
    editProviders,
    setEditProviders,
    enabledMcpTargets,
    loadConfigs,
    toggleFavorite,
    isFavorite,
    enableServer,
    disableServer,
    editServer,
    isEnabled,
    serverName,
    enabledServers,
    availableServers
  } = useProjectMcpServers(projectPath, projectId)

  if (loading) return <p className="text-sm text-muted-foreground">Loading...</p>

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
    return enabled ? (
      <Button
        size="sm"
        variant="ghost"
        className="h-6 px-2 text-[10px] text-destructive"
        onClick={() => disableServer(s)}
      >
        Disable
      </Button>
    ) : (
      <Button
        size="sm"
        variant="outline"
        className="h-6 px-2 text-[10px]"
        onClick={() => enableServer(s)}
      >
        Enable
      </Button>
    )
  }

  const availableCardClass = 'opacity-60'

  const renderServerCard = (
    s: MergedServer,
    footer?: (s: MergedServer) => React.ReactNode,
    cardClass?: string
  ) => {
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
          <Star
            className={
              isFavorite(s.key)
                ? 'size-3.5 fill-amber-400 text-amber-400'
                : 'size-3.5 text-muted-foreground'
            }
          />
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
      <div
        key={s.key}
        className={cn(
          'flex flex-col justify-between rounded-lg border bg-surface-3 p-4 transition-colors',
          cardClass
        )}
      >
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
      <Button
        variant="outline"
        size="sm"
        className="h-8 text-xs shrink-0"
        onClick={() => setAddDialogOpen(true)}
      >
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
        onOpenChange={(open) => {
          setAddDialogOpen(open)
          if (!open) {
            setEditTarget(null)
            setEditProviders([])
          }
        }}
        projectPath={projectPath}
        availableProviders={enabledMcpTargets}
        onAdded={loadConfigs}
        editTarget={editTarget}
        editProviders={editProviders}
      />

      {/* Enabled servers */}
      {enabledServers.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-sm font-semibold">
            Enabled <span className="text-muted-foreground">{enabledServers.length}</span>
          </h3>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(360px,1fr))] gap-2">
            {enabledServers.map((s) => renderServerCard(s, warningFooter))}
          </div>
        </div>
      )}

      {/* Available servers (curated + custom computer) */}
      {availableServers.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-sm font-semibold">
            Available <span className="text-muted-foreground">{availableServers.length}</span>
          </h3>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(360px,1fr))] gap-2">
            {[...availableServers]
              .sort((a, b) => {
                const af = isFavorite(a.key) ? 0 : 1
                const bf = isFavorite(b.key) ? 0 : 1
                return af - bf || serverName(a).localeCompare(serverName(b))
              })
              .map((s) => renderServerCard(s, undefined, availableCardClass))}
          </div>
        </div>
      )}

      {search && enabledServers.length === 0 && availableServers.length === 0 && (
        <p className="text-sm text-muted-foreground">No servers match your search.</p>
      )}
    </div>
  )
}
