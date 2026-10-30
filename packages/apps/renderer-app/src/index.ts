// Stub renderer-app — chromium-fork skeleton.
//
// The real SlayZone renderer is NOT imported here. This is the empty shell the
// chromium host mounts so the fork boots + paints. Slay features get imported
// into this package incrementally; until then it's a placeholder.
//
// Contract consumed by the shells: `mountApp(options?)`.
export { mountApp, type MountAppOptions } from './main'
