#!/usr/bin/env bash
# Build and publish a client release: scripts/release.sh 0.1.1
# Assets use fixed names so install docs can always point at releases/latest.
set -euo pipefail
V="${1:?usage: scripts/release.sh <version>}"
cd "$(dirname "$0")/.."
for p in core client; do
  (cd "packages/$p" && npm pkg set version="$V")
done
(cd packages/client && npm pkg set "dependencies.@ai-wayfinding/core=$V")
npm install --package-lock-only >/dev/null
OUT="$(mktemp -d)"
for p in core client; do
  (cd "packages/$p" && npm run build >/dev/null && npm pack --pack-destination "$OUT" >/dev/null)
  mv "$OUT/ai-wayfinding-$p-$V.tgz" "$OUT/ai-wayfinding-$p.tgz"
done
git add packages/core/package.json packages/client/package.json package-lock.json 2>/dev/null || true
git commit -m "Release v$V"
git tag "v$V"
git push origin HEAD "v$V"
gh release create "v$V" --latest --title "v$V" --notes "Install: see packages/client/README.md." "$OUT/ai-wayfinding-core.tgz" "$OUT/ai-wayfinding-client.tgz"
