import type { StartupProgress } from './types'

export interface StartupProgressText {
  /** "Starting up", or "Ready" once nothing is left. */
  title: string
  /** What is still left, per stage ("25 pages · 1 chat left"); "Nothing left" once settled. */
  left: string
  /** Done ÷ (done + left) over every stage, so it is never 100 while anything is left. */
  percent: number
  /** Full per-stage detail, for the tooltip. */
  details: string[]
}

const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`

/**
 * The startup card's words and bar, from its counts. Finished stages drop out of
 * `left`, in a fixed order (pages, agents, terminals, chats), so the line shrinks as
 * the workspace comes up and always names what the card is still waiting for.
 */
export function describeStartupProgress(p: StartupProgress): StartupProgressText {
  const pagesLeft = Math.max(0, p.pagesTotal - p.pagesLoaded)
  const agentsLeft = Math.max(0, p.agentsTotal - p.agentsReady)
  const parts = [
    pagesLeft > 0 ? count(pagesLeft, 'page') : null,
    agentsLeft > 0 ? count(agentsLeft, 'agent') : null,
    p.terminalsQueued > 0 ? count(p.terminalsQueued, 'terminal') : null,
    p.chatsLoading > 0 ? count(p.chatsLoading, 'chat') : null
  ].filter((s): s is string => s !== null)

  const done = p.pagesLoaded + p.agentsReady
  const remaining = pagesLeft + agentsLeft + p.terminalsQueued + p.chatsLoading
  const percent = p.settled
    ? 100
    : remaining === 0
      ? done > 0
        ? 100
        : 0
      : Math.floor((done / (done + remaining)) * 100)

  const agentDetail = [
    p.agentsBooting > 0 ? `${p.agentsBooting} booting` : null,
    p.agentsQueued > 0 ? `${p.agentsQueued} queued` : null
  ].filter((s): s is string => s !== null)
  const details = [
    p.agentsTotal > 0
      ? [`Agents ${p.agentsReady}/${p.agentsTotal}`, ...agentDetail].join(' · ')
      : null,
    p.pagesTotal > 0 ? `Pages ${p.pagesLoaded}/${p.pagesTotal}` : null,
    p.terminalsQueued > 0 ? `Terminals ${p.terminalsQueued} waiting` : null,
    p.chatsLoading > 0 ? `Chats ${p.chatsLoading} loading` : null
  ].filter((s): s is string => s !== null)

  return {
    title: p.settled ? 'Ready' : 'Starting up',
    left: p.settled || parts.length === 0 ? 'Nothing left' : `${parts.join(' · ')} left`,
    percent,
    details
  }
}
