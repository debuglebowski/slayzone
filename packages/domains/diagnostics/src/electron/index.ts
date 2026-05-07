export {
  registerDiagnosticsHandlers,
  registerProcessDiagnostics,
  stopDiagnostics,
  recordDiagnosticEvent,
  getDiagnosticsConfig,
  setIpcSuccessHook,
  type IpcSuccessHook,
} from './service'
export type { DiagnosticsEventRow } from '../server'
