// Re-exported from ../server, where these actually live now. They import nothing
// but `SlayzoneDb` + a shared type — being filed under /electron is what kept the
// side-car from wiring them (guard 2b forbids the hub importing an /electron
// entry), which is the same reason setOnHostKillHandler and backfillChatModes
// went dead. Kept as a re-export so existing host call sites are undisturbed.
export { createPtyEnricher, markTabSpawned, markTabHibernated } from '../server/pty-enricher'
