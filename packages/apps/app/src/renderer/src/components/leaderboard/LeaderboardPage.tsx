import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, CheckCheck, Github, Lock, LogOut, RefreshCw, Sparkles } from 'lucide-react'
import { Button, IconButton, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@slayzone/ui'
import { useMutation, useQuery } from 'convex/react'
import { useLeaderboardAuth } from '@/lib/convexAuth'
import { track } from '@slayzone/telemetry/client'
import { api } from 'convex/_generated/api'

type Period = 'daily' | 'weekly' | 'monthly' | 'all-time'

interface ViewerProfile {
  image: string | null
  githubLogin: string | null
  githubNumericId?: string | null
}

const PERIODS: { value: Period; label: string }[] = [
  { value: 'daily', label: 'Today' },
  { value: 'weekly', label: 'Week' },
  { value: 'monthly', label: 'Month' },
  { value: 'all-time', label: 'All time' }
]

function formatTokens(value: number): string {
  return value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}M` : `${Math.round(value / 1_000)}k`
}

function initials(name: string): string {
  return name
    .split(' ')
    .map((part) => part[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase()
}

function parseGithubNumericIdFromAvatarUrl(image: string | null | undefined): string | null {
  if (!image) return null
  try {
    const parsed = new URL(image)
    const match = parsed.pathname.match(/^\/u\/(\d+)(?:\/|$)/)
    return match?.[1] ?? null
  } catch {
    return null
  }
}

function getGithubNumericId(viewer: ViewerProfile | null): string | null {
  if (!viewer) return null
  return viewer.githubNumericId ?? parseGithubNumericIdFromAvatarUrl(viewer.image)
}

function getAvatarSrc(viewer: ViewerProfile | null): string | null {
  if (!viewer) return null
  if (viewer.image) return viewer.image
  if (viewer.githubLogin) return `https://github.com/${viewer.githubLogin}.png?size=96`
  const numericId = getGithubNumericId(viewer)
  if (numericId) return `https://avatars.githubusercontent.com/u/${numericId}?v=4`
  return null
}

function getGithubProfileUrl(viewer: ViewerProfile | null): string | null {
  if (!viewer) return null
  if (viewer.githubLogin) return `https://github.com/${viewer.githubLogin}`
  const numericId = getGithubNumericId(viewer)
  if (numericId) return `https://github.com/u/${numericId}`
  return null
}

function hasResolvedGithubIdentity(viewer: ViewerProfile | null): boolean {
  if (!viewer) return false
  return Boolean(viewer.githubLogin && viewer.image && getGithubProfileUrl(viewer))
}

export function LeaderboardPage(): React.JSX.Element {
  const tracked = useRef(false)
  useEffect(() => { if (!tracked.current) { tracked.current = true; track('leaderboard_viewed') } }, [])
  const auth = useLeaderboardAuth()
  if (!auth.configured) {
    return (
      <div className="h-full overflow-hidden flex items-center justify-center text-sm text-muted-foreground">
        Leaderboard unavailable (Convex not configured)
      </div>
    )
  }
  return <LeaderboardPageInner auth={auth} />
}

