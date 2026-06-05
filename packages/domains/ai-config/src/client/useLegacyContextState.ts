import { useCallback, useEffect, useState } from 'react'
import { buildDefaultSkillContent } from '../shared'
import type { AiConfigItem, UpdateAiConfigItemInput } from '../shared'
import type { ContextManagerSection, Section } from './ContextManagerSettings.types'
import { nextAvailableSlug } from './ContextManagerSettings.utils'

export function useLegacyContextState(initialSection: ContextManagerSection | null) {
  const [section, setSection] = useState<Section | null>(initialSection)
  const [items, setItems] = useState<AiConfigItem[]>([])
  const [editingId, setEditingId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [providerVersion] = useState(0)
  const [syncCheckVersion] = useState(0)

  const isItemSection = section === 'skill'

  const loadItems = useCallback(async () => {
    if (!isItemSection) return
    setLoading(true)
    try {
      const rows = await window.api.aiConfig.listItems({
        scope: 'library',
        type: 'skill'
      })
      setItems(rows)
    } finally {
      setLoading(false)
    }
  }, [section, isItemSection])

  useEffect(() => {
    void loadItems()
    setEditingId(null)
  }, [loadItems])

  useEffect(() => {
    setSection(initialSection)
  }, [initialSection])

  const handleCreate = async () => {
    if (!isItemSection) return
    const existingSlugs = new Set(items.map((item) => item.slug))
    const slug = nextAvailableSlug('new-skill', existingSlugs)
    const created = await window.api.aiConfig.createItem({
      type: 'skill',
      scope: 'library',
      slug,
      content: buildDefaultSkillContent(slug)
    })
    setItems((prev) => [created, ...prev])
    setEditingId(created.id)
  }

  const handleUpdate = async (itemId: string, patch: Omit<UpdateAiConfigItemInput, 'id'>) => {
    const updated = await window.api.aiConfig.updateItem({ id: itemId, ...patch })
    if (!updated) return
    setItems((prev) => prev.map((item) => (item.id === updated.id ? updated : item)))
  }

  const handleDelete = async (itemId: string) => {
    await window.api.aiConfig.deleteItem(itemId)
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
