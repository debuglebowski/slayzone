import { ProjectInstructions } from './ProjectInstructions'
import { ComputerContextFiles } from './ComputerContextFiles'
import { InstructionVariantsView } from './InstructionVariantsView'
import type { ConfigLevel } from '../shared'

interface InstructionsSectionProps {
  level: ConfigLevel
  projectId: string | null
  projectPath?: string | null
}

export function InstructionsSection({ level, projectId, projectPath }: InstructionsSectionProps) {
  if (level === 'computer') {
    return <ComputerContextFiles filter="instructions" />
  }

  if (level === 'project') {
    return (
      <ProjectInstructions
        projectId={projectId}
        projectPath={projectPath}
      />
    )
  }

  // Library level
  return <InstructionVariantsView />
}
