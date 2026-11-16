/** Launch settings shared by the server resolver and chat runtime. */
export interface ChatCreateOpts {
  tabId: string
  taskId: string
  mode: string
  cwd: string
  providerFlagsOverride?: string | null
}
