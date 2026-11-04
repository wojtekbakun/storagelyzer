#!/usr/bin/env bash
# Builds the app's interface, with its in-browser demo backend, into docs/demo for the
# website. Plain browsers get generated demo data; the page opens it with
#   demo/?shot&scan=/                                       a generated Macintosh HD
#   demo/?shot&snapshot=../media/web/system-library.json    a real scan (examples/snapshot.rs)
set -euo pipefail
cd "$(dirname "$0")/.."

npx vite build --base ./ --outDir docs/demo --emptyOutDir --logLevel warn
# Opened on its own on a phone, show the whole desktop window scaled down.
sed -i '' \
  -e 's|<meta name="viewport"[^>]*>|<meta name="viewport" content="width=1240">|' \
  -e 's|<title>Storagelyzer</title>|<title>Storagelyzer demo</title>|' \
  docs/demo/index.html
du -sh docs/demo
