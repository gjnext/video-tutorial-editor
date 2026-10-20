#!/usr/bin/env bash
# Builds the Swift helpers (ScreenCaptureKit recorder, AVFoundation/Core Image renderer)
# and the dev-only fixture tool. Requires Xcode or the Command Line Tools (swift ≥ 5.10).
set -euo pipefail
cd "$(dirname "$0")/../native"
swift build -c release --product studio-render
swift build -c release --product studio-recorder
swift build -c release --product studio-fixtures
BIN="$(swift build -c release --show-bin-path)"
OUT=.build/release
mkdir -p "$OUT"
for b in studio-render studio-recorder studio-fixtures; do
  if [ "$(cd "$BIN" && pwd -P)" != "$(cd "$OUT" && pwd -P)" ]; then cp -f "$BIN/$b" "$OUT/$b"; fi
  chmod 755 "$OUT/$b"
  # Ad-hoc sign so the helpers run identically in dev and inside the packaged app.
  codesign --force --sign - --timestamp=none "$OUT/$b" >/dev/null
done
echo "native helpers: $(pwd)/.build/release"
