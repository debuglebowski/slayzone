# Computers Domain

Computer registry for the hub/computer split: which computer machines exist, how they
enroll (single-use join tokens, sha256 hashes at rest), and where each computer
has each project checked out. Wave 1 lands DARK — schema (migration v149) +
store only, no tRPC router yet.

## Contracts (shared/)

- `ComputerRecord`, `JoinToken`, `DEFAULT_LOCAL_COMPUTER_NAME`

## Server (server/)

- `store.ts` — computer register/list/get/touch/revoke, checkout upsert/get/list,
  task/project computer-binding helpers (`NULL` = inherit / local)
- `join-tokens.ts` — `mintJoinToken` / `verifyJoinToken` / `decodeJoinToken`
  (`szjt1.<base64url payload>` tokens; only hashes stored)

## Dependencies

`@slayzone/platform` (SlayzoneDb).

## Tests

`pnpm test` runs vitest under `ELECTRON_RUN_AS_NODE=1 electron` — the suites
apply the real migration chain on in-memory better-sqlite3, and the repo's
better-sqlite3 binary is electron-rebuilt (Electron ABI), so plain-node vitest
cannot load it.
