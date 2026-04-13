import { useState } from 'react'
import { Tabs, TabsList, TabsTrigger } from '@slayzone/ui'
import {
  ContextManagerSettings,
  type ProjectContextManagerTab,
  type ContextManagerSection
} from '../../../ai-config/src/client/ContextManagerSettings'
import type { Project } from '@slayzone/projects/shared'
import { SettingsTabIntro } from './project-settings-shared'

interface AiConfigTabProps {
  project: Project
  onOpenContextManager?: (section: ContextManagerSection) => void
}

export function AiConfigTab({ project, onOpenContextManager }: AiConfigTabProps) {
  const [contextManagerTab, setContextManagerTab] = useState<ProjectContextManagerTab>('config')

  return (
    <div className="flex h-full min-h-0 flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3 shrink-0">
        <div className="min-w-0 flex-1">
          <SettingsTabIntro
            title="Context Manager"
            description="Manage project-specific AI instructions, skills, and provider sync behavior. Use this to adapt library context to this project's workflow."
          />
        </div>
        <Tabs
          value={contextManagerTab}
          onValueChange={(value) => setContextManagerTab(value as ProjectContextManagerTab)}
          className="shrink-0"
        >
          <TabsList>
            <TabsTrigger value="config" data-testid="project-context-tab-config">Config</TabsTrigger>
            <TabsTrigger value="files" data-testid="project-context-tab-files">Files</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      <div className="min-h-0 flex-1">
        <ContextManagerSettings
          scope="project"
          projectId={project.id}
          projectPath={project.path}
          projectName={project.name}
          projectTab={contextManagerTab}
          onOpenContextManager={onOpenContextManager}
        />
      </div>
    </div>
  )
}
