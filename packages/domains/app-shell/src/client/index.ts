// Shared app-shell chrome — one source of truth for the Electron renderer and
// the Chromium fork. Holds the header action bar + the explode-mode hook so
// neither shell reimplements them.
export { useExplodeMode, type ExplodeModeApi } from './useExplodeMode'
export { AppHeaderActions } from './AppHeaderActions'
