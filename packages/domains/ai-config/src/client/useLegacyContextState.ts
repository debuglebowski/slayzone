import { useEffect, useState } from 'react'
import { useTRPCClient } from '@slayzone/transport/client'
import { buildDefaultSkillContent } from '../shared'
import type { AiConfigItem, UpdateAiConfigItemInput } from '../shared'
import type { ContextManagerSection, Section } from './ContextManagerSettings.types'
import { nextAvailableSlug } from './ContextManagerSettings.utils'
import { useDepsChanged } from '@slayzone/ui'

export function useLegacyContextState(initialSection: ContextManagerSection | null) {
  const trpcClient = useTRPCClient()
  const [section, setSection] = useState<Section | null>(initialSection)
  const [items, setItems] = useState<AiConfigItem[]>([])
  const [editingId, setEditingId] = useState<string | null>(null)
  // Starts true when mounting on the item section: the load effect below begins
  // loading right away.
  const [loading, setLoading] = useState(() => initialSection === 'skill')
  const [providerVersion] = useState(0)
  const [syncCheckVersion] = useState(0)

  // A new initialSection prop re-selects the section (adjusted while rendering;
  // on mount the state already starts from it).
  const initialSectionChanged = useDepsChanged([initialSection])
  if (initialSectionChanged) setSection(initialSection)

  const isItemSection = section === 'skill'

  // Switching section (or client) drops the open editor and, on the item section,
  // restarts the load below — adjusted while rendering.
  const sectionChanged = useDepsChanged([trpcClient, section])
  if (sectionChanged) {
    setEditingId(null)
    if (isItemSection) setLoading(true)
  }

  useEffect(() => {
    if (!isItemSection) return
    void trpcClient.aiConfig.listItems.query({ scope: 'library', type: 'skill' }).then(
      (rows) => {
        setItems(rows)
        setLoading(false)
      },
      (err: unknown) => {
        setLoading(false)
        throw err
      }
    )
  }, [trpcClient, section, isItemSection])

  const handleCreate = async () => {
    if (!isItemSection) return
    const existingSlugs = new Set(items.map((item) => item.slug))
    const slug = nextAvailableSlug('new-skill', existingSlugs)
    const created = await trpcClient.aiConfig.createItem.mutate({
      type: 'skill',
      scope: 'library',
      slug,
      content: buildDefaultSkillContent(slug)
    })
    setItems((prev) => [created, ...prev])
    setEditingId(created.id)
  }

  const handleUpdate = async (itemId: string, patch: Omit<UpdateAiConfigItemInput, 'id'>) => {
    const updated = await trpcClient.aiConfig.updateItem.mutate({ id: itemId, ...patch })
    if (!updated) return
    setItems((prev) => prev.map((item) => (item.id === updated.id ? updated : item)))
  }

  const handleDelete = async (itemId: string) => {
    await trpcClient.aiConfig.deleteItem.mutate({ id: itemId })
    setItems((prev) => prev.filter((item) => item.id !== itemId))
    setEditingId(null)
  }

  return {
    section,
    setSection,
    items,
    editingId,
    setEditingId,
    loading,
    providerVersion,
    syncCheckVersion,
    isItemSection,
    handleCreate,
    handleUpdate,
    handleDelete
  }
}
