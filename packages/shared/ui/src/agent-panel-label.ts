export function getAgentPanelLabel(): string {
  if (typeof window === 'undefined') return 'Terminal'
  const api = (window as unknown as { api?: { app?: { isAgentPanelLabelEnabledSync?: boolean } } }).api
  return api?.app?.isAgentPanelLabelEnabledSync ? 'Agent' : 'Terminal'
}
