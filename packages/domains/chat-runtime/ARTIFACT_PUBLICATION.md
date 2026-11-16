# Canonical artifact publication backend (S6b2b5)

This is the private backend for FU1's staging adapters. The production online runtime
exposes `runtime.artifactPublication`. The existing public artifact method schemas
still admit no source path. FU1 must connect its upload manager and final public
invokes; these backend tests do not complete that integration or H2.

## Main API

Import the types from `@slayzone/chat-runtime/server`:

```ts
import type {
  PublicationUploads, PublicationUploadLease, PublicationSourceGrant,
  InspectPublication, PublicationIntent, PublicationContext,
  ArtifactPublicationExecution, PublicationSettlement
} from '@slayzone/chat-runtime/server'

const execution = runtime.artifactPublication.start({
  route: { id: conversationId, epoch },
  operationId,
  intent: {
    method: 'uploadArtifactBlob',
    args: [{ taskId, title, folderId, staged: { sha256, size, uploadId } }]
  }
}, uploads)

const settlement = await execution.result
// The backend has already released its exact upload lease by this point.
if (settlement.outcome.kind === 'committed') {
  return settlement.outcome.value.result
}
```

`PublicationIntent` is the original validated `{ method, args }`, including the
original staged ref and owned uploadId. Methods are `uploadArtifactBlob` and
`writeArtifactContent`; the latter retains append/mutateCurrent/mutateRef/author.
Inline requests use the existing bounded `data` string instead of `staged`, omit
`uploads`, and decode only on the owner in aligned blocks. The existing14,000,000
base64-character bound remains; staged files have no restored content-size cap.

`uploads.reserveForPublication(ref, context)` returns the **exact** host-local
`PublicationUploadLease`: `{ grant, assertCurrent(), release(consumed) }`. Register
pending reservation work before its first await. Reserve/stat/bind only; do not
read/hash/decode the content on main. Existing validated `acquire` consumers retain
their current API. Release must remain usable after admission closes or the owner
exits, and be idempotent and entry-incarnation bound.

The grant has `kind:'staged-path'`, leaseId, entryId, canonical path, original ref,
`identity:{dev,ino,size}` (dev/ino decimal strings), and either:

- `binding:{kind:'owned',taskId,route,operationId,revision}`; or
- `binding:{kind:'legacy'}`. A shared legacy base remains unattributed.

The backend reserves an existing owner secondary lifetime synchronously before
inspect/reservation can yield. It coalesces same-key/same-input callers before a
second reservation. Delivered replay is fenced and returned **before** staging is
acquired, including when successful consumption removed the original source.
The owner computes the receipt digest over the validated original intent using
the existing sorted-key digest; transient paths/leases/instance IDs are excluded.
Different original input retains the operation-ID-reuse error.

`PublicationContext` is owner-derived: logical storeId, random physical instanceId,
connectionEpoch, route, taskId/tabId, lifecycleRevision, operationId and intentHash.
Do not construct/cache an admission ticket. `inspect()` is available for observation;
use `start()` for the complete inspected/reserved publication lifetime.

## Outcomes, cancellation and cleanup

Each execution exposes executionId, result, quiesced, and `cancel(reason)`.
Reasons: request-aborted, source-revoked, lifecycle-fence, shutdown.

- `result` normally resolves to a matched `{kind:'settled',quiescent:true,...}`.
  `committed` contains the original public result under `value.result`, replayed,
  `durability:'owner-flush'` and captured metadata. `not-committed` contains a
  serialized error and `receipt:'absent'|'accepted-unconfirmed'`. A failed final
  fence after metadata commit is `unconfirmed`; it is never guessed rollback.
- Inspection/startup/clone/transport failures may reject. An accepted-only receipt
  remains unconfirmed; do not automatically repeat it. Expired delivered results
  retain the existing expired-result error.
- `quiesced` means all this execution's worker FDs/I/O continuations ended, confirmed
  by a matching settlement, or its physical owner actually exited. It does not mean
  publication succeeded or staging cleanup finished. It does not resolve merely
  because an RPC rejected, cancellation was requested, or close failed.
- Main holds the exact upload lease until that barrier, then calls release(true)
  only for committed outcomes, release(false) for failures/uncertainty. `result`
  waits for lease/lifetime cleanup too. Cleanup errors reject with AggregateError;
  its cause retains the settlement when available. Never repeat a mutation because
  staging cleanup failed: inspect its durable receipt instead.
- Request-abort cancellation detaches one interested waiter and cancels shared work
  only after the last waiter leaves. Source/lifecycle/shutdown revocation cancels the
  shared execution. **FU1 must connect upload-entry revocation and request abort to
  execution.cancel**. A commit that already won remains committed after its fence.
- Runtime lifecycle, conversation transition/deletion, erasure and close cancel/drain
  accepted publication executions. Erasure's existing `stopExternal` hook must then
  finish upload-manager erasure after exact leases drain, before acknowledgement.
  The backend does not relabel legacy bases as task-owned uploads.

On uncertain transport, the facade first requests a matched privileged cancellation
settlement. If that cannot prove quiescence, it terminates **only this canonical
store's owner**, waits the independent `storage.exited` barrier, releases source and
owner lifetimes, then awaits termination cleanup. Waiting for the lease-dependent
close/terminate Promise before releasing a source would create a cycle.

## Private wire seam

The compiled private registry reuses `chatRuntime.call`:

```ts
{ group: 'artifactPublication', method: 'inspect', args: [InspectPublication] }
{ group: 'artifactPublication', method: 'publish', args: [PublishPublication] }
{ group: 'artifactPublication', method: 'status', args: [PublicationControl] }
{ group: 'artifactPublication', method: 'cancel', args: [CancelPublication] }
```

