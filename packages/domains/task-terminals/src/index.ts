// Re-export client components as default export
export {
  TerminalContainer,
  TerminalTabBar,
  MODE_ICONS,
  useTaskTerminals,
  isChatSupported,
  CHAT_SUPPORTED_MODES,
  markForceStart,
  requestAgentStart
} from './client'
export type { TerminalContainerHandle } from './client'
