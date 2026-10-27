import { useState, useEffect, useCallback } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useTRPC, useTRPCClient } from '@slayzone/transport/client'
import { useDepsChanged } from '@slayzone/ui'
import type {
  TerminalModeInfo,
  CreateTerminalModeInput,
  UpdateTerminalModeInput
} from '@slayzone/terminal/shared'

export function useTerminalModes() {
  const trpc = useTRPC()
  const trpcClient = useTRPCClient()
  const [modes, setModes] = useState<TerminalModeInfo[]>([])
  const [loading, setLoading] = useState(true)

  // Imperative refetch into local state (preserves the previous explicit
  // refresh()-after-mutation flow). This hook owns the `modes` state directly
  // rather than reading a useQuery, so mutations re-run refresh() explicitly.
  // `load` is the fetch alone; whoever starts one marks `loading` first.
  const load = useCallback(async () => {
    try {
      const list = await trpcClient.pty.modesList.query()
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

  const createMutation = useMutation(trpc.pty.modesCreate.mutationOptions())
  const updateMutation = useMutation(trpc.pty.modesUpdate.mutationOptions())
  const deleteMutation = useMutation(trpc.pty.modesDelete.mutationOptions())
  const restoreDefaultsMutation = useMutation(trpc.pty.modesRestoreDefaults.mutationOptions())
  const resetToDefaultStateMutation = useMutation(
    trpc.pty.modesResetToDefaultState.mutationOptions()
  )

  const createMode = async (input: CreateTerminalModeInput) => {
    const newMode = await createMutation.mutateAsync(input)
    await refresh()
    return newMode
  }

  const updateMode = async (id: string, updates: UpdateTerminalModeInput) => {
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
    return await trpcClient.pty.modesTest.query({ command })
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