Publish carries executionId, context, original intent and optional source grant
(inline has no second body field). Status/cancel carry owner stamp, logical
`key:{conversationId,operationId}`, executionId, and cancellation reason as needed.
`AsyncChatStorage.publicationControl()` is the privileged status/cancel lane usable
after admission/failure/close begins. It cannot admit work. Unknown/stale controls
reject; status `absent`/`running` is never physical quiescence evidence. Completed
status observations are bounded by count/bytes; durable replay uses existing receipts.
No new global hub transaction registration, public RPC, writer or job ledger exists.

## Worker sequence and file inventory

Protocol v9 `artifact.invoke/readBytesRange` also runs through this canonical owner.
The peer `artifacts.readBytesChunk` response stays `{data,size,version}` with the shared
8MiB raw-byte chunk cap; disk reads use at most256KiB. Blob verification and range reads
retain the same descriptor. The verification cache keys its device/inode/size/mtime/
ctime identity, never a later pathname's stamp; wire generation tokens retain their
existing format. Working-file, legacy-file and current-blob fallback/error semantics
remain unchanged. Runtime close drains accepted range reads before owner shutdown.

The host's shared prefix fence drains all captured RPC settlements before the real
FULL commit. Each caller retains its own validation/write error; a refused sibling
does not turn another committed operation into a failed acknowledgement. Failure of
the actual durability fence still rejects and retains the online store's failure latch.

The canonical worker independently derives owned paths:
`uploads/owned/D(taskId)/D(route.id)/uploadId/data.part`, where D is SHA-256 of
JSON.stringify, and uploadId is D([taskId,{id,epoch},operationId,revision]). Adjacent
version1 manifests must match. Legacy paths are `uploads/<sha256>-<size>.part`.
It rejects symlink ancestors/leaf escapes, validates the exact descriptor's dev/ino/
size, and streams the expected hash with buffers at most256KiB. That same source FD
survives output preparation; timestamp changes cause bounded rehash on the retained
descriptor, allowing valid legacy mtime touches while rejecting changed bytes.

The reviewed `@slayzone/task-artifacts/publication-files` helper owns bounded source,
previous-image, append and inline preparation. Its worker-local prepareOutputs
continuation lets the canonical owner adopt images while the source FD remains live.
All FDs close before metadata acknowledgement. Failed descriptor close is explicitly
unconfirmed physical I/O and requires owner exit rather than early source release.

The existing `artifacts/.transactions/<UUID>/` namespace is authoritative:

- Before any body byte: durable owner.json (version1, preparing kind, task,
  conversation, operation, intentHash, jobId, cleanupToken; optional artifactId).
  Cleanup claims retain that header's original jobId even after a UUID rename.
- before/after/publish/blob are private durable images. blob.json inventories the
  prepared hash/size before a final content-addressed blob can appear. No new
  unattributed blobs/.tmp spool is used. Existing dedup blobs are verified with
  bounded reads and corrupt targets repaired through durable replacement.
- The existing manifest.json + artifact_file_commits marker decide committed versus
  rolled-back working copies. Bulk copy/hash/sync preparation ends before the short
  SQLite transaction. Small final blob/working renames and directory durability,
  version/row changes, retained metadata/counter/stateVersion and completeCommand
  share that transaction. No transaction crosses an await.
- All artifact mutations, including appends and folder reconciliation, share the
  artifact mutation lane across full async preparation. Task retention access,
  secondary registrations and non-TTL live blob pins protect accepted work from
  pruning, swap/close and GC. Logical failure does not release physical leases.
- Recovery runs before admission, skips registered live jobs, uses only owner-local
  images, preserves observed external working-file edits, and never reopens an old
  main-staging source. Preparing/claimed jobs, partial adopted images and commit
  markers remain inventoried. Bodies are durably removed before ownership headers.
- Existing task-erasure checks and content-erasure manifests capture preparing blob
  hashes before journal removal, including blobs without a committed version row.
  Shared referenced hashes remain. Unknown/malformed preparing residue, including
  its quarantine, refuses verified erasure rather than disappearing from inventory.

Only after the actual owner FULL fence does success/metadata escape. Main must not
run blob fsync, local.metadata or completeCommand. The existing retained outbox is
the reconnect/replay source. A metadata consumer failure leaves it unacknowledged
and does not undo or repeat a committed publication; replay allocates no new update.

## Evidence and remaining integration

Actual packaged-worker tests cover staged32MiB+17 uploads,64MiB previous +32MiB+17
append, binary/empty/version/undo/author semantics, overlapping appends, ownership/
identity/source changes, dropped replies/outbox replay, source/output/directory/final
fence faults, preparing/claimed/orphan inventory, cancellation/erasure/close, real
worker deaths before/after metadata commit and failed-close physical-exit barriers.
POSIX VFS proof holds the real final publication FULL sync while actual authenticated
multi-hub dispatch ping/process stop remains responsive, with main SQLite/body I/O0.
Portable file fault gates call/inject at real worker file APIs; they are not claims
of a blocked OS filesystem syscall on Windows.

FU1 final public-invoke/staging adapters and manager revocation/erasure wiring remain
required. Also pending: final migrated4GB/contention/caller proof, real heartbeat/chat
cancel and all-provider bounded/lossless/control ACK with stdout paused, S8 whole
archive/temp/privacy serialization (separately owned), independent
review/fix loop and current-main integration. This checkpoint is not whole H1/H2 DONE.
Reviewed S7 unclean-start/swap recovery is integrated; it does not close those remaining
acceptance requirements.
