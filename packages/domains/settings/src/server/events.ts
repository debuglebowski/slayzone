import { EventEmitter } from 'node:events'

export interface SettingsEventMap {
  'theme:changed': 'dark' | 'light'
}

class TypedEmitter<M> extends EventEmitter {
  override emit<K extends keyof M & string>(event: K, payload: M[K]): boolean {
    return super.emit(event, payload)
  }
  override on<K extends keyof M & string>(event: K, listener: (payload: M[K]) => void): this {
    return super.on(event, listener)
  }
  override off<K extends keyof M & string>(event: K, listener: (payload: M[K]) => void): this {
    return super.off(event, listener)
  }
}

export const settingsEvents = new TypedEmitter<SettingsEventMap>()
