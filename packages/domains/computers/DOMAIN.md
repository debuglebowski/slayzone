# Computers Domain

Computer registry for the hub/computer split: which computer machines exist, how they
enroll (single-use join tokens, sha256 hashes at rest), and where each computer
has each project checked out. Wave 1 lands DARK — schema (migration v149) +
store only, no tRPC router yet.

## Contracts (shared/)

- `ComputerRecord`, `JoinToken`, `DEFAULT_LOCAL_COMPUTER_NAME`
- `computer-labels.ts` — the words every client shows for a computer: `computerStatus`
  (Revoked / Disabled / Connected / Not responding / Never connected / Offline · last
  seen), `computerName` (null = Local), `inheritComputerLabel`, `runsOnLabel`,
  `OFFLINE_MARK`, `DISABLED_MARK`, `NO_COMPUTERS_NOTE`. Pure, also exported alone as `@slayzone/computers/labels` (desktop
  Settings → Connections and a task's Computer card, and the mobile app).

## Server (server/)

- `store.ts` — computer register/list/get/touch/revoke/rename, disable (`disabled_at`,
  v194: enrolled + connected, no new work), checkout upsert/get/list, task/project
  computer-binding helpers (`NULL` = inherit / local)
- `computers-router.ts` — `list`, `mintJoinToken` (every user for their own computer,
  an admin for anyone: `join-token-policy.ts`), `setDisabled` (refused while terminals
  or agents run there), `rename`, `delete`, bindings. The desktop hub's own computer is
  never disabled, renamed or deleted (`ComputersDeps.localComputerId`).
- `computer-state-errors.ts` — the stable refusal codes (`COMPUTER_DISABLED`,
  `COMPUTER_HAS_RUNNING_WORK`, `COMPUTER_IS_LOCAL`, `COMPUTER_NAME_RESERVED`).
- `join-tokens.ts` — `mintJoinToken` / `verifyJoinToken` / `decodeJoinToken`
  (`szjt1.<base64url payload>` tokens; only hashes stored)

## Dependencies

`@slayzone/platform` (SlayzoneDb).

## Tests

`pnpm test` runs vitest under `ELECTRON_RUN_AS_NODE=1 electron` — the suites
apply the real migration chain on in-memory better-sqlite3, and the repo's
better-sqlite3 binary is electron-rebuilt (Electron ABI), so plain-node vitest
cannot load it.
