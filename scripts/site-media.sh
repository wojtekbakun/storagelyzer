#!/usr/bin/env bash
# Makes the website's videos from the README GIFs (run `npm run media` first if the GIFs changed).
# MP4 is about a tenth of the GIF's size; the JPG is the still shown before the video loads
# and to visitors who turned on Reduce Motion.
set -euo pipefail
cd "$(dirname "$0")/.."

src=docs/media
out=docs/media/web
mkdir -p "$out"

for name in scan explore tree size cleanup; do
  ffmpeg -v error -y -i "$src/$name.gif" \
    -vf "scale=trunc(iw/2)*2:trunc(ih/2)*2" -pix_fmt yuv420p \
    -c:v libx264 -preset slow -tune animation -crf 20 -movflags +faststart -an \
    "$out/$name.mp4"
  # The still: the last frame, where each recording ends on its finished state; "explore" ends
  # zoomed out, so it uses the moment the hover labels are up.
  case "$name" in
    explore) at=(-ss 3) ;;
    *) at=(-sseof -0.1) ;;
  esac
  ffmpeg -v error -y "${at[@]}" -i "$out/$name.mp4" -frames:v 1 -update 1 -q:v 3 "$out/$name.jpg"
  printf "%-8s mp4 %5s KB   jpg %4s KB\n" "$name" \
    "$(( $(stat -f %z "$out/$name.mp4") / 1024 ))" "$(( $(stat -f %z "$out/$name.jpg") / 1024 ))"
done
