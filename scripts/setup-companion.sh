#!/usr/bin/env bash
#
# Downloads the latest prebuilt idb_companion from lapfelix/idb GitHub Releases
# and installs it into this project's .companion/ directory.
#
# Usage: ./scripts/setup-companion.sh
#
set -euo pipefail

REPO="lapfelix/idb"
INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)/.companion"
ASSET_NAME="idb-companion.universal.tar.gz"

echo "Fetching latest release from $REPO..."
DOWNLOAD_URL=$(curl -sfL "https://api.github.com/repos/$REPO/releases/latest" \
  | grep "browser_download_url.*${ASSET_NAME}" \
  | head -1 \
  | cut -d '"' -f 4)

if [ -z "$DOWNLOAD_URL" ]; then
  echo "Error: Could not find $ASSET_NAME in the latest release of $REPO."
  echo "Make sure a release exists at https://github.com/$REPO/releases"
  exit 1
fi

echo "Downloading $ASSET_NAME..."
TMPFILE=$(mktemp)
curl -fL "$DOWNLOAD_URL" -o "$TMPFILE"

echo "Installing to $INSTALL_DIR..."
rm -rf "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
tar -xzf "$TMPFILE" -C "$INSTALL_DIR"
rm -f "$TMPFILE"

chmod +x "$INSTALL_DIR/bin/idb_companion"

echo ""
echo "Done! idb_companion installed to $INSTALL_DIR"
echo ""
echo "The MCP server will automatically use it. No configuration needed."
