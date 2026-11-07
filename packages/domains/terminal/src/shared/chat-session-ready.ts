/**
 * A chat tab's session exists on the computer only once its `chat.hydrate` ran
 * there; a command that overtakes it is refused ("No chat session for tab"). The
 * hub does not promise to deliver a tab's calls in the order a client sent them,
 * so every client (desktop and mobile `useChatSession`) holds commands that need
 * the session behind the tab's latest hydrate.
 */
export class SessionReadyGate {
  private current: Promise<void> = Promise.resolve()

  /**
   * A load's hydrate: commands wait until it answered, either way — a failed
   * hydrate holds nothing back (the command then fails or succeeds on its own).
   * Returns `hydrate` unchanged.
   */
  track<T>(hydrate: Promise<T>): Promise<T> {
    this.current = hydrate.then(
      () => undefined,
      () => undefined
    )
    return hydrate
  }

  /** Until the latest hydrate answered; one started meanwhile (a reload) is waited for too. */
  async ready(): Promise<void> {
    let ready = this.current
    for (;;) {
      await ready
      if (ready === this.current) return
      ready = this.current
    }
  }
}
