import { useMemo } from 'react'
import { useHubFeeds } from '../hub-connections'
import { type HubProjects, mergeHubProjects } from './hub-projects'

/**
 * Every signed-in hub's projects, grouped by hub, live (they come with each hub's board,
 * which reloads whenever the hub says something changed). What a screen that switches
 * project — the board's project picker — reads.
 */
export function useHubProjects(): HubProjects[] {
  const { feeds } = useHubFeeds()
  return useMemo(() => mergeHubProjects(feeds), [feeds])
}