function LeaderboardPageInner({ auth }: { auth: ReturnType<typeof useLeaderboardAuth> }): React.JSX.Element {
  const [period, setPeriod] = useState<Period>('all-time')
  const [authBusy, setAuthBusy] = useState(false)

  const [resolvedGithubLogin, setResolvedGithubLogin] = useState<string | null>(null)
  const [resolvedGithubAvatar, setResolvedGithubAvatar] = useState<string | null>(null)
  const [resolvedGithubUrl, setResolvedGithubUrl] = useState<string | null>(null)
  const [devProtocolBanner, setDevProtocolBanner] = useState<string | null>(null)
  const syncViewerProfile = useMutation(api.leaderboard.syncViewerProfile)
  const forgetMeMutation = useMutation(api.leaderboard.forgetMe)
  const myTotals = useQuery(api.leaderboard.getMyTotals, auth.isAuthenticated ? {} : 'skip')
  const topTokens = useQuery(api.leaderboard.topByTotalTokens, auth.configured ? { period, limit: 25 } : 'skip')
  const topTasks = useQuery(api.leaderboard.topByCompletedTasks, auth.configured ? { period, limit: 25 } : 'skip')

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
        const data = (await res.json()) as { login?: string; avatar_url?: string; html_url?: string }
        if (cancelled) return
        if (data.login) setResolvedGithubLogin(data.login)
        if (data.avatar_url) setResolvedGithubAvatar(data.avatar_url)
        if (data.html_url) setResolvedGithubUrl(data.html_url)
      } catch {
        // ignore
      }
    }
    void resolveGithubProfile()
    return () => { cancelled = true }
  }, [viewer, auth.isAuthenticated])

  useEffect(() => {
    if (!import.meta.env.DEV) return
    let cancelled = false
    void window.api.app
      .getProtocolClientStatus()
      .then((status) => {
        if (cancelled) return
        if (status.reason === 'dev-skipped') {
          setDevProtocolBanner(
            'OAuth deep-link callbacks are disabled in dev by default. Use `SLAYZONE_REGISTER_DEV_PROTOCOL=1 pnpm dev` when testing leaderboard sign-in.'
          )
          return
        }
        if (status.reason === 'registration-failed') {
          setDevProtocolBanner(`OAuth deep-link callback handler registration failed for ${status.scheme}://.`)
          return
        }
        setDevProtocolBanner(null)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

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

  return (
    <div className="h-full overflow-hidden bg-[radial-gradient(1200px_400px_at_20%_-10%,color-mix(in_oklab,var(--primary)_12%,transparent),transparent_65%)]">
      <div className="mx-auto w-full h-full max-w-[1440px] p-6 flex flex-col gap-5">
        <section className="rounded-xl border bg-background/85 backdrop-blur-sm p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="text-3xl font-semibold tracking-tight">Leaderboard</h1>
              <p className="text-sm text-muted-foreground mt-2">
                See who&rsquo;s slaying total tokens and completed tasks.
              </p>
            </div>
            <div className="flex flex-col items-end gap-2">
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-1 rounded-lg bg-muted/50 p-1">
                  {PERIODS.map(({ value, label }) => (
                    <Button
                      key={value}
                      size="sm"
                      variant={period === value ? 'default' : 'ghost'}
                      onClick={() => setPeriod(value)}
                    >
                      {label}
                    </Button>
                  ))}
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <IconButton
                      aria-label="Account menu"
                      variant="outline"
                      disabled={authBusy || auth.isLoading}
                      className="h-9 w-9 rounded-full p-0 overflow-hidden"
                      title="Account"
                    >
                      {authBusy || auth.isLoading ? (
                        <span className="text-[11px] font-medium">...</span>
                      ) : auth.isAuthenticated && avatarSrc ? (
                        <img src={avatarSrc} alt={viewerName} className="h-full w-full object-cover" />
                      ) : (
                        <span className="text-[11px] font-semibold uppercase">{avatarFallback}</span>
                      )}
                    </IconButton>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-56">
                    <DropdownMenuLabel className="flex flex-col gap-0.5">
                      <span>{canParticipate ? viewerName : 'Guest'}</span>
                      <span className="text-xs font-normal text-muted-foreground">
                        {canParticipate ? 'Participating in leaderboard' : 'Sign in to participate'}
                      </span>
                    </DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    {!auth.configured ? (
                      <DropdownMenuItem disabled>Convex auth disabled</DropdownMenuItem>
                    ) : auth.isAuthenticated ? (
                      <>
                        <DropdownMenuItem
                          disabled={!githubProfileUrl}
                          onClick={() => {
                            if (!githubProfileUrl) return
                            void window.api.shell.openExternal(githubProfileUrl)
                          }}
                        >
                          <Github className="size-4" />
                          Open GitHub profile
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => void syncViewerProfile({})}>
                          <RefreshCw className="size-4" />
                          Refresh profile
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem variant="destructive" onClick={() => void runAuthAction('signout')}>
                          <LogOut className="size-4" />
                          Sign out
                        </DropdownMenuItem>
                        <DropdownMenuItem variant="destructive" onClick={() => void runAuthAction('forget')}>
                          <Lock className="size-4" />
                          Forget me
                        </DropdownMenuItem>
                      </>
                    ) : (
                      <>
                        <DropdownMenuItem onClick={() => void runAuthAction('signin')}>
                          <Github className="size-4" />
                          Sign in with GitHub
                        </DropdownMenuItem>
                        <DropdownMenuItem disabled>
                          <Lock className="size-4" />
                          Login required to submit stats
                        </DropdownMenuItem>
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          </div>
          {devProtocolBanner && (
            <div className="mt-4 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{devProtocolBanner}</span>
                </div>
                <button
                  className="shrink-0 text-amber-100/80 hover:text-amber-100"
                  onClick={() => setDevProtocolBanner(null)}
                >
                  Dismiss
                </button>
              </div>
            </div>
          )}
          {!canParticipate && (
            <div className="mt-4 rounded-lg border border-primary/30 bg-primary/10 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold flex items-center gap-2">
                    <Lock className="size-4" />
                    Sign in with GitHub to join the leaderboard
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    You can browse the rankings now, but your tokens and completed tasks only count after sign-in.
                  </p>
                </div>
                {auth.configured ? (
                  <Button
                    size="sm"
                    disabled={authBusy || auth.isLoading}
                    onClick={() => void runAuthAction('signin')}
                    className="shrink-0"
                  >
                    {authBusy || auth.isLoading ? 'Connecting...' : 'Sign in with GitHub'}
                  </Button>
                ) : (
                  <span className="text-xs text-muted-foreground">Auth unavailable in this environment</span>
                )}
              </div>
            </div>
          )}
          {auth.lastError && <p className="text-xs text-destructive mt-2">Auth error: {auth.lastError}</p>}
        </section>

        <section className={`grid grid-cols-1 md:grid-cols-2 gap-4 flex-1 min-h-0 ${canParticipate ? '' : 'opacity-80'}`}>
          <LeaderboardTable
            icon={<Sparkles className="size-4" />}
            title="Most AI Tokens Used"
            rows={topTokens?.entries.map((r) => ({
              key: r.userId,
              name: r.displayName,
              image: r.image,
              value: formatTokens(r.totalTokens)
            }))}
            viewerRow={topTokens?.viewer ? {
              key: topTokens.viewer.userId,
              name: topTokens.viewer.displayName,
              image: topTokens.viewer.image,
              value: formatTokens(topTokens.viewer.totalTokens),
              rank: topTokens.viewer.rank
            } : null}
          />
          <LeaderboardTable
            icon={<CheckCheck className="size-4" />}
            title="Most Completed Tasks"
            rows={topTasks?.entries.map((r) => ({
              key: r.userId,
              name: r.displayName,
              image: r.image,
              value: String(r.totalCompletedTasks)
            }))}
            viewerRow={topTasks?.viewer ? {
              key: topTasks.viewer.userId,
              name: topTasks.viewer.displayName,
              image: topTasks.viewer.image,
              value: String(topTasks.viewer.totalCompletedTasks),
              rank: topTasks.viewer.rank
            } : null}
          />
        </section>
      </div>
    </div>
  )
}

interface TableRow {
  key: string
  name: string
  image: string | null
  value: string
  rank?: number
}

function LeaderboardTable({
  icon,
  title,
  rows,
  viewerRow
}: {
  icon: React.JSX.Element
  title: string
  rows: TableRow[] | undefined
  viewerRow: TableRow | null | undefined
}): React.JSX.Element {
  return (
    <div className="rounded-xl border bg-background overflow-hidden min-w-0 h-full flex flex-col">
      <div className="px-4 py-3 border-b bg-muted/20">
        <div className="flex items-center gap-3 h-12">
          <span className="text-muted-foreground">{icon}</span>
          <h2 className="text-sm font-semibold leading-tight overflow-hidden">{title}</h2>
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        {rows === undefined ? (
          <div className="flex items-center justify-center h-full text-sm text-muted-foreground">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="flex items-center justify-center h-full text-sm text-muted-foreground">No data yet</div>
        ) : (
          <>
            {rows.map((row, index) => (
              <LeaderboardRow key={row.key} row={row} rank={index + 1} />
            ))}
            {viewerRow && (
              <>
                <div className="flex items-center justify-center gap-2 py-1 text-xs text-muted-foreground/50">
                  <span>·····</span>
                </div>
                <LeaderboardRow row={viewerRow} rank={viewerRow.rank!} isViewer />
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function LeaderboardRow({ row, rank, isViewer = false }: { row: TableRow; rank: number; isViewer?: boolean }): React.JSX.Element {
  return (
    <div className={`flex items-center gap-3 px-3 py-3 border-b last:border-b-0 hover:bg-muted/30 transition-colors ${isViewer ? 'bg-primary/5' : ''}`}>
      <span className="inline-flex w-8 text-xs font-medium tabular-nums text-muted-foreground/70">#{rank}</span>
      {row.image ? (
        <img src={row.image} alt={row.name} className="h-8 w-8 rounded-full object-cover" />
      ) : (
        <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-muted text-[11px] font-medium">
          {initials(row.name)}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{row.name}</p>
      </div>
      <div className="text-right">
        <p className="text-sm font-semibold tabular-nums">{row.value}</p>
      </div>
    </div>
  )
}
