import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTRPCClient } from '@slayzone/transport/client'
import { CURATED_MCP_SERVERS } from '../../shared/mcp-registry'
import { loadCustomServers, matchesSearch, saveCustomServers } from './mcp-helpers'
import type { CustomMcpServer, EditTarget } from './types'

export function useComputerMcpServers() {
  const trpcClient = useTRPCClient()
  const [favorites, setFavorites] = useState<string[]>([])
  const [customServers, setCustomServers] = useState<CustomMcpServer[]>([])
  const [search, setSearch] = useState('')
  const [addDialogOpen, setAddDialogOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null)

  const loadCustom = useCallback(async () => {
    setCustomServers(await loadCustomServers(trpcClient))
  }, [trpcClient])

  useEffect(() => {
    void trpcClient.settings.get.query({ key: 'mcp_favorites' }).then((raw) => {
      if (raw) setFavorites(JSON.parse(raw) as string[])
    })
    void loadCustom()
  }, [trpcClient, loadCustom])

  const toggleFavorite = async (id: string) => {
    const next = favorites.includes(id) ? favorites.filter((f) => f !== id) : [...favorites, id]
    setFavorites(next)
    await trpcClient.settings.set.mutate({ key: 'mcp_favorites', value: JSON.stringify(next) })
  }

  const deleteCustomServer = async (id: string) => {
    const next = customServers.filter((s) => s.id !== id)
    setCustomServers(next)
    await saveCustomServers(trpcClient, next)
  }

  const editCustomServer = (server: CustomMcpServer) => {
    setEditTarget({ originalKey: server.id, server })
    setAddDialogOpen(true)
  }

  const filteredCurated = useMemo(
    () =>
      CURATED_MCP_SERVERS.filter((s) =>
        matchesSearch(search, s.name, s.description, s.category)
      ).sort((a, b) => {
        const af = favorites.includes(a.id) ? 0 : 1
        const bf = favorites.includes(b.id) ? 0 : 1
        return af - bf || a.name.localeCompare(b.name)
      }),
    [favorites, search]
  )

  const filteredCustom = useMemo(
    () =>
      customServers
        .filter((s) => matchesSearch(search, s.name, s.id))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [customServers, search]
  )

  return {
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
  }
}
