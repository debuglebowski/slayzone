# The Linux release build's container (release-foundation.yml, linux-x64):
# ubuntu:22.04 plus scripts/release/linux-build-env.sh, installed ONCE here, never at
# release time. A release then needs only this image (ghcr.io), not Ubuntu's apt
# servers: the 2026-11-11 Canonical DNS outage failed v0.39.0's Linux build four
# times at `apt-get update` while every other build passed.
#
# ubuntu:22.04 = glibc 2.35, the floor the "Gate Linux glibc floor" step enforces
# (#165). Pinned by digest so a rebuild changes only what the inputs change.
#
# Build context = scripts/release. Build and push: scripts/release/linux-build-image/build.sh
# (or the "Linux build image" workflow), then pin the printed digest in
# release-foundation.yml.
FROM ubuntu:22.04@sha256:076e7bf82319619f28dd0aa9c02ab34b055ad37100395b4f49a2ffba04fb5e11

COPY linux-build-env.sh /tmp/inputs/linux-build-env.sh
COPY linux-build-image/Dockerfile /tmp/inputs/linux-build-image/Dockerfile

RUN bash /tmp/inputs/linux-build-env.sh \
  && rm -rf /var/lib/apt/lists/*

# The inputs' checksums, paths relative to scripts/release. The release build runs
# `sha256sum --check` on them in its checkout, so a toolchain edit without a rebuilt,
# re-pinned image fails the release instead of shipping with the old toolchain.
RUN cd /tmp/inputs \
  && sha256sum linux-build-env.sh linux-build-image/Dockerfile > /etc/slayzone-linux-build-inputs.sha256 \
  && rm -rf /tmp/inputs

# node-gyp reads CC/CXX: every native compiles with clang-15 (see linux-build-env.sh).
ENV CC=clang-15 CXX=clang++-15

LABEL org.opencontainers.image.source="https://github.com/debuglebowski/slayzone" \
      org.opencontainers.image.description="SlayZone Linux release build toolchain (ubuntu:22.04, glibc 2.35)"
