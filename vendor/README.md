# Vendored packages

Immutable release tarballs pinned by `file:` dependencies. Never edit; replace the
file only with a new release and its published SHA-256.

| File | Package | SHA-256 | Source |
| --- | --- | --- | --- |
| `normain-idp-role-contract-0.1.0.tgz` | `@normain/idp-role-contract` 0.1.0 | `f54ba7da94b0330ac83f13349ac8330bed82ef7489c4576c80567e7bf0ae9fe0` | `idp-role-contract` repo `release/` (`npm run pack:immutable`, SHA256SUMS). Shared by Kahuna, Cloudable and SlayZone; consumed by `@slayzone/hub-auth` and `@slayzone/hub`. When published to a registry, swap the `file:` spec for the registry version; no code changes. |
