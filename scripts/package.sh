#!/bin/sh
# Builds the zip for the Chrome Web Store. The store won't take a "key" in the
# manifest (it assigns its own id), so it's stripped here; once the listing
# exists, add the store id to allowed_origins in scripts/install.sh.
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
out="$root/dist"
rm -rf "$out/extension" && mkdir -p "$out"
cp -R "$root/extension" "$out/extension"
node -e '
const fs = require("fs"); const p = process.argv[1];
const m = JSON.parse(fs.readFileSync(p, "utf8")); delete m.key;
fs.writeFileSync(p, JSON.stringify(m, null, 2) + "\n");
' "$out/extension/manifest.json"
version=$(node -p 'require(process.argv[1]).version' "$out/extension/manifest.json")
rm -f "$out/paws-$version.zip"
(cd "$out/extension" && zip -qr -X "../paws-$version.zip" . -x '.DS_Store')
echo "$out/paws-$version.zip"
