import { useEffect, useMemo, useRef, useState } from 'react'
import { repairSkillFrontmatter } from '../shared'
import type { CliProvider, UpdateAiConfigItemInput } from '../shared'
import { PROVIDER_LABELS } from '../shared/provider-registry'
import {
  getMarketplaceProvenance,
  getSkillFrontmatterActionLabel,
  getSkillValidation
} from './skill-validation'
import {
  aggregateProviderSyncHealth,
  groupProvidersByPath,
  type ProviderGroup
} from './sync-view-model'
import { useContextManagerStore } from './useContextManagerStore'
import { PROVIDER_ROW_ORDER } from './ContextItemEditor.constants'
import { getJsonValidation } from './ContextItemEditor.utils'
import type { ContextItemEditorProps } from './ContextItemEditor.types'

export function useContextItemEditorState({
  item,
  validationState,
  onUpdate,
  readOnly,
  syncStatus,
  onSyncToDisk,
  onSyncProviderToDisk,
  onPullProviderFromDisk
}: ContextItemEditorProps) {
  const provenance = getMarketplaceProvenance(item)
  const isMarketplaceBound = !!provenance
  const isLibraryLinked = !isMarketplaceBound && !!readOnly && item.scope === 'library'
  const effectiveReadOnly = readOnly || isMarketplaceBound
  const navigateToMarketplaceEntry = useContextManagerStore((s) => s.navigateToMarketplaceEntry)
  const navigateToLibrarySkill = useContextManagerStore((s) => s.navigateToLibrarySkill)
  const [slug, setSlug] = useState(item.slug)
  const [content, setContent] = useState(item.content)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [syncingAll, setSyncingAll] = useState(false)
  const [syncingProvider, setSyncingProvider] = useState<CliProvider | null>(null)
  const [pullingProvider, setPullingProvider] = useState<CliProvider | null>(null)
  const [activeDiffProvider, setActiveDiffProvider] = useState<CliProvider | null>(null)

  const { aggregatedHealth, providerGroups, staleProviders } = useMemo(() => {
    if (!syncStatus) {
      return {
        aggregatedHealth: null,
        providerGroups: [] as ProviderGroup[],
        staleProviders: [] as CliProvider[]
      }
    }
    const health = aggregateProviderSyncHealth(syncStatus.providers)
    const groups = groupProvidersByPath(syncStatus.providers, PROVIDER_ROW_ORDER)
    const stales: CliProvider[] = []
    for (const group of groups) {
      if (group.syncHealth === 'stale') stales.push(group.providers[0])
    }
    return { aggregatedHealth: health, providerGroups: groups, staleProviders: stales }
  }, [syncStatus])

  const isStale = aggregatedHealth === 'stale' && staleProviders.length > 0

  useEffect(() => {
    if (activeDiffProvider && !staleProviders.includes(activeDiffProvider)) {
      setActiveDiffProvider(staleProviders[0] ?? null)
    }
  }, [activeDiffProvider, staleProviders])

  const autoSelectedItemRef = useRef<string | null>(null)
  useEffect(() => {
    if (autoSelectedItemRef.current === item.id) return
    autoSelectedItemRef.current = item.id
    setActiveDiffProvider(staleProviders[0] ?? null)
  }, [item.id, staleProviders])

  const activeDiffDisk = activeDiffProvider
    ? (syncStatus?.providers[activeDiffProvider]?.diskContent ?? null)
    : null
  const activeDiffGroupLabel = activeDiffProvider
    ? (providerGroups
        .find((g) => g.providers.includes(activeDiffProvider))
        ?.providers.map((p) => PROVIDER_LABELS[p])
        .join(' / ') ?? PROVIDER_LABELS[activeDiffProvider])
    : null

  const handleSyncAllToDisk = async () => {
    if (!onSyncToDisk) return
    setSyncingAll(true)
    setError(null)
    try {
      await onSyncToDisk()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to sync')
    } finally {
      setSyncingAll(false)
    }
  }

  const handleSyncProvider = async (provider: CliProvider) => {
    if (!onSyncProviderToDisk) return
    setSyncingProvider(provider)
    setError(null)
    try {
      await onSyncProviderToDisk(provider)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to sync')
    } finally {
      setSyncingProvider(null)
    }
  }

  const handlePullProvider = async (provider: CliProvider) => {
    if (!onPullProviderFromDisk) return
    setPullingProvider(provider)
    setError(null)
    try {
      await onPullProviderFromDisk(provider)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to pull')
    } finally {
      setPullingProvider(null)
    }
  }

  const anySyncBusy = syncingAll || syncingProvider !== null || pullingProvider !== null
  const effectiveValidation =
    validationState ??
    getSkillValidation({
      type: item.type,
      slug: item.slug,
      content
    })

  useEffect(() => {
    setSlug(item.slug)
    setContent(item.content)
  }, [item.slug, item.content])

  const save = async (patch: Omit<UpdateAiConfigItemInput, 'id'>) => {
    setSaving(true)
    setError(null)
    try {
      await onUpdate(patch)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  const { isJson, jsonError } = getJsonValidation(slug, content)

  const fixFrontmatterLabel = getSkillFrontmatterActionLabel(effectiveValidation)

  const handleFixFrontmatter = async () => {
    const nextContent = repairSkillFrontmatter(item.slug, content)
    setContent(nextContent)
    await save({ content: nextContent })
  }

  return {
    provenance,
    isMarketplaceBound,
    isLibraryLinked,
    effectiveReadOnly,
    navigateToMarketplaceEntry,
    navigateToLibrarySkill,
    slug,
    setSlug,
    content,
    setContent,
    saving,
    error,
    setError,
    syncingAll,
    syncingProvider,
    pullingProvider,
    activeDiffProvider,
    setActiveDiffProvider,
    providerGroups,
    isStale,
    activeDiffDisk,
    activeDiffGroupLabel,
    handleSyncAllToDisk,
    handleSyncProvider,
    handlePullProvider,
    anySyncBusy,
    effectiveValidation,
    isJson,
    jsonError,
    fixFrontmatterLabel,
    handleFixFrontmatter,
    save
  }
}
