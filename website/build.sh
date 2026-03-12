#!/bin/bash
set -e
cd "$(dirname "$0")"

build() {
  mkdir -p dist

  # Copy static assets into dist
  cp -r assets/* dist/ 2>/dev/null || true
  cp src/sitemap.xml src/robots.txt dist/ 2>/dev/null || true

  for src in src/pages/*.html; do
    out="dist/$(basename "$src")"
    cp "$src" "$out"

    # 2 passes for nested partials (footer → social-links)
    for pass in 1 2; do
      for partial in src/partials/*.html; do
        name=$(basename "$partial" .html)
        marker="{{${name}}}"
        if grep -qF "$marker" "$out"; then
          MARKER="$marker" PARTIAL="$partial" perl -0777 -i -pe '
            open(F, "<", $ENV{PARTIAL}) or die;
            local $/; $r = <F>; close F; chomp $r;
            s/\Q$ENV{MARKER}\E/$r/g;
          ' "$out"
        fi
      done
    done

    echo "Built $out"
  done
}

if [[ "$1" == "--watch" ]]; then
  build
  echo "Watching for changes (polling every 1s)..."
  get_max_mtime() {
    local max=0
    for f in src/pages/*.html src/partials/*.html; do
      local m
      m=$(stat -f %m "$f" 2>/dev/null || stat -c %Y "$f" 2>/dev/null || echo 0)
      (( m > max )) && max=$m
    done
    echo "$max"
  }
  last_mtime=$(get_max_mtime)
  while true; do
    sleep 1
    current=$(get_max_mtime)
    if [[ "$current" != "$last_mtime" ]]; then
      last_mtime="$current"
      build
    fi
  done
else
  build
fi
