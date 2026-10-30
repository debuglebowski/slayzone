/**
 * The chat's slash-command logic without its menu: what the desktop composer offers
 * after `/` and how it ranks and resolves it — the app's builtins, the CLI's own
 * commands, custom command files as the CLI names them, the fuzzy ranking, and what
 * Enter picks. DOM-free (no React, no UI kit), so another client (the mobile app,
 * `@slayzone/task-terminals/slash-commands`) offers the same commands the same way.
 *
 * @module chat/autocomplete/slash-commands
 */
export {
  availableBuiltins,
  builtinCommands,
  filterBuiltins,
  rankBuiltins,
  type BuiltinsSourceOpts
} from './builtins-registry'
export { cliCommandItems, type CliCommandItem } from './cli-command-items'
export { CLI_COMMAND_DESCRIPTIONS, describeCliCommand } from './cli-command-descriptions'
export {
  customCommandItems,
  expandCommandBody,
  takesArguments,
  transformCommandSubmit
} from './custom-command-items'
export { rankByName, type RankAccessors } from './ranking'
export { resolveEnter, type EnterResolution } from './resolve-enter'
export { resetChat, type ResetChatOptions } from './chat-actions'
export type {
  AcceptCtx,
  BuiltinCommand,
  ChatActions,
  NavigateActions,
  SessionRef,
  SubmitTransform
} from './types'
