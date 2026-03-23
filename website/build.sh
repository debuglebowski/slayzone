#!/bin/bash
set -e
cd "$(dirname "$0")"

if [[ "$1" == "--watch" ]]; then
  pnpm dev
else
  pnpm build
fi
