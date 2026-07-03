#!/usr/bin/env bash
# convert.sh — convert a video (MP4/MOV/…) into the Y4M 4:2:0 format required by the
# Chromium flag --use-file-for-fake-video-capture. The file is looped by the browser.
#
# Cross-platform alternative (macOS + Windows, uses the bundled ffmpeg): npm run convert
# This shell script requires a system ffmpeg and is a macOS/Linux convenience only.
#
# Usage:  bash media/convert.sh /path/to/video.mp4  [output.y4m]  [width] [fps]
# e.g.:   bash media/convert.sh ~/Desktop/clip.mov
#
# WARNING: Y4M is uncompressed -> large files. Use a short clip (a few seconds).
set -euo pipefail

SRC="${1:-}"
OUT="${2:-media/webcam.y4m}"
WIDTH="${3:-1280}"
FPS="${4:-30}"

if [[ -z "$SRC" ]]; then
  echo "Error: specify the source video." >&2
  echo "Usage: bash media/convert.sh /path/to/video.mp4 [output.y4m] [width] [fps]" >&2
  exit 1
fi

if [[ ! -f "$SRC" ]]; then
  echo "Error: source file not found: $SRC" >&2
  exit 1
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "Error: ffmpeg not installed. On macOS:  brew install ffmpeg" >&2
  echo "  (or use the cross-platform bundled converter: npm run convert -- \"$SRC\")" >&2
  exit 1
fi

# Destination folder
mkdir -p "$(dirname "$OUT")"

echo "Converting: $SRC -> $OUT  (width=$WIDTH, fps=$FPS, pix_fmt=yuv420p)"
# -an: no audio (the video flag doesn't use it). scale keeps aspect ratio (auto even height).
ffmpeg -y -i "$SRC" \
  -pix_fmt yuv420p \
  -vf "scale=${WIDTH}:-2" \
  -r "$FPS" \
  -an \
  "$OUT"

SIZE=$(du -h "$OUT" | cut -f1)
echo "Done. Created $OUT ($SIZE). Set \"webcamVideo\" in config.json if you used a different name."
