import { useEffect } from 'react'

/**
 * When a task tab re-asks its computer whether the project folder still exists
 * (`workspace.pathExists`).
 *
 * Every task tab stays mounted (hidden ones with `display: none`), and each used to
 * ask on every window focus — N open tabs = N requests per focus, the bursts of 300
 * per 10 s that helped stall the computer (FU5). The question matters only for what
 * the user SEES, so: the visible tab asks when it mounts, when its folder changes,
 * when it becomes visible, and on window focus; a hidden tab asks nothing until it is
 * shown. No folder: `onNoRoot`, nothing asked.
 */
export function useWorkspacePathProbe(
  projectRoot: string | null | undefined,
  active: boolean,
  probe: (path: string) => unknown,
  onNoRoot: () => void
): void {
  useEffect(() => {
    if (!projectRoot) {
      onNoRoot()
      return
    }
    if (active) void probe(projectRoot)
  }, [projectRoot, active, probe, onNoRoot])

  // Re-check on window focus — the directory may have moved while we were away.
  useEffect(() => {
    if (!projectRoot || !active) return
    const handleFocus = (): void => void probe(projectRoot)
    window.addEventListener('focus', handleFocus)
    return () => window.removeEventListener('focus', handleFocus)
  }, [projectRoot, active, probe])
}
