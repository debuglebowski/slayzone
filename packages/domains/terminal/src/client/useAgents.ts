import { useState, useEffect, useCallback } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useTRPC, useTRPCClient } from './trpc'
import { useDepsChanged } from '@slayzone/ui'
import type {
  AgentDefinition,
  CreateAgentDefinitionInput,
  UpdateAgentDefinitionInput
} from '@slayzone/terminal-contracts'

export function useAgents() {
  const trpc = useTRPC()
  const trpcClient = useTRPCClient()
  const [modes, setModes] = useState<AgentDefinition[]>([])
  const [loading, setLoading] = useState(true)

  // Imperative refetch into local state (preserves the previous explicit
  // refresh()-after-mutation flow). This hook owns the `modes` state directly
  // rather than reading a useQuery, so mutations re-run refresh() explicitly.
  // `load` is the fetch alone; whoever starts one marks `loading` first.
  const load = useCallback(async () => {
    try {
      const list = await trpcClient.pty.agentsList.query()
      setModes(list)
    } finally {
      setLoading(false)
    }
  }, [trpcClient])

  const refresh = useCallback(async () => {
    setLoading(true)
    await load()
  }, [load])

  // A new client reloads the list: `loading` is set while rendering (it starts
  // true for the mount's load), the fetch starts after commit.
  if (useDepsChanged([trpcClient])) setLoading(true)
  useEffect(() => {
    void load()
  }, [load])

  const createMutation = useMutation(trpc.pty.agentsCreate.mutationOptions())
  const updateMutation = useMutation(trpc.pty.agentsUpdate.mutationOptions())
  const deleteMutation = useMutation(trpc.pty.agentsDelete.mutationOptions())
  const restoreDefaultsMutation = useMutation(trpc.pty.agentsRestoreDefaults.mutationOptions())
  const resetToDefaultStateMutation = useMutation(
    trpc.pty.agentsResetToDefaultState.mutationOptions()
  )

  const createMode = async (input: CreateAgentDefinitionInput) => {
    const newMode = await createMutation.mutateAsync(input)
    await refresh()
    return newMode
  }

  const updateMode = async (id: string, updates: UpdateAgentDefinitionInput) => {
    const updated = await updateMutation.mutateAsync({ id, updates })
    await refresh()
    return updated
  }

  const deleteMode = async (id: string) => {
    const success = await deleteMutation.mutateAsync({ id })
    await refresh()
    return success
  }

  const testMode = async (command: string) => {
    return await trpcClient.pty.agentsTest.query({ command })
  }

  const restoreDefaults = async () => {
    await restoreDefaultsMutation.mutateAsync()
    await refresh()
  }

  const resetToDefaultState = async () => {
    await resetToDefaultStateMutation.mutateAsync()
    await refresh()
  }

  return {
    modes,
    loading,
    refresh,
    createMode,
    updateMode,
    deleteMode,
    testMode,
    restoreDefaults,
    resetToDefaultState
  }
}
