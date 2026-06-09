import { useState, useCallback } from 'react'
import { useTRPCClient } from '@slayzone/transport/client'
import type { Task } from '@slayzone/task/shared'
import type { ValidationResult } from '@slayzone/terminal/shared'

export interface UseTaskDoctorResult {
  doctorDialogOpen: boolean
  setDoctorDialogOpen: (open: boolean) => void
  doctorResults: ValidationResult[] | null
  doctorLoading: boolean
  handleDoctor: () => Promise<void>
}

/** Doctor dialog: validate the CLI binary and dependencies for the task's terminal mode. */
export function useTaskDoctor(task: Task | null): UseTaskDoctorResult {
  const trpcClient = useTRPCClient()
  const [doctorDialogOpen, setDoctorDialogOpen] = useState(false)
  const [doctorResults, setDoctorResults] = useState<ValidationResult[] | null>(null)
  const [doctorLoading, setDoctorLoading] = useState(false)

  const handleDoctor = useCallback(async () => {
    if (!task) return
    setDoctorLoading(true)
    setDoctorResults(null)
    setDoctorDialogOpen(true)
    try {
      const results = await trpcClient.pty.validate.query({ mode: task.terminal_mode })
      setDoctorResults(results)
    } catch {
      setDoctorResults([{ check: 'Validation', ok: false, detail: 'Failed to run checks' }])
    } finally {
      setDoctorLoading(false)
    }
  }, [task, trpcClient])

  return { doctorDialogOpen, setDoctorDialogOpen, doctorResults, doctorLoading, handleDoctor }
}
