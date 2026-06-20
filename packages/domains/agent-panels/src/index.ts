// @slayzone/agent-panels — the two right-side panels shared by the Electron app
// renderer and the chromium-fork renderer-app:
//   • Global Agent panel — wraps a terminal/claude-code session (GlobalAgentSidePanel
//     + its header toggle + panel-state hook + the detached floating-window variant).
//   • Agent Status panel — lists idle/stalled agent tasks with dismiss/navigate
//     controls (AgentStatusSidePanel + its header toggle + idle-task hooks).
// Extracted from packages/apps/app/src/renderer/src/components/* (sidebar precedent)
// so the fork imports the canonical components instead of reimplementing them.
export * from './global-agent-panel'
export * from './agent-status'
