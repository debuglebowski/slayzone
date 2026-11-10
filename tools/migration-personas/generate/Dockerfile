# A released SlayZone build, installed from its own Linux .deb, for GENERATING a persona's
# frozen input. generate.sh copies the release's verified .deb in as slayzone.deb.
#
# amd64 only: releases ship no arm64 .deb, so on Apple silicon this runs under emulation.
# Node 22 is for the bundled `slay` CLI (resources/bin/slay needs a `node` on PATH, and
# node:sqlite). The persona user is uid 1000 with home /home/persona — the harness image
# uses the same uid and home, so every absolute path the old build wrote stays valid.
FROM --platform=linux/amd64 node:22-bookworm-slim
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    xvfb xauth dbus-x11 git sqlite3 ca-certificates procps \
    libgtk-3-0 libnotify4 libnss3 libxss1 libxtst6 xdg-utils libatspi2.0-0 libuuid1 libsecret-1-0 \
    libgbm1 libasound2 libdrm2 && rm -rf /var/lib/apt/lists/*
COPY slayzone.deb /tmp/slayzone.deb
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y /tmp/slayzone.deb \
    && rm /tmp/slayzone.deb && rm -rf /var/lib/apt/lists/*
RUN usermod -l persona -d /home/persona -m node && groupmod -n persona node
# A scripted `claude` for chat personas (see fake/claude). /usr/local/bin is on the
# login-shell PATH both releases resolve `claude` through.
COPY fake /opt/fake
RUN install -m 755 /opt/fake/claude /usr/local/bin/claude \
    && mkdir -p /opt/fake/state/epochs/1 && echo 1 > /opt/fake/state/current \
    && cp /opt/fake/scenario.json /opt/fake/state/epochs/1/scenario.json \
    && chown -R persona:persona /opt/fake/state
ENV SHELL=/bin/bash
USER persona
WORKDIR /home/persona
