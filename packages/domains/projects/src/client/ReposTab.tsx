import { FolderGit2, Star } from 'lucide-react'
import { getTrpcVanillaClient } from '@slayzone/transport/client'
import { cn } from '@slayzone/ui'
import type { Project, DetectedRepo } from '@slayzone/projects/shared'
import { SettingsTabIntro } from './project-settings-shared'

interface ReposTabProps {
  project: Project
  repos: DetectedRepo[]
  onUpdated: (project: Project) => void
}

export function ReposTab({ project, repos, onUpdated }: ReposTabProps) {
  const defaultRepo = project.selected_repo ?? repos[0]?.name ?? null

  const handleSetDefault = async (repoName: string) => {
    const updated = await getTrpcVanillaClient().projects.update.mutate({
      id: project.id,
      selectedRepo: repoName
    })
    onUpdated(updated)
  }

  if (repos.length === 0) {
    return (
      <div className="space-y-6">
        <SettingsTabIntro title="Repositories" description="Detected git repositories in this project folder." />
        <p className="text-sm text-muted-foreground">No child git repositories found in {project.path}.</p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <SettingsTabIntro title="Repositories" description="Detected git repositories in this project folder. The default repo is used for new tasks and the home tab." />

      <div className="space-y-1">
        {repos.map((repo) => {
          const isDefault = repo.name === defaultRepo
          return (
            <button
              key={repo.name}
              onClick={() => handleSetDefault(repo.name)}
              className={cn(
                'w-full flex items-center gap-3 px-3 py-2.5 rounded-md text-left transition-colors',
                isDefault
                  ? 'bg-accent text-accent-foreground'
                  : 'hover:bg-muted/50 text-foreground'
              )}
            >
              <FolderGit2 className="h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">{repo.name}</div>
                <div className="text-xs text-muted-foreground truncate">{repo.path}</div>
              </div>
              {isDefault && (
                <Star className="h-3.5 w-3.5 shrink-0 text-amber-500 fill-amber-500" />
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
