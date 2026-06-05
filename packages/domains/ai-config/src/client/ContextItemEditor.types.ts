import type {
  AiConfigItem,
  CliProvider,
  ProjectSkillStatus,
  SkillUpdateInfo,
  SkillValidationState,
  UpdateAiConfigItemInput
} from '../shared'

export interface ContextItemEditorProps {
  item: AiConfigItem
  validationState?: SkillValidationState | null
  onUpdate: (patch: Omit<UpdateAiConfigItemInput, 'id'>) => Promise<void>
  onDelete: () => Promise<void>
  onClose: () => void
  readOnly?: boolean
  updateInfo?: SkillUpdateInfo | null
  onMarketplaceUpdate?: () => void
  onUnlink?: () => void
  syncStatus?: ProjectSkillStatus | null
  onSyncToDisk?: () => Promise<void>
  onSyncProviderToDisk?: (provider: CliProvider) => Promise<void>
  onPullProviderFromDisk?: (provider: CliProvider) => Promise<void>
}
