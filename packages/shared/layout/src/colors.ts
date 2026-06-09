// Inline-style color tokens (Tailwind isn't confirmed safe in the chrome://
// bundle, so the framework styles with these constants + style objects). Lifted
// from the renderer-app TaskDetailsView stub + a few layout-specific tokens.
export const COLORS = {
  bg: '#0e0e10',
  panelBg: '#141417',
  border: '#26262c',
  barBg: '#161619',
  text: '#e5e5e5',
  muted: '#8a8a92',
  faint: '#5a5a62',
  activeBg: '#2a2a33',
  accent: '#7c7cf0',
  // layout-specific
  dividerHover: '#3a3a44',
  dividerActive: '#7c7cf0',
  nativePlaceholderBg: '#101013',
  overlayScrim: 'rgba(0, 0, 0, 0.5)'
} as const
