#!/usr/bin/env sh
set -eu

TORK_HOME="${TORK_HOME:-${TORK_INSTALL_DIR:-/opt/tork-automation}}"
BIN_DIR="${BIN_DIR:-/usr/local/bin}"
TORK_STACKS="${TORK_STACKS:-full}"
TORK_ASSUME_YES="${TORK_ASSUME_YES:-1}"
TORK_SKIP_DEPENDENCIES="${TORK_SKIP_DEPENDENCIES:-0}"
TORK_SKIP_STACK_INSTALL="${TORK_SKIP_STACK_INSTALL:-0}"
TORK_BOOTSTRAP_ONLY="${TORK_BOOTSTRAP_ONLY:-0}"
TORK_DRY_RUN="${TORK_DRY_RUN:-0}"
TORK_SEND_HEARTBEAT="${TORK_SEND_HEARTBEAT:-1}"
TORK_NO_SUDO="${TORK_NO_SUDO:-0}"
TORK_OPEN_MENU="${TORK_OPEN_MENU:-1}"
TORK_COMPOSE_VERSION="${TORK_COMPOSE_VERSION:-v2.39.4}"
TORK_GITHUB_REF="${TORK_GITHUB_REF:-main}"

SOURCE_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
TMP_DIR=""

log() {
  printf '%s\n' "==> $*" >&2
}

warn() {
  printf '%s\n' "WARN: $*" >&2
}

fail() {
  printf '%s\n' "ERRO: $*" >&2
  exit 1
}

as_root() {
  if [ "$(id -u)" = "0" ]; then
    "$@"
  elif [ "$TORK_NO_SUDO" = "1" ]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    fail "Rode como root ou instale sudo."
  fi
}

cleanup() {
  if [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ]; then
    rm -rf "$TMP_DIR"
  fi
}
trap cleanup EXIT INT TERM

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

github_download() {
  url="$1"
  output="$2"
  if [ -n "${TORK_GITHUB_TOKEN:-}" ]; then
    curl -fsSL -H "Authorization: Bearer $TORK_GITHUB_TOKEN" "$url" -o "$output"
  else
    curl -fsSL "$url" -o "$output"
  fi
}

node_major() {
  if ! command_exists node; then
    printf '0'
    return
  fi
  node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1
}

detect_apt() {
  command_exists apt-get
}

install_apt_base() {
  log "Instalando pacotes base"
  as_root apt-get update
  as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y \
    ca-certificates \
    curl \
    git \
    tar \
    gzip \
    openssl
}

install_node() {
  if [ "$(node_major)" -ge 20 ] 2>/dev/null; then
    log "Node.js $(node -v) encontrado"
    return
  fi

  log "Instalando Node.js 20"
  if detect_apt; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | as_root bash -
    as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
  else
    fail "Sistema sem apt-get. Instale Node.js 20+ manualmente."
  fi
}

install_docker() {
  if command_exists docker && docker compose version >/dev/null 2>&1; then
    log "Docker e Docker Compose encontrados"
    return
  fi

  log "Instalando Docker"
  if detect_apt; then
    as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io
    if ! as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y docker-compose-plugin; then
      install_compose_plugin_binary
    fi
    as_root systemctl enable --now docker >/dev/null 2>&1 || true
  else
    fail "Sistema sem apt-get. Instale Docker e docker compose manualmente."
  fi

  if ! docker compose version >/dev/null 2>&1; then
    install_compose_plugin_binary
  fi
}

compose_arch() {
  arch="$(uname -m)"
  case "$arch" in
    x86_64|amd64) printf '%s\n' "x86_64" ;;
    aarch64|arm64) printf '%s\n' "aarch64" ;;
    *) fail "Arquitetura sem Docker Compose automatico: $arch" ;;
  esac
}

install_compose_plugin_binary() {
  arch="$(compose_arch)"
  plugin_dir="/usr/local/lib/docker/cli-plugins"
  plugin_path="$plugin_dir/docker-compose"
  url="https://github.com/docker/compose/releases/download/$TORK_COMPOSE_VERSION/docker-compose-linux-$arch"
  log "Instalando Docker Compose $TORK_COMPOSE_VERSION ($arch)"
  as_root mkdir -p "$plugin_dir"
  curl -fsSL "$url" -o /tmp/tork-docker-compose
  as_root install -m 0755 /tmp/tork-docker-compose "$plugin_path"
  rm -f /tmp/tork-docker-compose
}

