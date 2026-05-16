// SlayZone opencode plugin v1
//
// Forwards OpenCode SDK session lifecycle events to the SlayZone agent-hook
// notify script over a local shell exec. Plugin is loaded by OpenCode from
//   ${XDG_CONFIG_HOME:-~/.config}/opencode/plugin/slayzone-notify.js
//
// The {{NOTIFY_PATH}} placeholder is substituted by the SlayZone installer
// (packages/apps/app/src/main/agent-hooks/opencode-plugin-installer.ts) at
// install time with the absolute path to `~/.slayzone/hooks/notify.sh`.
//
// Behavior:
//   - No-op when SLAYZONE_TASK_ID is unset (plugin only fires inside SlayZone PTYs).
//   - Subagent (child session) events are suppressed — oh-my-opencode + similar
//     tools spawn many child sessions and would otherwise flap Start/Stop.
//   - On client.session.list() error, sessions are assumed CHILD (safer to
//     suppress than emit a false-positive Start/Stop).
//   - Handles both modern (session.status w/ nested type) and legacy
//     (session.busy / session.idle) event shapes for forward compat.
//   - Singleton guard prevents double-load if OpenCode re-imports the plugin.

export const SlayzoneNotifyPlugin = async ({ $, client }) => {
  if (globalThis.__slayzoneOpencodePluginV1) return {}
  globalThis.__slayzoneOpencodePluginV1 = true
  if (!process?.env?.SLAYZONE_TASK_ID) return {}

  const notifyPath = '{{NOTIFY_PATH}}'
  let currentState = 'idle' // 'idle' | 'busy'
  let rootSessionID = null // first non-child session we see
  let stopSent = false // dedup Stop emits
  const childSessionCache = new Map() // sessionID -> isChild bool

  const notify = async (eventName) => {
    const payload = JSON.stringify({ hook_event_name: eventName })
    try {
      await $`bash ${notifyPath} ${payload}`
    } catch {
      // Hook failures must never bubble into the OpenCode TUI.
    }
  }

  const isChildSession = async (sessionID) => {
    if (!sessionID) return true
    if (!client?.session?.list) return true
    if (childSessionCache.has(sessionID)) return childSessionCache.get(sessionID)
    try {
      const sessions = await client.session.list()
      const session = sessions.data?.find((s) => s.id === sessionID)
      const isChild = !!session?.parentID
      childSessionCache.set(sessionID, isChild)
      return isChild
    } catch {
      // On error, assume CHILD — safer than emitting a false-positive Start/Stop.
      return true
    }
  }

  const handleBusy = async (sessionID) => {
    if (!rootSessionID) rootSessionID = sessionID
    if (sessionID !== rootSessionID) return
    if (currentState === 'idle') {
      currentState = 'busy'
      stopSent = false
      await notify('Start')
    }
  }

  const handleStop = async (sessionID) => {
    if (rootSessionID && sessionID !== rootSessionID) return
    if (currentState === 'busy' && !stopSent) {
      currentState = 'idle'
      stopSent = true
      await notify('Stop')
      rootSessionID = null // reset for next session
    }
  }

  return {
    event: async ({ event }) => {
      const sessionID = event.properties?.sessionID ?? event.properties?.info?.id ?? null

      if (event.type === 'session.created') {
        const isChild = Boolean(event.properties?.info?.parentID)
        if (sessionID) childSessionCache.set(sessionID, isChild)
        if (!isChild) await notify('SessionStart')
        return
      }

      if (event.type === 'session.deleted') {
        const cached = sessionID ? childSessionCache.get(sessionID) : undefined
        const isChild = cached !== undefined ? cached : await isChildSession(sessionID)
        if (!isChild) await notify('SessionEnd')
        if (sessionID) childSessionCache.delete(sessionID)
        return
      }

      if (await isChildSession(sessionID)) return

      if (event.type === 'session.status') {
        const status = event.properties?.status
        if (status?.type === 'busy') await handleBusy(sessionID)
        else if (status?.type === 'idle') await handleStop(sessionID)
      }
      // Backwards-compat: some OpenCode versions emit busy/idle as top-level events.
      if (event.type === 'session.busy') await handleBusy(sessionID)
      if (event.type === 'session.idle') await handleStop(sessionID)
      if (event.type === 'session.error') await handleStop(sessionID)
    },
    'permission.ask': async (_permission, output) => {
      if (output.status === 'ask') await notify('PermissionRequest')
    },
  }
}
