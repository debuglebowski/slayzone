#!/usr/bin/env bash
# Toolchain for the Linux release build, installed into a bare `ubuntu:22.04`
# container (release-foundation.yml, linux-x64).
#
# Why a container and not a runner image (#165): electron-builder compiles every
# native without a Linux prebuild (node-pty) on the build host, so that host's glibc
# is the oldest the app loads on. `ubuntu-latest` moved to glibc 2.42 and v0.36.0's
# local computer died at load on Ubuntu 24.04 / Debian 12. A container image tag
# fixes the glibc for as long as we choose; a runner image is retired on GitHub's
# schedule. scripts/release/check-glibc-floor.mjs proves the result either way.
#
# Reproduce the CI build locally:
#   docker run --rm -it -v "$PWD:/src" ubuntu:22.04 bash -c \
#     'cd /src && bash scripts/release/linux-build-env.sh && …'
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
SUDO=''
[ "$(id -u)" -ne 0 ] && SUDO='sudo'

$SUDO apt-get update -qq
# - node-gyp: natives without a Linux prebuild are compiled here (node-pty, posix).
#   With clang-15, not the default g++ 11: Electron 45's V8 headers do not parse
#   under gcc 11 or 12 (`class [[deprecated]] V8_EXPORT …`), and clang-14 lacks
#   std::source_location. clang-15 compiles against 22.04's own libstdc++ 12 headers,
#   so libstdc++ needs stay at GLIBCXX_3.4.30 — the floor. g++ stays for the linker
#   driver and libstdc++ headers.
# - electron-builder: the .deb (fpm + ar); the AppImage tools ship with app-builder.
# - the packaged Electron binary, run as node by the smoke step, links the GUI
#   libraries at load even though it opens no window.
$SUDO apt-get install -y -qq --no-install-recommends \
  ca-certificates curl git gnupg xz-utils \
  python3 python3-setuptools make g++ clang-15 \
  binutils rpm fakeroot dpkg-dev \
  libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libgbm1 libgtk-3-0 \
  libasound2 libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libpango-1.0-0 \
  libcairo2 libxshmfence1 libsecret-1-0

# gh: the dry-run step uploads to a draft release with it (preinstalled on runners, not here).
if ! command -v gh >/dev/null 2>&1; then
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | $SUDO dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg status=none
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | $SUDO tee /etc/apt/sources.list.d/github-cli.list >/dev/null
  $SUDO apt-get update -qq
  $SUDO apt-get install -y -qq gh
fi

# Every later step compiles with clang-15: node-gyp reads CC/CXX from the env.
if [ -n "${GITHUB_ENV:-}" ]; then
  { echo 'CC=clang-15'; echo 'CXX=clang++-15'; } >> "$GITHUB_ENV"
fi

echo "glibc: $(ldd --version | head -1)"
echo "compiler: $(clang++-15 --version | head -1)"
