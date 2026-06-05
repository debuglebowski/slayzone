import type { McpServerConfig, McpTarget } from '../../shared'
import type { CuratedMcpServer } from '../../shared/mcp-registry'

export interface CustomMcpServer {
  id: string
  name: string
  description?: string
  config: McpServerConfig
}

export interface EditTarget {
  originalKey: string
  server: CustomMcpServer
}

export interface MergedServer {
  key: string
  curated: CuratedMcpServer | null
  custom: CustomMcpServer | null
  config: McpServerConfig | null
  providers: McpTarget[]
}
