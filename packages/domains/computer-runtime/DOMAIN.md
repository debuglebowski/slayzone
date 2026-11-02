# Computer runtime

Same-user IPC and durable retry primitives for standalone computer processes.
Depends only on computer-transport's framing/RPC helpers. No hub wire negotiation,
Electron, filesystem handlers, or process/session ownership in this package.

`HOST_CONTRACT_VERSION` versions the host/connector contract independently of the
hub protocol. Connectors advertise their supported range before handover. Hosts
supply a stable incarnation epoch; durable increasing connector generations fence
old attachments, both locally and at the hub.

`socketPeer` applies frame/backpressure bounds and closes broken peers without
unhandled response errors. Application composition authenticates each connection
before exposing methods: a device-local supervisor key grants control, and a
hub/generation-specific HMAC grants only connector operations. Secrets stay under
the protected computer ROOT. POSIX sockets use a user-private temporary directory;
Windows uses named pipes plus the same authentication. This does not isolate
processes running as the same OS user.

`RetryPolicy` supplies jittered backoff and quarantine, with serializable state so
restarts cannot bypass cooldown. The computer application owns installation,
release pointers, health probation, service integration and persisted status.

The computer application's session host owns PTYs/jobs, bounded output/tombstones,
hook journal and CLI capabilities. Connectors and supervisors can be replaced
without disposing it. Host replacement requires an atomic idle/drain check; active
work always defers automatic host maintenance. Explicit service stops retain their
existing termination behavior.

An explicitly negotiated maintenance connector can expose safe controls for a
busy older host while declaring chat unavailable. It cannot start new work. Build
identity also detects same-release host rebuilds, which are applied only at idle.
Only native hooks use the durable notification journal; chat events replay from
their owning content/outbox store.
