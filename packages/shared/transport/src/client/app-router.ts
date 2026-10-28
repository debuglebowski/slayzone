// The ONE place the client learns the server's router type. Type-only: nothing
// from @slayzone/api reaches a client bundle. It is still a package edge
// transport → api (and api → every domain → transport), so it is the cycle to
// cut next: every client file names AppRouter through this module, so swapping
// its source touches only this line.
export type { AppRouter } from '@slayzone/api'
