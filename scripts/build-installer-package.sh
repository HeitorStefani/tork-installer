#!/usr/bin/env sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
DIST_DIR="${DIST_DIR:-$ROOT_DIR/dist}"
PACKAGE_NAME="${PACKAGE_NAME:-tork-package.tgz}"

rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR/package"

cp "$ROOT_DIR/install.sh" "$DIST_DIR/install.sh"
chmod +x "$DIST_DIR/install.sh"

cp -R "$ROOT_DIR/cli" "$DIST_DIR/package/cli"
cp -R "$ROOT_DIR/manifests" "$DIST_DIR/package/manifests"
cp -R "$ROOT_DIR/templates" "$DIST_DIR/package/templates"
[ -d "$ROOT_DIR/backend" ] && cp -R "$ROOT_DIR/backend" "$DIST_DIR/package/backend"
[ -d "$ROOT_DIR/frontend" ] && cp -R "$ROOT_DIR/frontend" "$DIST_DIR/package/frontend"
if [ -d "$ROOT_DIR/central/src" ]; then
  mkdir -p "$DIST_DIR/package/central"
  cp -R "$ROOT_DIR/central/src" "$DIST_DIR/package/central/src"
fi
[ -d "$ROOT_DIR/docs" ] && cp -R "$ROOT_DIR/docs" "$DIST_DIR/package/docs"

tar -C "$DIST_DIR/package" -czf "$DIST_DIR/$PACKAGE_NAME" .
rm -rf "$DIST_DIR/package"

(
  cd "$DIST_DIR"
  shasum -a 256 install.sh > install.sh.sha256
  shasum -a 256 "$PACKAGE_NAME" > "$PACKAGE_NAME.sha256"
)

printf '%s\n' "Pacote gerado em $DIST_DIR"
printf '%s\n' "- $DIST_DIR/install.sh"
printf '%s\n' "- $DIST_DIR/install.sh.sha256"
printf '%s\n' "- $DIST_DIR/$PACKAGE_NAME"
printf '%s\n' "- $DIST_DIR/$PACKAGE_NAME.sha256"
