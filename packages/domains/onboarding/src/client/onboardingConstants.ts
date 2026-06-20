export const STEP_NAMES = ['welcome', 'disclaimer', 'provider', 'analytics', 'cli', 'success'] as const
export const STEP_COUNT = STEP_NAMES.length

// Community links surfaced by the onboarding checklist (Join community / Follow on X).
// Single source of truth — the Electron app re-exports these from app-shell/constants.
export const COMMUNITY_DISCORD_URL = 'https://discord.gg/g7xPHXaU98'
export const COMMUNITY_X_URL = 'https://x.com/debuglebowski'

export const PROVIDERS = [
  { mode: 'claude-code', label: 'Claude Code' },
  { mode: 'codex', label: 'Codex' },
  { mode: 'cursor-agent', label: 'Cursor' },
  { mode: 'gemini', label: 'Gemini' },
  { mode: 'antigravity', label: 'Antigravity' },
  { mode: 'opencode', label: 'OpenCode' },
  { mode: 'qwen-code', label: 'Qwen Code' },
  { mode: 'copilot', label: 'Copilot' }
]

export const TRACKED_EVENTS = [
  'App version, active time, and crash reports',
  'Feature usage (tasks, terminal, editor, git, browser)',
  'Navigation and keyboard shortcuts',
  'Settings and theme changes'
]

export const NOT_TRACKED = [
  'Your code, files, or terminal content',
  'AI conversations or prompts',
  'Any project data'
]

export const CLI_FEATURES = [
  { cmd: 'slay tasks', desc: 'List and filter tasks' },
  { cmd: 'slay tasks add', desc: 'Create tasks from the command line' },
  { cmd: 'slay projects', desc: 'Switch between projects' },
  { cmd: 'slay init', desc: 'Set up AI config for a project' }
]
