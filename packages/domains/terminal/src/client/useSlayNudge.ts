import { useState, useEffect, useCallback } from 'react'

interface UseSlayNudgeOptions {
  projectId: string | null
  projectPath: string | null
}

export function useSlayNudge({ projectId, projectPath }: UseSlayNudgeOptions) {
  const [dismissed, setDismissed] = useState(true)
  const [slayConfigured, setSlayConfigured] = useState(true)

  useEffect(() => {
    if (!projectId) return
    window.api.settings.get(`slay_nudge_dismissed:${projectId}`).then((val) => {
      setDismissed(val === '1')
    })
  }, [projectId])

  useEffect(() => {
    if (!projectPath || dismissed) return
    window.api.aiConfig.checkSlayConfigured(projectPath).then((configured) => {
      setSlayConfigured(configured)
    })
  }, [projectPath, dismissed])

  const dismiss = () => {
    if (!projectId) return
    setDismissed(true)
    window.api.settings.set(`slay_nudge_dismissed:${projectId}`, '1')
  }

  const recheck = useCallback(() => {
    if (!projectPath) return
    window.api.aiConfig.checkSlayConfigured(projectPath).then((configured) => {
      setSlayConfigured(configured)
      if (configured) setDismissed(true)
    })
  }, [projectPath])

  return {
    showBanner: !dismissed && !slayConfigured,
    dismiss,
    recheck,
  }
}
