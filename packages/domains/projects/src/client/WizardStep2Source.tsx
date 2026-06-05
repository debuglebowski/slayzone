import { Info } from 'lucide-react'
import { Checkbox, Label } from '@slayzone/ui'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@slayzone/ui'
import { Tooltip, TooltipContent, TooltipTrigger } from '@slayzone/ui'
import type { WizardState } from './useProjectIntegrationSetupWizard'

type WizardStep2SourceProps = Pick<
  WizardState,
  | 'provider'
  | 'connectionId'
  | 'loadingTeams'
  | 'teams'
  | 'teamId'
  | 'setTeamId'
  | 'linearProjectId'
  | 'setLinearProjectId'
  | 'loadingProjects'
  | 'linearProjects'
  | 'assignedToMe'
  | 'setAssignedToMe'
  | 'githubProjectId'
  | 'setGithubProjectId'
  | 'loadingGithubProjects'
  | 'githubProjects'
  | 'selectedGitHubProject'
>

export function WizardStep2Source({
  provider,
  connectionId,
  loadingTeams,
  teams,
  teamId,
  setTeamId,
  linearProjectId,
  setLinearProjectId,
  loadingProjects,
  linearProjects,
  assignedToMe,
  setAssignedToMe,
  githubProjectId,
  setGithubProjectId,
  loadingGithubProjects,
  githubProjects,
  selectedGitHubProject
}: WizardStep2SourceProps): React.JSX.Element {
  return (
    <>
      {provider === 'linear' ? (
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="wizard-linear-team">Team</Label>
            <Select value={teamId} onValueChange={setTeamId} disabled={!connectionId || loadingTeams}>
              <SelectTrigger id="wizard-linear-team" className="w-full max-w-md">
                <SelectValue placeholder={loadingTeams ? 'Loading teams...' : 'Choose a team'} />
              </SelectTrigger>
              <SelectContent>
                {teams.map((team) => (
                  <SelectItem key={team.id} value={team.id}>
                    {team.key} - {team.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="wizard-linear-project">Project scope</Label>
            <Select
              value={linearProjectId || '__none__'}
              onValueChange={(value) => setLinearProjectId(value === '__none__' ? '' : value)}
              disabled={!teamId || loadingProjects}
            >
              <SelectTrigger id="wizard-linear-project" className="w-full max-w-md">
                <SelectValue
                  placeholder={
                    loadingProjects ? 'Loading projects...' : 'Any project in selected team'
                  }
                />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">Any project in selected team</SelectItem>
                {linearProjects.map((linearProject) => (
                  <SelectItem key={linearProject.id} value={linearProject.id}>
                    {linearProject.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox
              id="wizard-assigned-to-me"
              checked={assignedToMe}
              onCheckedChange={(checked) => setAssignedToMe(checked === true)}
            />
            <Label htmlFor="wizard-assigned-to-me" className="text-sm">
              Assigned to me
            </Label>
            <Tooltip>
              <TooltipTrigger asChild>
                <Info className="size-3.5 text-muted-foreground" />
              </TooltipTrigger>
              <TooltipContent>Only discover issues assigned to the API key owner</TooltipContent>
            </Tooltip>
          </div>
        </div>
      ) : null}

      {provider === 'github' ? (
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="wizard-github-project">GitHub Project</Label>
            <Select
              value={githubProjectId}
              onValueChange={setGithubProjectId}
              disabled={!connectionId || loadingGithubProjects}
            >
              <SelectTrigger id="wizard-github-project" className="w-full max-w-md">
                <SelectValue
                  placeholder={
                    loadingGithubProjects ? 'Loading projects...' : 'Choose a GitHub Project'
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {githubProjects.length === 0 ? (
                  <SelectItem value="__none__" disabled>
                    No projects found — use a classic PAT with repo scope
                  </SelectItem>
                ) : null}
                {githubProjects.map((githubProject) => (
                  <SelectItem key={githubProject.id} value={githubProject.id}>
                    {githubProject.owner.login}#{githubProject.number} - {githubProject.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selectedGitHubProject ? (
              <p className="text-xs text-muted-foreground">
                Sync source: {selectedGitHubProject.owner.login}#{selectedGitHubProject.number}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  )
}
