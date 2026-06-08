/**
 * @slayzone/mojo-bindings
 *
 * Source of truth for TypeScript types generated from Chromium Mojo .mojom
 * interfaces. The mojom/ directory holds the interface definitions;
 * scripts/generate.ts invokes Chromium's generator and writes TS into
 * src/generated/. Consumers import typed remotes/receivers from here.
 *
 * Phase 4 ships a single toy interface (state_fanout) that drives the
 * demo-region fan-out. Per-surface interfaces land in Phase 7+ alongside
 * each region's migration.
 */

export * from './generated/automations.mojom-webui'
export * from './generated/context.mojom-webui'
export * from './generated/dialog.mojom-webui'
export * from './generated/embedded_tab.mojom-webui'
export * from './generated/git.mojom-webui'
export * from './generated/json_rpc.mojom-webui'
export * from './generated/layout.mojom-webui'
export * from './generated/leaderboard.mojom-webui'
export * from './generated/processes.mojom-webui'
export * from './generated/projects.mojom-webui'
export * from './generated/settings.mojom-webui'
export * from './generated/sidebar.mojom-webui'
export * from './generated/state_fanout.mojom-webui'
export * from './generated/statusbar.mojom-webui'
export * from './generated/tabs.mojom-webui'
export * from './generated/tags.mojom-webui'
export * from './generated/taskheader.mojom-webui'
export * from './generated/tasklist.mojom-webui'
export * from './generated/terminal.mojom-webui'
export * from './generated/test.mojom-webui'
export * from './generated/tools.mojom-webui'
export * from './generated/usage.mojom-webui'
