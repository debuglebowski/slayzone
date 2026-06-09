import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react'
import { useTRPCClient } from '@slayzone/transport/client'
import { toast } from '@slayzone/ui'
import { repairSkillFrontmatter } from '../shared'
import type { AiConfigItem, CliProvider, ProjectSkillStatus } from '../shared'
import { PROVIDER_PATHS } from '../shared/provider-registry'
import { getSkillValidation } from './skill-validation'
import type { ProviderRow } from './ItemSection.types'
import { providerSupportsType } from './ItemSection.utils'

export function useSkillItem({
  item,
  providers,
  enabledProviders,
  isLocal,
  projectId,
  projectPath,
  onChanged
}: {
  item: AiConfigItem
  providers: ProjectSkillStatus['providers']
  enabledProviders: CliProvider[]
  isLocal: boolean
  projectId: string
  projectPath: string
  onChanged: () => void
}) {
  const trpcClient = useTRPCClient()
  const [slug, setSlugRaw] = useState(item.slug)
  const [content, setContent] = useState(item.content)
  const validation = getSkillValidation({
    type: item.type,
    slug: item.slug,
    content
  })
  const hasValidationErrors = validation?.status === 'invalid'
  const [slugDirty, setSlugDirty] = useState(false)
  const [savingSlug, setSavingSlug] = useState(false)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [expandedProviders, setExpandedProviders] = useState<Set<CliProvider>>(new Set())
  const [diskContents, setDiskContents] = useState<Partial<Record<CliProvider, string>>>({})
  const [expectedContents, setExpectedContents] = useState<Partial<Record<CliProvider, string>>>({})
  const [syncingProvider, setSyncingProvider] = useState<CliProvider | null>(null)
  const [pullingProvider, setPullingProvider] = useState<CliProvider | null>(null)
  const [syncingAll, setSyncingAll] = useState(false)

  useEffect(() => {
    setContent(item.content)
    setSlugRaw(item.slug)
    setSlugDirty(false)
  }, [item.content, item.slug])

  const providerRows: ProviderRow[] = enabledProviders
    .filter((p) => {
      if (!providerSupportsType(p)) return false
      if (isLocal) return true
      const info = providers[p]
      return info?.syncReason !== 'not_linked'
    })
    .map((p) => {
      const info = providers[p]
      const path = info?.path ?? `${PROVIDER_PATHS[p]?.skillsDir}/${item.slug}/SKILL.md`
      const syncHealth = info?.syncHealth ?? 'not_synced'
      return { provider: p, path, syncHealth }
    })

  const saveContent = useCallback(
    async (text: string) => {
      try {
        await trpcClient.aiConfig.updateItem.mutate({ id: item.id, content: text })
        setExpectedContents({})
        onChanged()
      } catch {
        /* silent */
      }
    },
    [trpcClient, item.id, onChanged]
  )

  const handleContentChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    const text = e.target.value
    setContent(text)
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => void saveContent(text), 800)
  }

  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
    },
    []
  )

  const handleSlugSave = async () => {
    setSavingSlug(true)
    try {
      await trpcClient.aiConfig.updateItem.mutate({ id: item.id, slug })
      setSlugDirty(false)
      setExpectedContents({})
      onChanged()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Rename failed')
    } finally {
      setSavingSlug(false)
    }
  }

  const handleRevert = async () => {
    try {
      await trpcClient.aiConfig.syncLinkedFile.mutate({ projectId, projectPath, itemId: item.id })
      toast.success(`Reverted ${item.slug} to library`)
      onChanged()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Revert failed')
    }
  }

  const loadDiskAndExpected = useCallback(
    async (provider: CliProvider) => {
      const [disk, expected] = await Promise.all([
        trpcClient.aiConfig.readProviderSkill.query({ projectPath, provider, itemId: item.id }),
        trpcClient.aiConfig.getExpectedSkillContent.query({ projectPath, provider, itemId: item.id })
      ])
      setDiskContents((prev) => ({ ...prev, [provider]: disk.exists ? disk.content : '' }))
      setExpectedContents((prev) => ({ ...prev, [provider]: expected }))
    },
    [trpcClient, projectPath, item.id]
  )

  const toggleExpanded = (provider: CliProvider) => {
    setExpandedProviders((prev) => {
      const next = new Set(prev)
      if (next.has(provider)) {
        next.delete(provider)
      } else {
        next.add(provider)
        void loadDiskAndExpected(provider)
      }
      return next
    })
  }

  const handlePush = async (provider: CliProvider) => {
    setSyncingProvider(provider)
    try {
      await trpcClient.aiConfig.syncLinkedFile.mutate({
        projectId,
        projectPath,
        itemId: item.id,
        provider
      })
      const expected = expectedContents[provider]
      if (expected !== undefined) {
        setDiskContents((prev) => ({ ...prev, [provider]: expected }))
      }
      onChanged()
    } finally {
      setSyncingProvider(null)
    }
  }

  const handlePull = async (provider: CliProvider) => {
    setPullingProvider(provider)
    try {
      await trpcClient.aiConfig.pullProviderSkill.mutate({
        projectId,
        projectPath,
        provider,
        itemId: item.id
      })
      onChanged()
    } finally {
      setPullingProvider(null)
    }
  }

  const handleSyncAll = async () => {
    setSyncingAll(true)
    try {
      await trpcClient.aiConfig.syncLinkedFile.mutate({ projectId, projectPath, itemId: item.id })
      const updated: Partial<Record<CliProvider, string>> = {}
      for (const { provider } of providerRows) {
        const expected = expectedContents[provider]
        if (expected !== undefined) updated[provider] = expected
      }
      setDiskContents((prev) => ({ ...prev, ...updated }))
      onChanged()
    } finally {
      setSyncingAll(false)
    }
  }

  const handleFixFrontmatter = async () => {
    const nextContent = repairSkillFrontmatter(item.slug, content)
    setContent(nextContent)
    try {
      await trpcClient.aiConfig.updateItem.mutate({ id: item.id, content: nextContent })
      setExpectedContents({})
      onChanged()
    } catch {
      toast.error('Failed to update skill frontmatter')
    }
  }

  return {
    item,
    slug,
    content,
    slugDirty,
    savingSlug,
    isLocal,
    validation,
    hasValidationErrors,
    providerRows,
    expandedProviders,
    diskContents,
    expectedContents,
    syncingProvider,
    pullingProvider,
    syncingAll,
    setSlug: (v: string) => {
      setSlugRaw(v)
      setSlugDirty(v !== item.slug)
    },
    handleContentChange,
    handleSlugSave,
    handleRevert,
    handleFixFrontmatter,
    toggleExpanded,
    handlePush,
    handlePull,
    handleSyncAll
  }
}
