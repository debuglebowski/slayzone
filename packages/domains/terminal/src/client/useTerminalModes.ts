import { useState, useEffect, useCallback } from 'react'
import type { TerminalModeInfo, CreateTerminalModeInput, UpdateTerminalModeInput } from '@slayzone/terminal/shared'

export function useTerminalModes() {
  const [modes, setModes] = useState<TerminalModeInfo[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const list = await window.api.terminalModes.list()
      setModes(list)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const createMode = async (input: CreateTerminalModeInput) => {
    const newMode = await window.api.terminalModes.create(input)
    await refresh()
    return newMode
  }

  const updateMode = async (id: string, updates: UpdateTerminalModeInput) => {
    const updated = await window.api.terminalModes.update(id, updates)
    await refresh()
    return updated
  }

  const deleteMode = async (id: string) => {
    const success = await window.api.terminalModes.delete(id)
    await refresh()
    return success
  }

  const testMode = async (command: string) => {
    return await window.api.terminalModes.test(command)
  }

  const restoreDefaults = async () => {
    await window.api.terminalModes.restoreDefaults()
    await refresh()
  }

  const resetToDefaultState = async () => {
    await window.api.terminalModes.resetToDefaultState()
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
