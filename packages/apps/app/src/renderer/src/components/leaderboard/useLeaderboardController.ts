import { useEffect, useState } from 'react'
import { useMutation, useQuery } from 'convex/react'
import { useTRPCClient } from '@slayzone/transport/client'
import { useLeaderboardAuth } from '@/lib/convexAuth'
import { api } from 'convex/_generated/api'
import type { Period } from './LeaderboardPage.constants'
import {
  getAvatarSrc,
  getGithubNumericId,
  getGithubProfileUrl,
  hasResolvedGithubIdentity,
  initials
} from './LeaderboardPage.utils'

export function useLeaderboardController(auth: ReturnType<typeof useLeaderboardAuth>) {
  const trpcClient = useTRPCClient()
  const [period, setPeriod] = useState<Period>('all-time')
  const [authBusy, setAuthBusy] = useState(false)

  const [resolvedGithubLogin, setResolvedGithubLogin] = useState<string | null>(null)
  const [resolvedGithubAvatar, setResolvedGithubAvatar] = useState<string | null>(null)
  const [resolvedGithubUrl, setResolvedGithubUrl] = useState<string | null>(null)
  const [devProtocolBanner, setDevProtocolBanner] = useState<string | null>(null)
  const syncViewerProfile = useMutation(api.leaderboard.syncViewerProfile)
  const syncDailyStats = useMutation(api.leaderboard.syncDailyStats)
  const forgetMeMutation = useMutation(api.leaderboard.forgetMe)
  const [syncing, setSyncing] = useState(false)
  const myTotals = useQuery(api.leaderboard.getMyTotals, auth.isAuthenticated ? {} : 'skip')
  const topTokens = useQuery(
    api.leaderboard.topByTotalTokens,
    auth.configured ? { period, limit: 25 } : 'skip'
  )
  const topTasks = useQuery(
    api.leaderboard.topByCompletedTasks,
    auth.configured ? { period, limit: 25 } : 'skip'
  )

  const viewer = myTotals?.user ?? null
  const resolvedViewer = viewer
    ? {
        ...viewer,
        githubLogin: viewer.githubLogin ?? resolvedGithubLogin,
        image: viewer.image ?? resolvedGithubAvatar
      }
    : null
  const viewerName = resolvedViewer?.githubLogin ?? resolvedViewer?.name ?? 'GitHub'
  const avatarFallback = initials(viewerName || 'GH')
  const avatarSrc = getAvatarSrc(resolvedViewer)
  const githubProfileUrl = getGithubProfileUrl(resolvedViewer) ?? resolvedGithubUrl
  const canParticipate = auth.configured && auth.isAuthenticated

  useEffect(() => {
    if (!auth.isAuthenticated) return
    void syncViewerProfile({}).catch(() => {})
  }, [auth.isAuthenticated, syncViewerProfile])

  useEffect(() => {
    if (auth.isAuthenticated && viewer) return
    setResolvedGithubLogin(null)
    setResolvedGithubAvatar(null)
    setResolvedGithubUrl(null)
  }, [auth.isAuthenticated, viewer])

  useEffect(() => {
    let cancelled = false
    async function resolveGithubProfile(): Promise<void> {
      if (!viewer || !auth.isAuthenticated) return
      if (hasResolvedGithubIdentity(viewer)) return
      const numericId = getGithubNumericId(viewer)
      if (!numericId) return
      try {
        const res = await fetch(`https://api.github.com/user/${numericId}`)
        if (!res.ok) return
        const data = (await res.json()) as {
          login?: string
          avatar_url?: string
          html_url?: string
        }
        if (cancelled) return
        if (data.login) setResolvedGithubLogin(data.login)
        if (data.avatar_url) setResolvedGithubAvatar(data.avatar_url)
        if (data.html_url) setResolvedGithubUrl(data.html_url)
      } catch {
        // ignore
      }
    }
    void resolveGithubProfile()
    return () => {
      cancelled = true
    }
  }, [viewer, auth.isAuthenticated])

  useEffect(() => {
    if (!import.meta.env.DEV) return
    let cancelled = false
    void trpcClient.app.meta.getProtocolClientStatus
      .query()
      .then((status) => {
        if (cancelled) return
        if (status.reason === 'dev-skipped') {
          setDevProtocolBanner(
            'OAuth deep-link callbacks are disabled in dev by default. Use `SLAYZONE_REGISTER_DEV_PROTOCOL=1 pnpm dev` when testing leaderboard sign-in.'
          )
          return
        }
        if (status.reason === 'registration-failed') {
          setDevProtocolBanner(
            `OAuth deep-link callback handler registration failed for ${status.scheme}://.`
          )
          return
        }
        setDevProtocolBanner(null)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [trpcClient])

  async function syncStats(): Promise<void> {
    setSyncing(true)
    try {
      const stats = await trpcClient.app.leaderboard.getLocalStats.query()
      if (stats?.days.length) await syncDailyStats({ days: stats.days })
    } catch {
      /* best-effort */
    } finally {
      setSyncing(false)
    }
  }

  async function runAuthAction(type: 'signin' | 'signout' | 'forget'): Promise<void> {
    setAuthBusy(true)
    try {
      if (type === 'signout') {
        await auth.signOut()
      } else if (type === 'forget') {
        await forgetMeMutation({})
        await auth.forgetMe()
      } else {
        await auth.signInWithGitHub()
      }
    } finally {
      setAuthBusy(false)
    }
  }

  return {
    period,
    setPeriod,
    canParticipate,
    syncing,
    syncStats,
    authBusy,
    runAuthAction,
    avatarSrc,
    viewerName,
    avatarFallback,
    githubProfileUrl,
    syncViewerProfile,
    devProtocolBanner,
    setDevProtocolBanner,
    topTokens,
    topTasks
  }
}
