import { Info } from 'lucide-react'
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Checkbox,
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
import type { ImportIssueSort } from './IntegrationsTab.types'
import type { IntegrationsTabModel } from './useIntegrationsTab'

export function IntegrationLinearImportSection({ vm }: { vm: IntegrationsTabModel }) {
  const {
    allVisibleIssuesSelected,
    canImportIssues,
    canLoadIssues,
    handleImportIssues,
    handleLoadIssues,
    importMessage,
    importableIssues,
    importing,
    linearAssignedToMe,
    linearConnected,
    linearImportProjectId,
    linearImportProjects,
    linearImportSort,
    linearImportSourceMessage,
    linearImportTeamId,
    linearImportTeams,
    linearProjectConnectionId,
    loadingIssues,
    loadingLinearImportProjects,
    loadingLinearImportTeams,
    selectedIssueIds,
    setConnectionModalState,
    setLinearAssignedToMe,
    setLinearImportProjectId,
    setLinearImportSort,
    setLinearImportTeamId,
    setSelectedIssueIds,
    sortedLinearIssueOptions,
    toggleIssue
  } = vm
  return (
    <Card className="gap-4 py-4">
      <CardHeader className="px-4">
        <CardTitle className="text-base">Import Issues</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 px-4">
        {linearConnected ? (
          <>
            <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
              <Label htmlFor="linear-import-team" className="text-sm">
                Team
              </Label>
              <Select
                value={linearImportTeamId || '__none__'}
                onValueChange={(value) => setLinearImportTeamId(value === '__none__' ? '' : value)}
                disabled={!linearProjectConnectionId || loadingLinearImportTeams}
              >
                <SelectTrigger id="linear-import-team" className="w-full max-w-md">
                  <SelectValue
                    placeholder={loadingLinearImportTeams ? 'Loading teams\u2026' : 'Choose team'}
                  />
                </SelectTrigger>
                <SelectContent>
                  {linearImportTeams.length === 0 ? (
                    <SelectItem value="__none__" disabled>
                      No teams found
                    </SelectItem>
                  ) : null}
                  {linearImportTeams.map((team) => (
                    <SelectItem key={team.id} value={team.id}>
                      {team.key} - {team.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
              <Label htmlFor="linear-import-project" className="text-sm">
                Project (optional)
              </Label>
              <Select
                value={linearImportProjectId || '__none__'}
                onValueChange={(value) =>
                  setLinearImportProjectId(value === '__none__' ? '' : value)
                }
                disabled={
                  !linearProjectConnectionId || !linearImportTeamId || loadingLinearImportProjects
                }
              >
                <SelectTrigger id="linear-import-project" className="w-full max-w-md">
                  <SelectValue
                    placeholder={
                      loadingLinearImportProjects ? 'Loading projects\u2026' : 'All team issues'
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">All team issues</SelectItem>
                  {linearImportProjects.map((projectOption) => (
                    <SelectItem key={projectOption.id} value={projectOption.id}>
                      {projectOption.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {linearImportSourceMessage ? (
              <p className="text-xs text-muted-foreground">{linearImportSourceMessage}</p>
            ) : null}

            <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
              <Label htmlFor="linear-import-sort" className="text-sm">
                Sort by
              </Label>
              <Select
                value={linearImportSort}
                onValueChange={(value) => setLinearImportSort(value as ImportIssueSort)}
              >
                <SelectTrigger id="linear-import-sort" className="w-full max-w-md">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="updated_desc">Recently updated</SelectItem>
                  <SelectItem value="updated_asc">Least recently updated</SelectItem>
                  <SelectItem value="title_asc">Title A-Z</SelectItem>
                  <SelectItem value="title_desc">Title Z-A</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
              <div className="flex items-center gap-1.5">
                <Label htmlFor="linear-import-assigned" className="text-sm">
                  Assigned to me
                </Label>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Info className="size-3.5 text-muted-foreground" />
                  </TooltipTrigger>
                  <TooltipContent>Only show issues assigned to the API key owner</TooltipContent>
                </Tooltip>
              </div>
              <Checkbox
                id="linear-import-assigned"
                checked={linearAssignedToMe}
                onCheckedChange={(checked) => setLinearAssignedToMe(checked === true)}
              />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-xs text-muted-foreground">
                {loadingIssues
                  ? 'Loading issues\u2026'
                  : sortedLinearIssueOptions.length > 0
                    ? `${sortedLinearIssueOptions.length} issues loaded`
                    : 'Load issues from Linear to import specific tasks'}
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!canLoadIssues || loadingIssues}
                  onClick={handleLoadIssues}
                >
                  {loadingIssues ? 'Loading\u2026' : 'Load issues'}
                </Button>
                {importableIssues.length > 0 ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      if (allVisibleIssuesSelected) {
                        setSelectedIssueIds(new Set())
                        return
                      }
                      setSelectedIssueIds(new Set(importableIssues.map((i) => i.id)))
                    }}
                  >
                    {allVisibleIssuesSelected ? 'Clear selection' : 'Select all'}
                  </Button>
                ) : null}
              </div>
            </div>

            <div className="min-h-40 rounded border p-2">
              {sortedLinearIssueOptions.length > 0 ? (
                <div className="max-h-44 space-y-1 overflow-y-auto">
                  {sortedLinearIssueOptions.map((issue) =>
                    issue.linkedTaskId ? (
                      <div
                        key={issue.id}
                        className="flex items-start gap-2 rounded px-1 py-0.5 text-xs opacity-60"
                      >
                        <span className="mt-0.5 shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                          Linked
                        </span>
                        <span className="min-w-0">
                          <span className="font-medium">{issue.identifier}</span>
                          {' - '}
                          <span className="text-muted-foreground">{issue.title}</span>
                        </span>
                      </div>
                    ) : (
                      <label
                        key={issue.id}
                        className="flex cursor-pointer items-start gap-2 rounded px-1 py-0.5 text-xs hover:bg-muted/50"
                      >
                        <Checkbox
                          checked={selectedIssueIds.has(issue.id)}
                          onCheckedChange={(checked) => toggleIssue(issue.id, checked === true)}
                        />
                        <span className="min-w-0">
                          <span className="font-medium">{issue.identifier}</span>
                          {' - '}
                          <span className="text-muted-foreground">{issue.title}</span>
                        </span>
                      </label>
                    )
                  )}
                </div>
              ) : (
                <div className="flex h-full min-h-36 items-center justify-center text-xs text-muted-foreground">
                  No loaded issues yet.
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">
                {selectedIssueIds.size > 0
                  ? `${selectedIssueIds.size} selected`
                  : 'No specific issues selected'}
              </p>
              <Button
                size="sm"
                disabled={!canImportIssues || importing}
                onClick={handleImportIssues}
              >
                {importing
                  ? 'Importing\u2026'
                  : selectedIssueIds.size > 0
                    ? `Import selected (${selectedIssueIds.size})`
                    : sortedLinearIssueOptions.length > 0
                      ? 'Import all loaded'
                      : 'Import from Linear'}
              </Button>
            </div>

            {importMessage ? (
              <p className="text-xs text-muted-foreground">{importMessage}</p>
            ) : null}
          </>
        ) : (
          <div className="rounded-md border border-dashed p-3">
            <p className="text-sm text-muted-foreground">
              No Linear connection is configured for this project. Connect one first.
            </p>
            <div className="mt-3 flex justify-end">
              <Button
                size="sm"
                variant="outline"
                onClick={() => setConnectionModalState({ provider: 'linear', mode: 'connect' })}
              >
                Open connection settings
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