verify_checksum_file() {
  checksum_file="$1"
  if command_exists sha256sum; then
    sha256sum -c "$checksum_file"
    return
  fi
  if command_exists shasum; then
    shasum -a 256 -c "$checksum_file"
    return
  fi
  fail "Nao encontrei sha256sum nem shasum para validar checksum."
}

install_dependencies() {
  if [ "$TORK_SKIP_DEPENDENCIES" = "1" ]; then
    log "Pulando instalacao de dependencias"
    return
  fi

  if detect_apt; then
    install_apt_base
  else
    warn "apt-get nao encontrado; vou validar dependencias existentes."
  fi

  install_node
  install_docker
}

find_source_dir() {
  if [ -d "$SOURCE_DIR/cli" ] && [ -d "$SOURCE_DIR/manifests" ] && [ -d "$SOURCE_DIR/templates" ]; then
    printf '%s\n' "$SOURCE_DIR"
    return
  fi

  TMP_DIR="$(mktemp -d)"

  if [ -n "${TORK_PACKAGE_URL:-}" ]; then
    log "Baixando pacote $TORK_PACKAGE_URL"
    curl -fsSL "$TORK_PACKAGE_URL" -o "$TMP_DIR/tork-package.tgz"
    checksum_url="${TORK_PACKAGE_SHA256_URL:-$TORK_PACKAGE_URL.sha256}"
    log "Validando pacote com $checksum_url"
    curl -fsSL "$checksum_url" -o "$TMP_DIR/tork-package.tgz.sha256"
    (cd "$TMP_DIR" && verify_checksum_file "tork-package.tgz.sha256" >&2)
    tar -xzf "$TMP_DIR/tork-package.tgz" -C "$TMP_DIR"
    found="$(find "$TMP_DIR" -maxdepth 3 -type d -name cli 2>/dev/null | head -n 1 | xargs dirname)"
    [ -n "$found" ] && [ -d "$found/manifests" ] && [ -d "$found/templates" ] || fail "Pacote invalido: cli/manifests/templates nao encontrados."
    printf '%s\n' "$found"
    return
  fi

  if [ -n "${TORK_GITHUB_REPO:-}" ]; then
    archive_url="${TORK_GITHUB_ARCHIVE_URL:-https://codeload.github.com/$TORK_GITHUB_REPO/tar.gz/$TORK_GITHUB_REF}"
    log "Baixando codigo do GitHub: $TORK_GITHUB_REPO@$TORK_GITHUB_REF"
    github_download "$archive_url" "$TMP_DIR/tork-source.tgz"
    tar -xzf "$TMP_DIR/tork-source.tgz" -C "$TMP_DIR"
    found="$(find "$TMP_DIR" -maxdepth 4 -type d -name cli 2>/dev/null | head -n 1 | xargs dirname)"
    [ -n "$found" ] && [ -d "$found/manifests" ] && [ -d "$found/templates" ] || fail "Repositorio invalido: cli/manifests/templates nao encontrados."
    printf '%s\n' "$found"
    return
  fi

  if [ -n "${TORK_REPO_URL:-}" ]; then
    log "Clonando repositorio $TORK_REPO_URL"
    git clone --depth 1 "$TORK_REPO_URL" "$TMP_DIR/repo"
    printf '%s\n' "$TMP_DIR/repo"
    return
  fi

  fail "Nao encontrei os arquivos locais. Informe TORK_GITHUB_REPO, TORK_PACKAGE_URL ou TORK_REPO_URL."
}

copy_if_exists() {
  src="$1"
  dst="$2"
  if [ -e "$src" ]; then
    rm -rf "$dst"
    cp -R "$src" "$dst"
  fi
}

