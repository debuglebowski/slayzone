import { EventEmitter } from 'node:events'

/** Native-menu / app shortcut events dispatched main→renderer via tRPC subs.
 *  Replaces window.webContents.send('app:*', ...) and similar broadcasts. */
export const menuEvents = new EventEmitter()
