#!/bin/sh
# Registers the BrowserBear native host with Chrome (for every profile at once: hosts
# are per Chrome install, not per profile) and puts `browserbear` on your PATH.
# The extension itself is loaded per profile; see the README.
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
home="$HOME/Library/Application Support/BrowserBear"
hosts="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
node=$(command -v node)
# Two ids may talk to the host: the Chrome Web Store build, and an unpacked
# checkout (its id comes from the "key" in the manifest, so it's the same
# everywhere).
store_id=cdoogjjahnadjnjpikbmcidkilpdcbnn
dev_id=iljcldkflmlnmfhbllafbbfnchhoccok

# This was called Paws until 30 Oct 2026: carry its folder (logs, saved
# screenshots) over, and drop the old command.
old="$HOME/Library/Application Support/Paws"
if [ -d "$old" ] && [ ! -e "$home" ]; then
  mv "$old" "$home"
  rm -f "$home/paws-host" "$home/paws.sock"
fi
rm -f "$HOME/.local/bin/paws"

mkdir -p "$home" "$hosts" "$HOME/.local/bin"
chmod 700 "$home"

# Chrome starts the host with a bare environment, so pin node's full path.
cat > "$home/browserbear-host" <<EOF
#!/bin/sh
exec "$node" "$root/host/browserbear-host.mjs" "\$@"
EOF
chmod 755 "$home/browserbear-host"

cat > "$hosts/dev.browserbear.host.json" <<EOF
{
  "name": "dev.browserbear.host",
  "description": "BrowserBear: lets local AI agents use this Chrome profile",
  "path": "$home/browserbear-host",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$store_id/", "chrome-extension://$dev_id/"]
}
EOF
# Store build 0.1.2 went out as Paws and asks for the old host name. Keep
# answering to it until a BrowserBear build has replaced it in the store.
sed 's/"dev.browserbear.host"/"dev.paws.host"/' "$hosts/dev.browserbear.host.json" > "$hosts/dev.paws.host.json"

# --store: have Chrome offer the Web Store build in every profile, new ones too
# (each asks once, "keep it?"). The same mechanism Google Drive's launcher uses.
if [ "${1:-}" = "--store" ]; then
  ext="$HOME/Library/Application Support/Google/Chrome/External Extensions"
  mkdir -p "$ext"
  printf '{"external_update_url": "https://clients2.google.com/service/update2/crx"}\n' > "$ext/$store_id.json"
  echo "Chrome will offer BrowserBear in every profile next time it starts."
fi

ln -sf "$root/cli.mjs" "$HOME/.local/bin/browserbear"
chmod 755 "$root/cli.mjs"
echo "Installed. Native host: $hosts/dev.browserbear.host.json"
[ "${1:-}" = "--store" ] || echo "Add the extension to each profile: rerun with --store once the Web Store listing is live, or load $root/extension unpacked (chrome://extensions, Developer mode, Load unpacked)."
