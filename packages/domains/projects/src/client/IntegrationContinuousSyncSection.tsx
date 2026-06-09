import { useMutation } from '@tanstack/react-query'
import { useTRPC } from '@slayzone/transport/client'
import { Check, ExternalLink as ExternalLinkIcon, Info, Loader2, Pencil } from 'lucide-react'
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Checkbox,
  cn,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from '@slayzone/ui'
import { resolveColumns } from '@slayzone/projects/shared'
import type { IntegrationSyncMode } from '@slayzone/integrations/shared'
import type { IntegrationsTabModel } from './useIntegrationsTab'

export function IntegrationContinuousSyncSection({ vm }: { vm: IntegrationsTabModel }) {
  const trpc = useTRPC()
  const openExternal = useMutation(trpc.app.shell.openExternal.mutationOptions())
  const {
    checkingSync,
    githubConnected,
    githubProjectConnectionId,
    githubRepositories,
    githubSyncMode,
    githubSyncProjectId,
    githubSyncProjects,
    githubSyncRepoFullName,
    handleCheckDiffs,
    handlePullRemoteAhead,
    handlePushLocalAhead,
    handleSyncStepCancelEdit,
    handleSyncStepEditSetup,
    handleSyncStepResyncStatuses,
    handleSyncStepSaveSetupEdit,
    handleSyncStepSetupContinue,
    linearConnected,
    linearProjectConnectionId,
    linearSyncAssignedToMe,
    linearSyncMode,
    linearSyncProjectId,
    linearSyncProjects,
    linearSyncTeamId,
    linearSyncTeams,
    loadingGithubRepositories,
    loadingGithubSyncProjects,
    loadingLinearSyncProjects,
    loadingLinearSyncTeams,
    loadingSyncStatuses,
    project,
    pullingSync,
    pushingSync,
    savingSyncProvider,
    setGithubSyncMode,
    setGithubSyncProjectId,
    setGithubSyncRepoFullName,
    setLinearSyncAssignedToMe,
    setLinearSyncMode,
    setLinearSyncProjectId,
    setLinearSyncTeamId,
    setSyncStep,
    setSyncStepEditing,
    syncAllStepsComplete,
    syncExternalUrl,
    syncExternalUrlLoading,
    syncMessage,
    syncSettingsMessage,
    syncStep,
    syncStep1Complete,
    syncSetupProvider,
    syncStep1Summary,
    syncStep2Complete,
    syncStepEditing,
    taskSyncSummary
  } = vm
  return (
    <div className="space-y-3">
      {/* Not connected */}
      {(syncSetupProvider === 'github' && !githubConnected) ||
      (syncSetupProvider === 'linear' && !linearConnected) ? (
        <Card className="gap-4 py-4">
          <CardHeader className="px-4">
            <CardTitle className="text-base">
              Connect {syncSetupProvider === 'github' ? 'GitHub' : 'Linear'}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 px-4">
            <p className="text-sm text-muted-foreground">
              Connect {syncSetupProvider === 'github' ? 'GitHub' : 'Linear'} from the category
              header to configure sync.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Step 1: Setup */}
          <Card className="gap-0 py-0 overflow-hidden">
            {(syncAllStepsComplete && syncStepEditing !== 1) ||
            (syncStep1Complete && syncStep > 1 && syncStepEditing !== 1) ? (
              <button
                type="button"
                className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-muted/30 transition-colors"
                onClick={handleSyncStepEditSetup}
              >
                <div className="flex items-center gap-2.5">
                  <div className="flex size-5 items-center justify-center rounded-full bg-emerald-500/20 text-emerald-400">
                    <Check className="size-3" />
                  </div>
                  <span className="text-sm font-medium">Setup</span>
                  <span className="text-xs text-muted-foreground">{syncStep1Summary}</span>
                </div>
                <Pencil className="size-3.5 text-muted-foreground" />
              </button>
            ) : (
              <>
                <div className="flex items-center justify-between px-4 pt-3 pb-4">
                  <div className="flex items-center gap-2.5">
                    <div
                      className={cn(
                        'flex size-5 items-center justify-center rounded-full text-[11px] font-bold',
                        syncStep === 1 || syncStepEditing === 1
                          ? 'bg-foreground text-background'
                          : 'bg-muted text-muted-foreground'
                      )}
                    >
                      1
                    </div>
                    <span className="text-sm font-medium">Setup</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {syncStepEditing === 1 ? (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7"
                          onClick={handleSyncStepCancelEdit}
                        >
                          Cancel
                        </Button>
                        <Button
                          size="sm"
                          className="h-7"
                          disabled={
                            (syncSetupProvider === 'github' && !githubSyncProjectId) ||
                            (syncSetupProvider === 'linear' && !linearSyncTeamId) ||
                            savingSyncProvider !== null
                          }
                          onClick={() => void handleSyncStepSaveSetupEdit()}
                        >
                          {savingSyncProvider ? (
                            <>
                              <Loader2 className="mr-1 size-3 animate-spin" />
                              Saving&hellip;
                            </>
                          ) : (
                            'Save'
                          )}
                        </Button>
                      </>
                    ) : (
                      <Button
                        size="sm"
                        className="h-7"
                        disabled={
                          (syncSetupProvider === 'github' && !githubSyncProjectId) ||
                          (syncSetupProvider === 'linear' && !linearSyncTeamId) ||
                          savingSyncProvider !== null ||
                          loadingSyncStatuses
                        }
                        onClick={() => void handleSyncStepSetupContinue()}
                      >
                        {savingSyncProvider || loadingSyncStatuses ? (
                          <>
                            <Loader2 className="mr-1 size-3 animate-spin" />
                            {loadingSyncStatuses ? 'Loading\u2026' : 'Saving\u2026'}
                          </>
                        ) : (
                          'Continue \u2192'
                        )}
                      </Button>
                    )}
                  </div>
                </div>
                <CardContent className="space-y-3 px-4 pb-4">
                  {syncSetupProvider === 'github' ? (
                    <>
                      <div className="grid grid-cols-[180px_minmax(0,1fr)] items-center gap-3">
                        <Label htmlFor="github-sync-project" className="text-sm">
                          GitHub Project
                        </Label>
                        <Select
                          value={githubSyncProjectId || '__none__'}
                          onValueChange={(value) =>
                            setGithubSyncProjectId(value === '__none__' ? '' : value)
                          }
                          disabled={!githubProjectConnectionId || loadingGithubSyncProjects}
                        >
                          <SelectTrigger id="github-sync-project" className="w-full">
                            <SelectValue
                              placeholder={
                                loadingGithubSyncProjects
                                  ? 'Loading projects\u2026'
                                  : 'Choose GitHub Project'
                              }
                            />
                          </SelectTrigger>
                          <SelectContent>
                            {githubSyncProjects.length === 0 ? (
                              <SelectItem value="__none__" disabled>
                                No GitHub Projects found
                              </SelectItem>
                            ) : null}
                            {githubSyncProjects.map((projectOption) => (
                              <SelectItem key={projectOption.id} value={projectOption.id}>
                                {projectOption.owner.login}#{projectOption.number} -{' '}
                                {projectOption.title}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="grid grid-cols-[180px_minmax(0,1fr)] items-center gap-3">
                        <Label htmlFor="github-sync-repo" className="text-sm">
                          Repository
                        </Label>
                        <Select
                          value={githubSyncRepoFullName || '__none__'}
                          onValueChange={(value) =>
                            setGithubSyncRepoFullName(value === '__none__' ? '' : value)
                          }
                          disabled={!githubProjectConnectionId || loadingGithubRepositories}
                        >
                          <SelectTrigger id="github-sync-repo" className="w-full">
                            <SelectValue
                              placeholder={
                                loadingGithubRepositories
                                  ? 'Loading repositories\u2026'
                                  : 'Choose repository'
                              }
                            />
                          </SelectTrigger>
                          <SelectContent>
                            {githubRepositories.length === 0 ? (
                              <SelectItem value="__none__" disabled>
                                No repositories found
                              </SelectItem>
                            ) : null}
                            {githubRepositories.map((repo) => (
                              <SelectItem key={repo.fullName} value={repo.fullName}>
                                {repo.fullName}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="grid grid-cols-[180px_minmax(0,1fr)] items-center gap-3">
                        <Label htmlFor="github-sync-mode" className="text-sm">
                          Sync mode
                        </Label>
                        <Select
                          value={githubSyncMode}
                          onValueChange={(value) => setGithubSyncMode(value as IntegrationSyncMode)}
                        >
                          <SelectTrigger id="github-sync-mode" className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="one_way">One-way</SelectItem>
                            <SelectItem value="two_way">Two-way</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="grid grid-cols-[180px_minmax(0,1fr)] items-center gap-3">
                        <Label htmlFor="linear-sync-team" className="text-sm">
                          Team
                        </Label>
                        <Select
                          value={linearSyncTeamId || '__none__'}
                          onValueChange={(value) =>
                            setLinearSyncTeamId(value === '__none__' ? '' : value)
                          }
                          disabled={!linearProjectConnectionId || loadingLinearSyncTeams}
                        >
                          <SelectTrigger id="linear-sync-team" className="w-full">
                            <SelectValue
                              placeholder={
                                loadingLinearSyncTeams ? 'Loading teams\u2026' : 'Choose team'
                              }
                            />
                          </SelectTrigger>
                          <SelectContent>
                            {linearSyncTeams.length === 0 ? (
                              <SelectItem value="__none__" disabled>
                                No teams found
                              </SelectItem>
                            ) : null}
                            {linearSyncTeams.map((team) => (
                              <SelectItem key={team.id} value={team.id}>
                                {team.key} - {team.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="grid grid-cols-[180px_minmax(0,1fr)] items-center gap-3">
                        <Label htmlFor="linear-sync-project" className="text-sm">
                          Project (optional)
                        </Label>
                        <Select
                          value={linearSyncProjectId || '__none__'}
                          onValueChange={(value) =>
                            setLinearSyncProjectId(value === '__none__' ? '' : value)
                          }
                          disabled={
                            !linearProjectConnectionId ||
                            !linearSyncTeamId ||
                            loadingLinearSyncProjects
                          }
                        >
                          <SelectTrigger id="linear-sync-project" className="w-full">
                            <SelectValue
                              placeholder={
                                loadingLinearSyncProjects
                                  ? 'Loading projects\u2026'
                                  : 'All team issues'
                              }
                            />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="__none__">All team issues</SelectItem>
                            {linearSyncProjects.map((projectOption) => (
                              <SelectItem key={projectOption.id} value={projectOption.id}>
                                {projectOption.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="grid grid-cols-[180px_minmax(0,1fr)] items-center gap-3">
                        <Label htmlFor="linear-sync-mode" className="text-sm">
                          Sync mode
                        </Label>
                        <Select
                          value={linearSyncMode}
                          onValueChange={(value) => setLinearSyncMode(value as IntegrationSyncMode)}
                        >
                          <SelectTrigger id="linear-sync-mode" className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="one_way">One-way</SelectItem>
                            <SelectItem value="two_way">Two-way</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="grid grid-cols-[180px_minmax(0,1fr)] items-center gap-3">
                        <div className="flex items-center gap-1.5">
                          <Label htmlFor="linear-sync-assigned" className="text-sm">
                            Assigned to me
                          </Label>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Info className="size-3.5 text-muted-foreground" />
                            </TooltipTrigger>
                            <TooltipContent>
                              Only discover issues assigned to the API key owner
                            </TooltipContent>
                          </Tooltip>
                        </div>
                        <Checkbox
                          id="linear-sync-assigned"
                          checked={linearSyncAssignedToMe}
                          onCheckedChange={(checked) => setLinearSyncAssignedToMe(checked === true)}
                        />
                      </div>
                    </>
                  )}
                  {syncSettingsMessage ? (
                    <p className="text-xs text-muted-foreground">{syncSettingsMessage}</p>
                  ) : null}
                </CardContent>
              </>
            )}
          </Card>

          {/* Step 2: Statuses (read-only) */}
          <Card className="gap-0 py-0 overflow-hidden">
            {syncStep2Complete && syncStep >= 3 && syncStepEditing !== 2 ? (
              <button
                type="button"
                className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-muted/30 transition-colors"
                onClick={() => {
                  setSyncStep(2)
                  setSyncStepEditing(2)
                }}
              >
                <div className="flex items-center gap-2.5">
                  <div className="flex size-5 items-center justify-center rounded-full bg-emerald-500/20 text-emerald-400">
                    <Check className="size-3" />
                  </div>
                  <span className="text-sm font-medium">Statuses</span>
                  <span className="text-xs text-muted-foreground">
                    {resolveColumns(project.columns_config).length} synced
                  </span>
                </div>
                <Pencil className="size-3.5 text-muted-foreground" />
              </button>
            ) : syncStep >= 2 || syncStepEditing === 2 ? (
              <>
                <div className="flex items-center justify-between px-4 pt-3 pb-4">
                  <div className="flex items-center gap-2.5">
                    <div
                      className={cn(
                        'flex size-5 items-center justify-center rounded-full text-[11px] font-bold',
                        syncStep === 2 || syncStepEditing === 2
                          ? 'bg-foreground text-background'
                          : 'bg-muted text-muted-foreground'
                      )}
                    >
                      2
                    </div>
                    <span className="text-sm font-medium">Statuses</span>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7"
                    disabled={loadingSyncStatuses}
                    onClick={() => void handleSyncStepResyncStatuses()}
                  >
                    {loadingSyncStatuses ? (
                      <>
                        <Loader2 className="mr-1 size-3 animate-spin" />
                        Checking&hellip;
                      </>
                    ) : (
                      'Resync'
                    )}
                  </Button>
                </div>
                <CardContent className="px-4 pb-4">
                  <div className="flex flex-wrap gap-1.5">
                    {resolveColumns(project.columns_config).map((col) => (
                      <span
                        key={col.id}
                        className="rounded bg-muted/60 px-2 py-0.5 text-xs text-foreground/80"
                      >
                        {col.label}
                      </span>
                    ))}
                  </div>
                </CardContent>
              </>
            ) : (
              <div className="flex items-center gap-2.5 px-4 py-3 opacity-50">
                <div className="flex size-5 items-center justify-center rounded-full bg-muted text-[11px] font-bold text-muted-foreground">
                  2
                </div>
                <span className="text-sm font-medium text-muted-foreground">Statuses</span>
              </div>
            )}
          </Card>

          {/* Step 3: Tasks */}
          <Card className="gap-0 py-0 overflow-hidden">
            {syncAllStepsComplete && syncStepEditing !== 3 && syncStep !== 3 ? (
              <button
                type="button"
                className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-muted/30 transition-colors"
                onClick={() => {
                  setSyncStep(3)
                  setSyncStepEditing(3)
                }}
              >
                <div className="flex items-center gap-2.5">
                  <div className="flex size-5 items-center justify-center rounded-full bg-emerald-500/20 text-emerald-400">
                    <Check className="size-3" />
                  </div>
                  <span className="text-sm font-medium">Tasks</span>
                  <span className="text-xs text-muted-foreground">
                    {taskSyncSummary.total || '0'} linked
                  </span>
                </div>
                <Pencil className="size-3.5 text-muted-foreground" />
              </button>
            ) : syncStep >= 3 ? (
              <>
                <div className="flex items-center justify-between px-4 pt-3 pb-4">
                  <div className="flex items-center gap-2.5">
                    <div
                      className={cn(
                        'flex size-5 items-center justify-center rounded-full text-[11px] font-bold',
                        syncStep === 3
                          ? 'bg-foreground text-background'
                          : 'bg-muted text-muted-foreground'
                      )}
                    >
                      3
                    </div>
                    <span className="text-sm font-medium">Tasks</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7"
                      data-testid="project-check-diffs"
                      disabled={checkingSync || pushingSync || pullingSync}
                      onClick={() => void handleCheckDiffs()}
                    >
                      {checkingSync ? (
                        <>
                          <Loader2 className="mr-1 size-3 animate-spin" />
                          Checking&hellip;
                        </>
                      ) : (
                        'Check diffs'
                      )}
                    </Button>
                    <Button
                      size="sm"
                      className="h-7"
                      data-testid="project-push-local-ahead"
                      disabled={checkingSync || pushingSync || pullingSync}
                      onClick={() => void handlePushLocalAhead()}
                    >
                      {pushingSync ? (
                        <>
                          <Loader2 className="mr-1 size-3 animate-spin" />
                          Pushing&hellip;
                        </>
                      ) : (
                        'Push \u2191'
                      )}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7"
                      data-testid="project-pull-remote-ahead"
                      disabled={checkingSync || pushingSync || pullingSync}
                      onClick={() => void handlePullRemoteAhead()}
                    >
                      {pullingSync ? (
                        <>
                          <Loader2 className="mr-1 size-3 animate-spin" />
                          Pulling&hellip;
                        </>
                      ) : (
                        'Pull \u2193'
                      )}
                    </Button>
                  </div>
                </div>
                <CardContent className="space-y-2 px-4 pb-4">
                  <div className="grid grid-cols-5 gap-2">
                    <div className="rounded-md border border-border/50 bg-muted/40 px-3 py-2 text-center">
                      <p className="text-xs text-muted-foreground">
                        In sync: {taskSyncSummary.in_sync}
                      </p>
                    </div>
                    <div className="rounded-md border border-border/50 bg-muted/40 px-3 py-2 text-center">
                      <p className="text-xs text-muted-foreground">
                        Local ahead: {taskSyncSummary.local_ahead}
                      </p>
                    </div>
                    <div className="rounded-md border border-border/50 bg-muted/40 px-3 py-2 text-center">
                      <p className="text-xs text-muted-foreground">
                        Remote ahead: {taskSyncSummary.remote_ahead}
                      </p>
                    </div>
                    <div className="rounded-md border border-border/50 bg-muted/40 px-3 py-2 text-center">
                      <p className="text-xs text-muted-foreground">
                        Conflicts: {taskSyncSummary.conflict}
                      </p>
                    </div>
                    <div className="rounded-md border border-border/50 bg-muted/40 px-3 py-2 text-center">
                      <p className="text-xs text-muted-foreground">
                        Unlinked: {taskSyncSummary.unlinked}
                      </p>
                    </div>
                  </div>

                  {syncMessage ? (
                    <p className="text-xs text-muted-foreground">{syncMessage}</p>
                  ) : null}
                </CardContent>
              </>
            ) : (
              <div className="flex items-center gap-2.5 px-4 py-3 opacity-50">
                <div className="flex size-5 items-center justify-center rounded-full bg-muted text-[11px] font-bold text-muted-foreground">
                  3
                </div>
                <span className="text-sm font-medium text-muted-foreground">Tasks</span>
              </div>
            )}
          </Card>

          {syncExternalUrlLoading ? (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              Loading...
            </div>
          ) : syncExternalUrl ? (
            <button
              type="button"
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
              onClick={() => openExternal.mutate({ url: syncExternalUrl })}
            >
              <ExternalLinkIcon className="size-3" />
              Open in {syncSetupProvider === 'linear' ? 'Linear' : 'GitHub'}
            </button>
          ) : null}
        </>
      )}
    </div>
  )
}
