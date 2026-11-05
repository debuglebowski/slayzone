import { useCallback, useEffect, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import type { AgentId } from '@slayzone/terminal-contracts'
import { toast } from '@slayzone/ui'
import { useTRPC } from '../trpc'

const KEY = 'default_agent_id'

/**
 * The hub's default agent provider (`default_agent_id`, a `hub` key read by task
 * create). Bound to the ambient hub, so a section inside `<HubWideSection>` reads and
 * writes the picked hub's.
 *
 * A new stored value re-seeds the pick (which a local pick overrides in between). A
 * pick broadcasts `sz:settings-changed` so every other reader in this window refetches.
 */
export function useDefaultAgent(): {
  defaultAgentId: AgentId
  setDefaultAgentId: (id: AgentId) => void
} {
  const trpc = useTRPC()
  const [defaultAgentId, setLocal] = useState<AgentId>('claude-code')
  // staleTime 0: a reopened dialog refetches instead of showing a cached snapshot.
  const query = useQuery(trpc.settings.get.queryOptions({ key: KEY }, { staleTime: 0 }))
  const { refetch } = query
  const { mutate } = useMutation(
    trpc.settings.set.mutationOptions({
      onError: (err) => toast.error(`Could not save: ${err.message}`)
    })
  )

  // Adjusted while rendering, on new data.
  const [seen, setSeen] = useState<typeof query.data>()
  if (seen !== query.data) {
    setSeen(query.data)
    if (query.data) setLocal(query.data as AgentId)
  }

  useEffect(() => {
    const onChanged = () => {
      void refetch()
    }
    window.addEventListener('sz:settings-changed', onChanged)
    return () => window.removeEventListener('sz:settings-changed', onChanged)
  }, [refetch])

  const setDefaultAgentId = useCallback(
    (id: AgentId) => {
      setLocal(id)
      mutate({ key: KEY, value: id })
      window.dispatchEvent(new CustomEvent('sz:settings-changed'))
    },
    [mutate]
  )

  return { defaultAgentId, setDefaultAgentId }
}
