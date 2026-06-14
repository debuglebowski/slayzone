import { ipcMain, BrowserWindow } from 'electron'
import type { SlayzoneDb } from '@slayzone/platform'
import type { RestApiDeps } from '@slayzone/transport/server'
import {
  listPtys,
  getBuffer,
  killPty,
  writePty,
  submitPty,
  hasPty,
  requestEnsureAlive,
  subscribeToPtyData,
  subscribeToStateChange,
  onSessionChange,
  getState,
  findSessionByTaskIdAndMode,
  transitionStateFromHook,
  markSessionActiveFromHook,
  noteSessionConversationId,
  setSessionAwaitingInput
} from '@slayzone/terminal/electron'
import {
  buildPdfHtml,
  buildMermaidPdfHtml,
  buildPngHtml,
  renderToPdf,
  renderToPng
} from '@slayzone/task/electron'
import { notifyRenderer } from './notify-renderer'
import { menuEvents } from './menu-events'
import { agentLifecycleEvents } from './agent-lifecycle-events'
import { listAllProcesses, killProcess, subscribeToProcessLogs } from '@slayzone/processes/server'
import {
  getBrowserWebContents,
  getResolvedBrowserTabId,
  listBrowserTabs,
  waitForBrowserRegistration
} from './browser-registry'

/**
 * Electron-host capability set for the MCP + REST module (now hosted in
 * `@slayzone/transport/server`). Every slot is wired to the same module
 * singletons the legacy in-main registration used — behavior-identical.
 * The standalone @slayzone/server builds its own (smaller) set; routes whose
 * slot is absent there respond 501.
 */
export function buildMcpRestDeps(
  db: SlayzoneDb,
  automationEngine: { executeManual(id: string): Promise<unknown> }
): RestApiDeps {
  return {
    db,
    notifyRenderer,
    automationEngine,
    agentLifecycle: agentLifecycleEvents,
    menu: menuEvents,
    taskBus: ipcMain,
    pty: {
      listPtys,
      hasPty,
      getBuffer,
      writePty,
      submitPty,
      killPty,
      requestEnsureAlive,
      subscribeToPtyData,
      subscribeToStateChange,
      onSessionChange,
      getState
    },
    terminalStateBridge: {
      findSession: findSessionByTaskIdAndMode,
      transition: transitionStateFromHook,
      markActive: markSessionActiveFromHook,
      noteConversationId: noteSessionConversationId,
      noteAwaitingInput: setSessionAwaitingInput
    },
    processes: {
      listAll: listAllProcesses,
      kill: killProcess,
      subscribeToLogs: subscribeToProcessLogs
    },
    browser: {
      getBrowserWebContents,
      getResolvedBrowserTabId,
      listBrowserTabs,
      waitForBrowserRegistration
    },
    windowActions: {
      raiseMainWindow: () => {
        const mainWin = BrowserWindow.getAllWindows()[0]
        if (mainWin) {
          if (mainWin.isMinimized()) mainWin.restore()
          mainWin.show()
          mainWin.focus()
        }
      }
    },
    artifactExport: {
      buildPdfHtml,
      buildMermaidPdfHtml,
      buildPngHtml,
      renderToPdf,
      renderToPng
    }
  }
}
