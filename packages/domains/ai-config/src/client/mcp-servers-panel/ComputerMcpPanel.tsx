import { createPortal } from 'react-dom'
import { Pencil, Plus, Star, Trash2 } from 'lucide-react'
import { Button } from '@slayzone/ui'
import { CustomServerCard, ServerCard } from './cards/ServerCard'
import { AddComputerMcpDialog } from './dialogs/AddComputerMcpDialog'
import { SearchInput } from './SearchInput'
import { useComputerMcpServers } from './useComputerMcpServers'
import { useHeaderPortal } from './useHeaderPortal'

export function ComputerMcpPanel() {
  const headerPortal = useHeaderPortal()
  const {
    favorites,
    search,
    setSearch,
    addDialogOpen,
    setAddDialogOpen,
    editTarget,
    setEditTarget,
    loadCustom,
    toggleFavorite,
    deleteCustomServer,
    editCustomServer,
    filteredCurated,
    filteredCustom
  } = useComputerMcpServers()

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
    <div className="space-y-4">
      {headerPortal ? createPortal(headerActions, headerPortal) : headerActions}

      <AddComputerMcpDialog
        open={addDialogOpen}
        onOpenChange={(open) => {
          setAddDialogOpen(open)
          if (!open) setEditTarget(null)
        }}
        onAdded={loadCustom}
        editTarget={editTarget}
      />

      {/* Custom servers */}
      {filteredCustom.length > 0 && (
        <div className="space-y-2">
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Custom
          </p>
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
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Curated
            </p>
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
                    <Star
                      className={
                        favorites.includes(s.id)
                          ? 'size-3.5 fill-amber-400 text-amber-400'
                          : 'size-3.5 text-muted-foreground'
                      }
                    />
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
