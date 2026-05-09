import { useEffect, useRef, useCallback, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useTRPC } from '@slayzone/transport/client'
import { useSetting, useSetSettingMutation } from '@slayzone/settings/client'

type HomePanel = 'kanban' | 'git' | 'editor' | 'processes' | 'tests' | 'automations'

export interface HomePanelState {
  visibility: Record<HomePanel, boolean>
  gitTab: string
}

const DEFAULTS: HomePanelState = {
  visibility: { kanban: true, git: false, editor: false, processes: false, tests: false, automations: false },
  gitTab: 'general'
}

function getKey(projectId: string): string {
  return `home-panels:${projectId}`
}

function parse(value: string): HomePanelState {
  const raw = JSON.parse(value)
  const result: HomePanelState = { ...DEFAULTS, visibility: { ...DEFAULTS.visibility } }
  if (raw.visibility && typeof raw.visibility === 'object') {
    for (const key of Object.keys(DEFAULTS.visibility) as HomePanel[]) {
      if (typeof raw.visibility[key] === 'boolean') result.visibility[key] = raw.visibility[key]
    }
  }
  if (typeof raw.gitTab === 'string') result.gitTab = raw.gitTab
  return result
}

export function useHomePanelState(
  projectId: string
): [HomePanelState, (updater: (prev: HomePanelState) => HomePanelState) => void] {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const stored = useSetting(getKey(projectId))
  const setSetting = useSetSettingMutation()
  const [state, setState] = useState<HomePanelState>(DEFAULTS)
  const stateRef = useRef(state)
  stateRef.current = state
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingRef = useRef<HomePanelState | null>(null)

  const flushSave = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (pendingRef.current) {
      setSetting.mutate({ key: getKey(projectId), value: JSON.stringify(pendingRef.current) })
      pendingRef.current = null
    }
  }, [projectId, setSetting])

  // Hydrate local state from cache
  useEffect(() => {
    if (stored === undefined) return // not loaded
    if (stored) {
      try { setState(parse(stored)) } catch { /* use defaults */ }
    } else {
      setState(DEFAULTS)
    }
  }, [stored])

  // Reset on project change (separate from above, since useSetting key changes too)
  useEffect(() => {
    setState(DEFAULTS)
    queryClient.invalidateQueries({ queryKey: trpc.settings.get.queryKey({ key: getKey(projectId) }) })
  }, [projectId, queryClient, trpc])

  // Flush pending save on project change / unmount
  useEffect(() => {
    return () => flushSave()
  }, [flushSave])

  // Flush on hard reload / quit
  useEffect(() => {
    const handler = (): void => flushSave()
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [flushSave])

  const update = useCallback((updater: (prev: HomePanelState) => HomePanelState) => {
    const next = updater(stateRef.current)
    stateRef.current = next
    setState(next)
    pendingRef.current = next
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      pendingRef.current = null
      setSetting.mutate({ key: getKey(projectId), value: JSON.stringify(next) })
    }, 500)
  }, [projectId, setSetting])

  return [state, update]
}
