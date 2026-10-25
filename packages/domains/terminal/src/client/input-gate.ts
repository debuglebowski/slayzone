/**
 * Keystrokes typed into a terminal before its PTY exists. The xterm is focusable
 * the moment it opens, but the session is created a round trip later; without a
 * gate those keys reach no handler and are lost. Held input is delivered in order
 * as one write when the session is up; after that input passes straight through.
 */
export interface InputGate {
  input(data: string): void
  /** The session is up: deliver what was held, then pass input through. */
  open(): void
  /** The session never came up: discard held and later input. */
  drop(): void
}

export function createInputGate(write: (data: string) => void): InputGate {
  let state: 'held' | 'open' | 'dropped' = 'held'
  let held = ''
  return {
    input(data) {
      if (state === 'open') write(data)
      else if (state === 'held') held += data
    },
    open() {
      if (state !== 'held') return
      state = 'open'
      const pending = held
      held = ''
      if (pending) write(pending)
    },
    drop() {
      state = 'dropped'
      held = ''
    }
  }
}
