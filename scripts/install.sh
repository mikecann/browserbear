#!/bin/sh
# Registers the Paws native host with Chrome (for every profile at once: hosts
# are per Chrome install, not per profile) and puts `paws` on your PATH.
# The extension itself is loaded per profile; see the README.
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
home="$HOME/Library/Application Support/Paws"
hosts="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
node=$(command -v node)
# Two ids may talk to the host: the Chrome Web Store build, and an unpacked
# checkout (its id comes from the "key" in the manifest, so it's the same
# everywhere).
store_id=cdoogjjahnadjnjpikbmcidkilpdcbnn
dev_id=iljcldkflmlnmfhbllafbbfnchhoccok

mkdir -p "$home" "$hosts" "$HOME/.local/bin"
chmod 700 "$home"

# Chrome starts the host with a bare environment, so pin node's full path.
cat > "$home/paws-host" <<EOF
#!/bin/sh
exec "$node" "$root/host/paws-host.mjs" "\$@"
EOF
chmod 755 "$home/paws-host"

cat > "$hosts/dev.paws.host.json" <<EOF
{
  "name": "dev.paws.host",
  "description": "Paws: lets local AI agents use this Chrome profile",
  "path": "$home/paws-host",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$store_id/", "chrome-extension://$dev_id/"]
}
EOF

# --store: have Chrome offer the Web Store build in every profile, new ones too
# (each asks once, "keep it?"). The same mechanism Google Drive's launcher uses.
if [ "${1:-}" = "--store" ]; then
  ext="$HOME/Library/Application Support/Google/Chrome/External Extensions"
  mkdir -p "$ext"
  printf '{"external_update_url": "https://clients2.google.com/service/update2/crx"}\n' > "$ext/$store_id.json"
  echo "Chrome will offer Paws in every profile next time it starts."
fi

ln -sf "$root/cli.mjs" "$HOME/.local/bin/paws"
chmod 755 "$root/cli.mjs"
echo "Installed. Native host: $hosts/dev.paws.host.json"
[ "${1:-}" = "--store" ] || echo "Add the extension to each profile: rerun with --store once the Web Store listing is live, or load $root/extension unpacked (chrome://extensions, Developer mode, Load unpacked)."
