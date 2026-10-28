import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Checkbox,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@slayzone/ui'
import type { ImportIssueSort } from './IntegrationsTab.types'
import type { IntegrationsTabModel } from './useIntegrationsTab'

export function IntegrationGithubImportSection({ vm }: { vm: IntegrationsTabModel }) {
  const {
    allVisibleGithubRepoIssuesSelected,
    canImportGithubRepoIssues,
    canLoadGithubRepoIssues,
    githubConnected,
    githubImportSort,
    githubRepoFilteredIssues,
    githubRepoImportMessage,
    githubRepoImportableIssues,
    githubRepoIssueQuery,
    githubRepoIssueQueryNormalized,
    githubRepoLinkedElsewhereCount,
    githubRepoLinkedInProjectCount,
    githubRepoSortedIssues,
    githubRepoVisibleImportableIssues,
    githubRepositories,
    githubRepositoryConnectionId,
    githubRepositoryFullName,
    handleImportGithubRepositoryIssues,
    handleLoadGithubRepositoryIssues,
    importingGithubRepoIssues,
    loadingGithubRepoIssues,
    loadingGithubRepositories,
    project,
    selectedGithubRepoImportableCount,
    selectedGithubRepoIssueIds,
    setConnectionModalState,
    setGithubImportSort,
    setGithubRepoIssueQuery,
    setGithubRepositoryFullName,
    setSelectedGithubRepoIssueIds,
    toggleGithubRepoIssue
  } = vm
  return (
    <Card className="gap-4 py-4" data-testid="github-repo-import-card">
      <CardHeader className="px-4">
        <CardTitle className="text-base">Import GitHub Repository Issues</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 px-4">
        {githubConnected ? (
          <>
            <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
              <Label htmlFor="github-repository" className="text-sm">
                Repository
              </Label>
              <Select
                value={githubRepositoryFullName || '__none__'}
                onValueChange={(value) =>
                  setGithubRepositoryFullName(value === '__none__' ? '' : value)
                }
                disabled={!githubRepositoryConnectionId || loadingGithubRepositories}
              >
                <SelectTrigger id="github-repository" className="w-full max-w-md">
                  <SelectValue
                    placeholder={
                      loadingGithubRepositories ? 'Loading repositories\u2026' : 'Choose repository'
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {githubRepositories.length === 0 ? (
                    <SelectItem value="__none__" disabled>
                      No repositories found
                    </SelectItem>
                  ) : null}
                  {githubRepositories.map((repository) => (
                    <SelectItem key={repository.id} value={repository.fullName}>
                      {repository.fullName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="space-y-0.5 text-xs text-muted-foreground">
                {loadingGithubRepoIssues
                  ? 'Loading repository issues\u2026'
                  : githubRepoSortedIssues.length > 0
                    ? githubRepoIssueQueryNormalized
                      ? `${githubRepoFilteredIssues.length} of ${githubRepoSortedIssues.length} issues shown`
                      : `${githubRepoSortedIssues.length} issues loaded`
                    : 'Load repository issues to import selected tasks'}
                {githubRepoSortedIssues.length > 0 ? (
                  <p>
                    {githubRepoImportableIssues.length} importable
                    {githubRepoLinkedInProjectCount > 0
                      ? ` \u2022 ${githubRepoLinkedInProjectCount} linked here`
                      : ''}
                    {githubRepoLinkedElsewhereCount > 0
                      ? ` \u2022 ${githubRepoLinkedElsewhereCount} linked elsewhere`
                      : ''}
                  </p>
                ) : null}
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="github-repo-load-issues"
                  disabled={!canLoadGithubRepoIssues || loadingGithubRepoIssues}
                  onClick={handleLoadGithubRepositoryIssues}
                >
                  {loadingGithubRepoIssues
                    ? 'Loading\u2026'
                    : githubRepoSortedIssues.length > 0
                      ? 'Refresh issues'
                      : 'Load issues'}
                </Button>
                {githubRepoVisibleImportableIssues.length > 0 ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      if (allVisibleGithubRepoIssuesSelected) {
                        setSelectedGithubRepoIssueIds((previous) => {
                          const next = new Set(previous)
                          for (const issue of githubRepoVisibleImportableIssues) {
                            next.delete(issue.id)
                          }
                          return next
                        })
                        return
                      }
                      setSelectedGithubRepoIssueIds((previous) => {
                        const next = new Set(previous)
                        for (const issue of githubRepoVisibleImportableIssues) {
                          next.add(issue.id)
                        }
                        return next
                      })
                    }}
                  >
                    {allVisibleGithubRepoIssuesSelected ? 'Clear visible' : 'Select visible'}
                  </Button>
                ) : null}
              </div>
            </div>

            <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
              <Label htmlFor="github-repo-issue-filter" className="text-sm">
                Filter issues
              </Label>
              <Input
                id="github-repo-issue-filter"
                value={githubRepoIssueQuery}
                onChange={(event) => setGithubRepoIssueQuery(event.target.value)}
                placeholder="Search by #number, title, or repository"
                className="w-full max-w-md"
              />
            </div>

            <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
              <Label htmlFor="github-repo-issue-sort" className="text-sm">
                Sort by
              </Label>
              <Select
                value={githubImportSort}
                onValueChange={(value) => setGithubImportSort(value as ImportIssueSort)}
              >
                <SelectTrigger id="github-repo-issue-sort" className="w-full max-w-md">
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

            <div className="min-h-40 rounded border p-2">
              {githubRepoFilteredIssues.length > 0 ? (
                <div className="max-h-44 space-y-1 overflow-y-auto">
                  {githubRepoFilteredIssues.map((issue) =>
                    issue.linkedTaskId ? (
                      <div
                        key={issue.id}
                        className="flex items-start gap-2 rounded px-1 py-0.5 text-xs opacity-60"
                      >
                        {issue.linkedProjectId === project.id ? (
                          <span className="mt-0.5 shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                            Linked
                          </span>
                        ) : (
                          <span className="mt-0.5 shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-300">
                            Linked elsewhere
                          </span>
                        )}
                        <span className="min-w-0">
                          <span className="font-medium">
                            {issue.repository.fullName}#{issue.number}
                          </span>
                          {' - '}
                          <span className="text-muted-foreground">{issue.title}</span>
                          {issue.linkedProjectId && issue.linkedProjectId !== project.id ? (
                            <span className="block text-[10px] text-muted-foreground">
                              {issue.linkedProjectName
                                ? `Already linked in ${issue.linkedProjectName}`
                                : 'Already linked in another project'}
                            </span>
                          ) : null}
                        </span>
                      </div>
                    ) : (
                      <label
                        key={issue.id}
                        className="flex cursor-pointer items-start gap-2 rounded px-1 py-0.5 text-xs hover:bg-muted/50"
                      >
                        <Checkbox
                          checked={selectedGithubRepoIssueIds.has(issue.id)}
                          onCheckedChange={(checked) =>
                            toggleGithubRepoIssue(issue.id, checked === true)
                          }
                        />
                        <span className="min-w-0">
                          <span className="font-medium">
                            {issue.repository.fullName}#{issue.number}
                          </span>
                          {' - '}
                          <span className="text-muted-foreground">{issue.title}</span>
                        </span>
                      </label>
                    )
                  )}
                </div>
              ) : (
                <div className="flex h-full min-h-36 items-center justify-center text-xs text-muted-foreground">
                  {githubRepoSortedIssues.length > 0
                    ? 'No issues match the current filter.'
                    : 'No loaded repository issues yet.'}
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">
                {selectedGithubRepoImportableCount > 0
                  ? `${selectedGithubRepoImportableCount} selected`
                  : githubRepoImportableIssues.length > 0
                    ? `${githubRepoImportableIssues.length} importable issues available`
                    : 'No importable issues in the loaded set'}
              </p>
              <Button
                size="sm"
                data-testid="github-repo-import-issues"
                disabled={!canImportGithubRepoIssues || importingGithubRepoIssues}
                onClick={handleImportGithubRepositoryIssues}
              >
                {importingGithubRepoIssues
                  ? 'Importing\u2026'
                  : selectedGithubRepoImportableCount > 0
                    ? `Import selected (${selectedGithubRepoImportableCount})`
                    : githubRepoSortedIssues.length > 0
                      ? `Import all importable (${githubRepoImportableIssues.length})`
                      : 'Import repository issues'}
              </Button>
            </div>

            {githubRepoImportMessage ? (
              <p className="text-xs text-muted-foreground">{githubRepoImportMessage}</p>
            ) : null}
          </>
        ) : (
          <div className="rounded-md border border-dashed p-3">
            <p className="text-sm text-muted-foreground">
              No GitHub connection is configured for this project. Connect one first.
            </p>
            <div className="mt-3 flex justify-end">
              <Button
                size="sm"
                variant="outline"
                onClick={() => setConnectionModalState({ provider: 'github', mode: 'connect' })}
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
