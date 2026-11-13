#!/bin/sh
# Pack /home/persona into /tmp/input.tar.gz — the persona's frozen input.
# Drops only Chromium's own profile data (caches, cookies, storage) under the Electron
# userData dir: no SlayZone migration reads it, and it is most of the size. Everything
# SlayZone wrote — databases, artifacts, blobs, configs, hooks, repos — is kept as is.
set -e
cd /home/persona
UD=.local/state/slayzone
for p in Cache "Code Cache" GPUCache DawnGraphiteCache DawnWebGPUCache Crashpad blob_storage \
  Dictionaries "Shared Dictionary" Partitions "Session Storage" "Local Storage" "WebStorage" \
  Cookies Cookies-journal DIPS DIPS-wal DIPS-shm "Trust Tokens" "Trust Tokens-journal" \
  "Network Persistent State" Preferences SingletonCookie SingletonLock SingletonSocket \
  "Network" "TransportSecurity" "Reporting and NEL" "Reporting and NEL-journal"; do
  rm -rf "$UD/$p"
done
rm -rf .cache .npm
tar --numeric-owner -czf /tmp/input.tar.gz .
ls -la /tmp/input.tar.gz
