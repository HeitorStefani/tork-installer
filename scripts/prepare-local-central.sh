#!/usr/bin/env sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
DIST_DIR="${DIST_DIR:-$ROOT_DIR/dist}"
DB_PATH="${TORK_CENTRAL_DB:-$ROOT_DIR/central/data/central-db.json}"
ADMIN_TOKEN_FILE="${ADMIN_TOKEN_FILE:-$ROOT_DIR/central/data/admin-token.txt}"
PORT="${TORK_CENTRAL_PORT:-8095}"
HOST="${TORK_CENTRAL_HOST:-0.0.0.0}"

mkdir -p "$(dirname "$DB_PATH")"

"$ROOT_DIR/scripts/build-installer-package.sh"

if [ ! -f "$ADMIN_TOKEN_FILE" ]; then
  node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))" > "$ADMIN_TOKEN_FILE"
  chmod 600 "$ADMIN_TOKEN_FILE"
fi

ADMIN_TOKEN="$(cat "$ADMIN_TOKEN_FILE")"

cat > "$ROOT_DIR/central/start-local-central.sh" <<EOF
#!/usr/bin/env sh
set -eu
cd "$ROOT_DIR"
export TORK_CENTRAL_ADMIN_TOKEN='$ADMIN_TOKEN'
export TORK_CENTRAL_DB='$DB_PATH'
export TORK_PUBLIC_FILES_DIR='$DIST_DIR'
export TORK_CENTRAL_PORT='$PORT'
export TORK_CENTRAL_HOST='$HOST'
node central/src/server.mjs
EOF
chmod +x "$ROOT_DIR/central/start-local-central.sh"

cat > "$ROOT_DIR/central/local-central.env" <<EOF
TORK_CENTRAL_ADMIN_TOKEN=$ADMIN_TOKEN
TORK_CENTRAL_DB=$DB_PATH
TORK_PUBLIC_FILES_DIR=$DIST_DIR
TORK_CENTRAL_PORT=$PORT
TORK_CENTRAL_HOST=$HOST
EOF
chmod 600 "$ROOT_DIR/central/local-central.env"

cat > "$ROOT_DIR/central/LOCAL_CENTRAL_READY.txt" <<EOF
Central local preparada.

Para iniciar quando quiser:

  $ROOT_DIR/central/start-local-central.sh

URLs locais:

  http://127.0.0.1:$PORT/health
  http://127.0.0.1:$PORT/install.sh
  http://127.0.0.1:$PORT/tork-package.tgz

Token admin salvo em:

  $ADMIN_TOKEN_FILE

Variaveis salvas em:

  $ROOT_DIR/central/local-central.env
EOF

printf '%s\n' "Central local preparada."
printf '%s\n' "Start: $ROOT_DIR/central/start-local-central.sh"
printf '%s\n' "Dist:  $DIST_DIR"
printf '%s\n' "Token: $ADMIN_TOKEN_FILE"