install_cli() {
  source_root="$1"
  log "Instalando tork-automation em $TORK_HOME"
  as_root mkdir -p "$TORK_HOME" "$BIN_DIR"
  copy_target="$(mktemp -d)"
  cp -R "$source_root/cli" "$copy_target/cli"
  cp -R "$source_root/manifests" "$copy_target/manifests"
  cp -R "$source_root/templates" "$copy_target/templates"
  [ -d "$source_root/backend" ] && cp -R "$source_root/backend" "$copy_target/backend"
  [ -d "$source_root/frontend" ] && cp -R "$source_root/frontend" "$copy_target/frontend"
  [ -d "$source_root/central" ] && cp -R "$source_root/central" "$copy_target/central"
  [ -d "$source_root/docs" ] && cp -R "$source_root/docs" "$copy_target/docs"

  as_root rm -rf "$TORK_HOME/cli" "$TORK_HOME/manifests" "$TORK_HOME/templates" "$TORK_HOME/backend" "$TORK_HOME/frontend" "$TORK_HOME/central" "$TORK_HOME/docs"
  as_root cp -R "$copy_target/cli" "$TORK_HOME/cli"
  as_root cp -R "$copy_target/manifests" "$TORK_HOME/manifests"
  as_root cp -R "$copy_target/templates" "$TORK_HOME/templates"
  [ -d "$copy_target/backend" ] && as_root cp -R "$copy_target/backend" "$TORK_HOME/backend"
  [ -d "$copy_target/frontend" ] && as_root cp -R "$copy_target/frontend" "$TORK_HOME/frontend"
  [ -d "$copy_target/central" ] && as_root cp -R "$copy_target/central" "$TORK_HOME/central"
  [ -d "$copy_target/docs" ] && as_root cp -R "$copy_target/docs" "$TORK_HOME/docs"
  rm -rf "$copy_target"

  wrapper_tmp="$(mktemp)"
  cat > "$wrapper_tmp" <<EOF
#!/usr/bin/env sh
exec node "$TORK_HOME/cli/tork-automation.mjs" "\$@"
EOF
  as_root cp "$wrapper_tmp" "$BIN_DIR/tork-automation"
  rm -f "$wrapper_tmp"
  as_root chmod +x "$BIN_DIR/tork-automation"
  log "Comando instalado: $BIN_DIR/tork-automation"
}

stack_args() {
  if [ "$TORK_STACKS" = "full" ]; then
    printf '%s\n' "--full"
    return
  fi
  printf '%s\n' "--stack"
  printf '%s\n' "$TORK_STACKS"
}

run_stack_install() {
  [ "$TORK_SKIP_STACK_INSTALL" = "1" ] && return
  [ "$TORK_BOOTSTRAP_ONLY" = "1" ] && return

  if [ -z "${TORK_INSTALL_KEY:-}" ] || [ -z "${TORK_CENTRAL_URL:-}" ]; then
    if [ "$TORK_OPEN_MENU" = "1" ] && [ -t 0 ]; then
      log "Abrindo painel de configuracao"
      "$BIN_DIR/tork-automation" wizard --installDir "$TORK_HOME"
      return
    fi
    log "Bootstrap concluido. Para abrir o painel, rode:"
    printf '%s\n' "tork-automation"
    printf '%s\n' "Ou instale direto:"
    printf '%s\n' "tork-automation install --key TORK-XXXX --centralUrl https://central.example.com --full --yes"
    return
  fi

  log "Instalando stack via central"
  set -- install \
    --key "$TORK_INSTALL_KEY" \
    --centralUrl "$TORK_CENTRAL_URL" \
    --installDir "$TORK_HOME"

  if [ "$TORK_ASSUME_YES" = "1" ]; then
    set -- "$@" --yes
  fi

  if [ "$TORK_DRY_RUN" = "1" ]; then
    set -- "$@" --dryRun
  fi

  for arg in $(stack_args); do
    set -- "$@" "$arg"
  done

  "$BIN_DIR/tork-automation" "$@"

  if [ "$TORK_DRY_RUN" != "1" ] && [ "$TORK_SEND_HEARTBEAT" = "1" ]; then
    "$BIN_DIR/tork-automation" heartbeat \
      --key "$TORK_INSTALL_KEY" \
      --centralUrl "$TORK_CENTRAL_URL" \
      --installDir "$TORK_HOME" || warn "Heartbeat inicial falhou; a instalacao pode ser reportada depois."
  fi
}

main() {
  log "Tork Automation bootstrap"
  install_dependencies
  source_root="$(find_source_dir)"
  install_cli "$source_root"
  "$BIN_DIR/tork-automation" version
  run_stack_install
  log "Pronto"
}

main "$@"
