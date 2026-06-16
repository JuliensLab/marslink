#!/usr/bin/env bash
# Build a deploy/ directory containing only the files that should be uploaded
# to Hosting24. Run from the repo root:
#
#   ./deploy.sh
#
# Then FTP / SFTP / file-manager-upload the entire deploy/ folder contents
# (NOT the deploy/ folder itself) into your public_html on Hosting24.
#
# This is intentionally conservative — it copies only what the live site
# needs. Add or remove paths in the INCLUDE list below if you change the
# site's structure.
#
# Re-running is safe; deploy/ is wiped each time.

set -euo pipefail

cd "$(dirname "$0")"

DEST="deploy"

echo "→ Cleaning $DEST/"
rm -rf "$DEST"
mkdir -p "$DEST"

# Files / dirs to ship. Everything else is excluded by default.
INCLUDE=(
    "index.html"
    "styles.css"
    ".htaccess"
    "scripts"
    "img"
    "model3d"
    "api"
)

for path in "${INCLUDE[@]}"; do
    if [[ ! -e "$path" ]]; then
        echo "  ⚠  skipping $path (not found)"
        continue
    fi
    echo "  + $path"
    # -a preserves timestamps; we re-create dirs so dotfiles (.htaccess) come along.
    cp -aR "$path" "$DEST/"
done

# Strip dev-only artifacts that may live inside copied directories.
echo "→ Pruning dev artifacts from $DEST/"
find "$DEST" -name ".DS_Store" -delete 2>/dev/null || true
find "$DEST" -name "Thumbs.db" -delete 2>/dev/null || true
find "$DEST" -name "*.map" -delete 2>/dev/null || true

# Belt-and-braces: never ship the test PHPs (they embed the live API key).
rm -f "$DEST/test_lambert.php" "$DEST/test_nyx.php" "$DEST/lambert-test.html"

# Sanity check: the deploy bundle MUST contain config.local.php (the auth
# hash + API key). If it's missing, the API will return auth_not_configured.
if [[ ! -f "$DEST/api/nyx/config.local.php" ]]; then
    echo
    echo "❌  $DEST/api/nyx/config.local.php is missing — your API will be locked"
    echo "    out. Make sure config.local.php exists in api/nyx/ before deploying."
    exit 1
fi

# Quick visual summary.
echo
echo "→ Bundle size:"
du -sh "$DEST"
echo
echo "→ Top-level contents of $DEST/:"
ls -la "$DEST" | tail -n +2

echo
echo "✓ Done. Upload the CONTENTS of $DEST/ into your Hosting24 public_html."
