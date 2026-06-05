import { useState } from 'react'
import { toast } from '@slayzone/ui'
import type {
  TerminalModeInfo,
  CreateTerminalModeInput
} from '@slayzone/terminal/shared'
import { slugify } from './utils'

type TestResult = { ok: boolean; error?: string; detail?: string }

interface UseAiProviderFormParams {
  createMode: (input: CreateTerminalModeInput) => Promise<TerminalModeInfo>
  testMode: (command: string) => Promise<TestResult>
}

export function useAiProviderForm({ createMode, testMode }: UseAiProviderFormParams) {
  const [testResults, setTestResults] = useState<Record<string, TestResult>>({})
  const [testingId, setTestingId] = useState<string | null>(null)
  const [showAddForm, setShowAddForm] = useState(false)

  // New mode state encapsulated inside the tab
  const [newModeLabel, setNewModeLabel] = useState('')
  const [newInitialCommand, setNewInitialCommand] = useState('')
  const [newResumeCommand, setNewResumeCommand] = useState('')
  const [newDefaultFlags, setNewDefaultFlags] = useState('')
  const [newDetectionEngine, setNewDetectionEngine] = useState('terminal')
  const [newPatternWorking, setNewPatternWorking] = useState('')
  const [newPatternError, setNewPatternError] = useState('')

  const duplicateMode = (mode: TerminalModeInfo) => {
    setNewModeLabel(`${mode.label} (Copy)`)
    setNewInitialCommand(mode.initialCommand || '')
    setNewResumeCommand(mode.resumeCommand || '')
    setNewDefaultFlags(mode.defaultFlags || '')
    setNewDetectionEngine(mode.type || 'terminal')
    setNewPatternWorking(mode.patternWorking || '')
    setNewPatternError(mode.patternError || '')
    setShowAddForm(true)
  }

  const handleTest = async (id: string, command: string) => {
    if (!command) {
      toast.error('Enter a command to test')
      return
    }
    setTestingId(id)
    try {
      const res = await testMode(command)
      setTestResults((prev) => ({ ...prev, [id]: res }))
      if (res.ok) {
        toast.success(`Command "${command}" is valid`)
      } else {
        toast.error(`Command "${command}" failed: ${res.error}`)
      }
    } finally {
      setTestingId(null)
    }
  }

  const submitNewMode = () => {
    const generatedId = `${slugify(newModeLabel)}-${Math.random().toString(36).substring(2, 7)}`
    createMode({
      id: generatedId,
      label: newModeLabel,
      type: newDetectionEngine,
      initialCommand: newInitialCommand,
      resumeCommand: newResumeCommand || null,
      defaultFlags: newDefaultFlags || null,
      enabled: true,
      patternWorking: newPatternWorking || null,
      patternError: newPatternError || null
    })
      .then(() => {
        setNewModeLabel('')
        setNewInitialCommand('')
        setNewResumeCommand('')
        setNewDefaultFlags('')
        setNewDetectionEngine('terminal')
        setNewPatternWorking('')
        setNewPatternError('')
        setShowAddForm(false)
        toast.success(`Provider "${newModeLabel}" added`)
      })
      .catch((err) => {
        toast.error(err.message)
      })
  }

  return {
    testResults,
    setTestResults,
    testingId,
    showAddForm,
    setShowAddForm,
    newModeLabel,
    setNewModeLabel,
    newInitialCommand,
    setNewInitialCommand,
    newResumeCommand,
    setNewResumeCommand,
    newDefaultFlags,
    setNewDefaultFlags,
    newDetectionEngine,
    setNewDetectionEngine,
    newPatternWorking,
    setNewPatternWorking,
    newPatternError,
    setNewPatternError,
    duplicateMode,
    handleTest,
    submitNewMode
  }
}

export type AiProviderForm = ReturnType<typeof useAiProviderForm>
