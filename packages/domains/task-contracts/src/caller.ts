/**
 * Who sends a request to the hub, as the `slay` CLI declares it. Dependency-free:
 * the CLI bundle imports it (`@slayzone/task-contracts/caller`).
 */

/**
 * Request header a task terminal's `slay` sends: the request comes from an agent
 * session (requests through a computer's CLI relay are agents' by construction).
 * A marker, not a credential: routes use it to honour the user's preferences about
 * their agents (`agent_may_change_layout`).
 */
export const CALLER_HEADER = 'x-slayzone-caller'
export const AGENT_CALLER = 'agent'

/** REST error code of a layout change an agent made while the user forbids it. */
export const LAYOUT_LOCKED_CODE = 'layout_locked'
