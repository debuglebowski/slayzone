import type {
  AiConfigItem,
  AiConfigItemType,
  CliProvider,
  ProjectSkillStatus,
  SyncHealth
} from '../shared'
import type { ContextManagerSection } from './ContextManagerSettings'

export interface ItemSectionProps {
  type: AiConfigItemType
  linkedItems: ProjectSkillStatus[]
  localItems: AiConfigItem[]
  enabledProviders: CliProvider[]
  projectId: string
  projectPath: string
  onOpenContextManager?: (section: ContextManagerSection) => void
  onChanged: () => void
}

export interface ProviderRow {
  provider: CliProvider
  path: string
  syncHealth: SyncHealth
}
