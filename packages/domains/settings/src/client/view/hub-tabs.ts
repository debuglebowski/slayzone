/**
 * A hub page's tabs, in order.
 *
 * `defaultOnly`: acts on the machine that runs the default hub (`app.*` host
 * routers), so only the default hub shows it.
 * `multiHub`: about hubs and computers as such. When the local hub is the only one
 * the Settings view drops those concepts (the nav's Workspace section lists the
 * other tabs as plain pages), so these are not offered there.
 */
export const HUB_PAGE_TABS: ReadonlyArray<{
  key: string
  label: string
  defaultOnly?: boolean
  multiHub?: boolean
}> = [
  { key: 'overview', label: 'Overview', multiHub: true },
  { key: 'computers', label: 'Computers', multiHub: true },
  { key: 'agents', label: 'Agents & providers' },
  { key: 'worktrees', label: 'Worktrees' },
  { key: 'mcp', label: 'MCP', defaultOnly: true },
  { key: 'backups', label: 'Backups', defaultOnly: true },
  { key: 'data', label: 'Import & export', defaultOnly: true }
]

/** The tabs a hub's page offers. */
export function hubPageTabs({
  isDefault,
  solo
}: {
  isDefault: boolean
  solo: boolean
}): Array<[string, string]> {
  return HUB_PAGE_TABS.filter((t) => (!t.defaultOnly || isDefault) && (!t.multiHub || !solo)).map(
    (t) => [t.key, t.label]
  )
}
