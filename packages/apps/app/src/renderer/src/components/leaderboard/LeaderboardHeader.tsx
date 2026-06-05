import { AlertTriangle, Github, Lock, LogOut, RefreshCw } from 'lucide-react'
import {
  Button,
  IconButton,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@slayzone/ui'
import type { useLeaderboardAuth } from '@/lib/convexAuth'
import { PERIODS } from './LeaderboardPage.constants'
import type { useLeaderboardController } from './useLeaderboardController'

export function LeaderboardHeader({
  auth,
  ctl
}: {
  auth: ReturnType<typeof useLeaderboardAuth>
  ctl: ReturnType<typeof useLeaderboardController>
}): React.JSX.Element {
  const {
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
    setDevProtocolBanner
  } = ctl

  return (
    <section className="rounded-xl border bg-surface-1/85 backdrop-blur-sm p-5">
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
            {canParticipate && (
              <IconButton
                aria-label="Sync stats"
                variant="outline"
                disabled={syncing}
                onClick={() => void syncStats()}
                title="Sync stats now"
              >
                <RefreshCw className={`size-4 ${syncing ? 'animate-spin' : ''}`} />
              </IconButton>
            )}
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
                    <img
                      src={avatarSrc}
                      alt={viewerName}
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <span className="text-[11px] font-semibold uppercase">
                      {avatarFallback}
                    </span>
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
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={() => void runAuthAction('signout')}
                    >
                      <LogOut className="size-4" />
                      Sign out
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={() => void runAuthAction('forget')}
                    >
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
                You can browse the rankings now, but your tokens and completed tasks only count
                after sign-in.
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
              <span className="text-xs text-muted-foreground">
                Auth unavailable in this environment
              </span>
            )}
          </div>
        </div>
      )}
      {auth.lastError && (
        <p className="text-xs text-destructive mt-2">Auth error: {auth.lastError}</p>
      )}
    </section>
  )
}
