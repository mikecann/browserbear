#!/bin/sh
# Registers the Paws native host with Chrome (for every profile at once: hosts
# are per Chrome install, not per profile) and puts `paws` on your PATH.
# The extension itself is loaded per profile; see the README.
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
home="$HOME/Library/Application Support/Paws"
hosts="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
node=$(command -v node)
# The id comes from the "key" in the manifest, so it's the same everywhere.
ext_id=iljcldkflmlnmfhbllafbbfnchhoccok

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
  "allowed_origins": ["chrome-extension://$ext_id/"]
}
EOF

ln -sf "$root/cli.mjs" "$HOME/.local/bin/paws"
chmod 755 "$root/cli.mjs"
echo "Installed. Native host: $hosts/dev.paws.host.json"
echo "Now load $root/extension unpacked in each Chrome profile (chrome://extensions, Developer mode, Load unpacked)."
