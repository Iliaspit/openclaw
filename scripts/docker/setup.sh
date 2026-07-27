#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"
COMPOSE_FILE="$ROOT_DIR/docker-compose.yml"
EXTRA_COMPOSE_FILE="$ROOT_DIR/docker-compose.extra.yml"
VERIFIER_COMPOSE_FILE="$ROOT_DIR/docker-compose.verifier.yml"
VERIFIER_PUBLISH_DOCKERFILE="$ROOT_DIR/Dockerfile.sandbox-verifier-publish"
SANDBOX_COMPOSE_FILE="$ROOT_DIR/docker-compose.sandbox.yml"
VERIFIER_STATE_DIR=""
VERIFIER_STATE_PATH=""
VERIFIER_STATE_DIR_DEV=""
VERIFIER_STATE_DIR_INO=""
VERIFIER_STATE_PARENT_PATH=""
VERIFIER_STATE_PARENT_DEV=""
VERIFIER_STATE_PARENT_INO=""
VERIFIER_STATE_MARKER_NAME=""
VERIFIER_STATE_MARKER_PHASE=""
VERIFIER_STATE_TOKEN_DIGEST=""
VERIFIER_OPERATION_BINDING=""
VERIFIER_STATE_IDENTITY_FAILED=""
VERIFIER_TRANSACTION_DIR=""
VERIFIER_TRANSACTION_DIR_DEV=""
VERIFIER_TRANSACTION_DIR_INO=""
VERIFIER_LOCK_DIR=""
VERIFIER_SOCKET_OVERLAY_READY=""
VERIFIER_RUNTIME_IMAGE_ID=""
VERIFIER_OLD_GATEWAY_ID=""
VERIFIER_OLD_GATEWAY_IMAGE_ID=""
VERIFIER_CONFIG_BACKUP_PRESENT="0"
VERIFIER_CONFIG_BACKUP_DIGEST=""
VERIFIER_CONFIG_BACKUP_MODE=""
VERIFIER_CONFIG_BACKUP_PARENT_DEV=""
VERIFIER_CONFIG_BACKUP_PARENT_INO=""
VERIFIER_OVERLAY_BACKUP_PRESENT="0"
VERIFIER_OVERLAY_BACKUP_DIGEST=""
VERIFIER_OVERLAY_BACKUP_MODE=""
VERIFIER_OVERLAY_BACKUP_PARENT_DEV=""
VERIFIER_OVERLAY_BACKUP_PARENT_INO=""
VERIFIER_ENV_BACKUP_DIGEST=""
VERIFIER_ENV_BACKUP_MODE=""
VERIFIER_ENV_BACKUP_PARENT_DEV=""
VERIFIER_ENV_BACKUP_PARENT_INO=""
VERIFIER_DOCKER_SOCKET_PATH=""
SOURCE_REVISION_WAS_EXPLICIT=""
if printenv OPENCLAW_SOURCE_REVISION >/dev/null 2>&1; then
  SOURCE_REVISION_WAS_EXPLICIT="1"
fi

load_persisted_setup_defaults() {
  local line=""
  local key=""
  local value=""
  local allowed=" OPENCLAW_IMAGE OPENCLAW_SANDBOX OPENCLAW_SOURCE_REVISION OPENCLAW_DOCKER_SOCKET "
  allowed+="OPENCLAW_VERIFIER_WORKSPACE_DIR OPENCLAW_VERIFIER_GATEWAY_WORKSPACE "
  allowed+="OPENCLAW_VERIFIER_PACKAGE_MANAGER OPENCLAW_VERIFIER_IMAGE_ID "
  allowed+="OPENCLAW_VERIFIER_ARTIFACT_DIGEST OPENCLAW_VERIFIER_DEPENDENCY_MANIFEST "
  allowed+="OPENCLAW_VERIFIER_BROWSER_MANIFEST OPENCLAW_VERIFIER_REPOSITORY_IDENTITY "
  allowed+="OPENCLAW_VERIFIER_BROWSER_IDENTITY OPENCLAW_VERIFIER_EFFECTIVE_YARN_VERSION "
  if [[ ! -f "$ENV_FILE" ]]; then
    return
  fi
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    key="${line%%=*}"
    value="${line#*=}"
    if [[ "$line" != *=* || "$allowed" != *" $key "* ]]; then
      continue
    fi
    if printenv "$key" >/dev/null 2>&1; then
      continue
    fi
    printf -v "$key" '%s' "$value"
    export "$key"
  done <"$ENV_FILE"
}

reload_verifier_shell_from_env() {
  VERIFIER_RUNTIME_READY=""
  unset \
    OPENCLAW_VERIFIER_IMAGE_ID \
    OPENCLAW_VERIFIER_ARTIFACT_DIGEST \
    OPENCLAW_VERIFIER_DEPENDENCY_MANIFEST \
    OPENCLAW_VERIFIER_BROWSER_MANIFEST \
    OPENCLAW_VERIFIER_REPOSITORY_IDENTITY \
    OPENCLAW_VERIFIER_BROWSER_IDENTITY \
    OPENCLAW_VERIFIER_EFFECTIVE_YARN_VERSION
  load_persisted_setup_defaults
  if [[ "${OPENCLAW_VERIFIER_IMAGE_ID:-}" =~ ^sha256:[a-f0-9]{64}$ &&
    "${OPENCLAW_VERIFIER_ARTIFACT_DIGEST:-}" =~ ^[a-f0-9]{64}$ &&
    "${OPENCLAW_VERIFIER_DEPENDENCY_MANIFEST:-}" =~ ^[a-f0-9]{64}$ &&
    "${OPENCLAW_VERIFIER_BROWSER_MANIFEST:-}" =~ ^[a-f0-9]{64}$ &&
    "${OPENCLAW_VERIFIER_REPOSITORY_IDENTITY:-}" =~ ^[a-f0-9]{64}$ &&
    "${OPENCLAW_VERIFIER_BROWSER_IDENTITY:-}" =~ ^[a-f0-9]{64}$ &&
    "${OPENCLAW_VERIFIER_EFFECTIVE_YARN_VERSION:-}" =~ ^[0-9]+\.[0-9]+\.[0-9]+([+-][A-Za-z0-9._-]+)?$ ]]; then
    VERIFIER_RUNTIME_READY="1"
  fi
}

# Explicit process values win. Missing values inherit the prior supported setup
# state before any defaults are derived, so verifier overlays cannot disappear
# merely because a rerun omitted their variables.
load_persisted_setup_defaults

IMAGE_NAME="${OPENCLAW_IMAGE:-openclaw:local}"
EXTRA_MOUNTS="${OPENCLAW_EXTRA_MOUNTS:-}"
HOME_VOLUME_NAME="${OPENCLAW_HOME_VOLUME:-}"
RAW_SANDBOX_SETTING="${OPENCLAW_SANDBOX:-}"
SANDBOX_ENABLED=""
RAW_BROWSER_INSTALL_SETTING="${OPENCLAW_INSTALL_BROWSER:-1}"
BROWSER_INSTALL_ENABLED=""
DOCKER_SOCKET_PATH="${OPENCLAW_DOCKER_SOCKET:-}"
TIMEZONE="${OPENCLAW_TZ:-}"
VERIFIER_ENABLED=""

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing dependency: $1" >&2
    exit 1
  fi
}

assert_clean_verifier_checkout() {
  local expected_revision="$1"
  local checkout_revision=""
  local checkout_status=""
  require_cmd git
  checkout_revision="$(git -C "$ROOT_DIR" rev-parse --verify 'HEAD^{commit}')"
  if [[ ! "$checkout_revision" =~ ^[a-f0-9]{40}$ ]]; then
    fail "Guarded verifier setup requires an exact local checkout HEAD."
  fi
  checkout_status="$(git -C "$ROOT_DIR" status --porcelain=v1 --untracked-files=all)"
  if [[ -n "$checkout_status" ]]; then
    fail "Guarded verifier images require a clean local OpenClaw checkout."
  fi
  if [[ "$expected_revision" != "$checkout_revision" ]]; then
    fail "Guarded verifier image revision does not match the clean local checkout HEAD."
  fi
}

run_docker_build() {
  # Dockerfile uses BuildKit-only syntax (RUN --mount=type=cache). Force
  # BuildKit so hosts defaulting to the legacy builder do not fail.
  DOCKER_BUILDKIT=1 docker build "$@"
}

is_truthy_value() {
  local raw="${1:-}"
  raw="$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]')"
  case "$raw" in
    1 | true | yes | on) return 0 ;;
    *) return 1 ;;
  esac
}

read_config_gateway_token() {
  local config_path="$OPENCLAW_CONFIG_DIR/openclaw.json"
  if [[ ! -f "$config_path" ]]; then
    return 0
  fi
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$config_path" <<'PY'
import json
import sys

path = sys.argv[1]
try:
    with open(path, "r", encoding="utf-8") as f:
        cfg = json.load(f)
except Exception:
    raise SystemExit(0)

gateway = cfg.get("gateway")
if not isinstance(gateway, dict):
    raise SystemExit(0)
auth = gateway.get("auth")
if not isinstance(auth, dict):
    raise SystemExit(0)
token = auth.get("token")
if isinstance(token, str):
    token = token.strip()
    if token:
        print(token)
PY
    return 0
  fi
  if command -v node >/dev/null 2>&1; then
    node - "$config_path" <<'NODE'
const fs = require("node:fs");
const configPath = process.argv[2];
try {
  const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const token = cfg?.gateway?.auth?.token;
  if (typeof token === "string" && token.trim().length > 0) {
    process.stdout.write(token.trim());
  }
} catch {
  // Keep docker-setup resilient when config parsing fails.
}
NODE
  fi
}

read_env_gateway_token() {
  local env_path="$1"
  local line=""
  local token=""
  if [[ ! -f "$env_path" ]]; then
    return 0
  fi
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    if [[ "$line" == OPENCLAW_GATEWAY_TOKEN=* ]]; then
      token="${line#OPENCLAW_GATEWAY_TOKEN=}"
    fi
  done <"$env_path"
  if [[ -n "$token" ]]; then
    printf '%s' "$token"
  fi
}

sync_gateway_config() {
  local allowed_origin_json=""
  local current_allowed_origins=""
  local batch_json=""

  if [[ "${OPENCLAW_GATEWAY_BIND}" != "loopback" ]]; then
    allowed_origin_json="$(printf '["http://localhost:%s","http://127.0.0.1:%s"]' "$OPENCLAW_GATEWAY_PORT" "$OPENCLAW_GATEWAY_PORT")"
    current_allowed_origins="$(
      run_prestart_cli config get gateway.controlUi.allowedOrigins 2>/dev/null || true
    )"
    current_allowed_origins="${current_allowed_origins//$'\r'/}"
  fi

  batch_json="$(printf '[{"path":"gateway.mode","value":"local"},{"path":"gateway.bind","value":"%s"}' "$OPENCLAW_GATEWAY_BIND")"
  if [[ -n "$allowed_origin_json" ]]; then
    if [[ -n "$current_allowed_origins" && "$current_allowed_origins" != "null" && "$current_allowed_origins" != "[]" ]]; then
      echo "Control UI allowlist already configured; leaving gateway.controlUi.allowedOrigins unchanged."
    else
      batch_json+=",{\"path\":\"gateway.controlUi.allowedOrigins\",\"value\":$allowed_origin_json}"
    fi
  fi
  batch_json+="]"

  run_prestart_cli config set --batch-json "$batch_json" >/dev/null
  echo "Pinned gateway.mode=local and gateway.bind=$OPENCLAW_GATEWAY_BIND for Docker setup."
  if [[ -n "$allowed_origin_json" ]]; then
    if [[ -z "$current_allowed_origins" || "$current_allowed_origins" == "null" || "$current_allowed_origins" == "[]" ]]; then
      echo "Set gateway.controlUi.allowedOrigins to $allowed_origin_json for non-loopback bind."
    fi
  fi
}

run_prestart_gateway() {
  docker compose "${COMPOSE_ARGS[@]}" run --rm --no-deps "$@"
}

run_prestart_cli() {
  # During setup, avoid the shared-network openclaw-cli service because it
  # requires the gateway container's network namespace to already exist. That
  # creates a circular dependency for config writes that are needed before the
  # gateway can start cleanly.
  run_prestart_gateway --entrypoint node openclaw-gateway \
    dist/index.js "$@"
}

run_runtime_cli() {
  local compose_scope="${1:-current}"
  local deps_mode="${2:-with-deps}"
  shift 2

  local -a compose_args
  local -a run_args=(run --rm)

  case "$compose_scope" in
    current) compose_args=("${COMPOSE_ARGS[@]}") ;;
    base) compose_args=("${BASE_COMPOSE_ARGS[@]}") ;;
    *) fail "Unknown runtime CLI compose scope: $compose_scope" ;;
  esac

  case "$deps_mode" in
    with-deps) ;;
    no-deps) run_args+=(--no-deps) ;;
    *) fail "Unknown runtime CLI deps mode: $deps_mode" ;;
  esac

  docker compose "${compose_args[@]}" "${run_args[@]}" openclaw-cli "$@"
}

contains_disallowed_chars() {
  local value="$1"
  [[ "$value" == *$'\n'* || "$value" == *$'\r'* || "$value" == *$'\t'* ]]
}

is_valid_timezone() {
  local value="$1"
  [[ -e "/usr/share/zoneinfo/$value" && ! -d "/usr/share/zoneinfo/$value" ]]
}

validate_mount_path_value() {
  local label="$1"
  local value="$2"
  if [[ -z "$value" ]]; then
    fail "$label cannot be empty."
  fi
  if contains_disallowed_chars "$value"; then
    fail "$label contains unsupported control characters."
  fi
  if [[ "$value" =~ [[:space:]] ]]; then
    fail "$label cannot contain whitespace."
  fi
}

validate_named_volume() {
  local value="$1"
  if [[ ! "$value" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]]; then
    fail "OPENCLAW_HOME_VOLUME must match [A-Za-z0-9][A-Za-z0-9_.-]* when using a named volume."
  fi
}

validate_mount_spec() {
  local mount="$1"
  if contains_disallowed_chars "$mount"; then
    fail "OPENCLAW_EXTRA_MOUNTS entries cannot contain control characters."
  fi
  # Keep mount specs strict to avoid YAML structure injection.
  # Expected format: source:target[:options]
  if [[ ! "$mount" =~ ^[^[:space:],:]+:[^[:space:],:]+(:[^[:space:],:]+)?$ ]]; then
    fail "Invalid mount format '$mount'. Expected source:target[:options] without spaces."
  fi
}

require_cmd docker
if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose not available (try: docker compose version)" >&2
  exit 1
fi

if [[ -z "$DOCKER_SOCKET_PATH" && "${DOCKER_HOST:-}" == unix://* ]]; then
  DOCKER_SOCKET_PATH="${DOCKER_HOST#unix://}"
fi
if [[ -z "$DOCKER_SOCKET_PATH" ]]; then
  DOCKER_SOCKET_PATH="/var/run/docker.sock"
fi
if is_truthy_value "$RAW_SANDBOX_SETTING"; then
  SANDBOX_ENABLED="1"
fi
if is_truthy_value "$RAW_BROWSER_INSTALL_SETTING"; then
  BROWSER_INSTALL_ENABLED="1"
fi

OPENCLAW_CONFIG_DIR="${OPENCLAW_CONFIG_DIR:-$HOME/.openclaw}"
OPENCLAW_WORKSPACE_DIR="${OPENCLAW_WORKSPACE_DIR:-$HOME/.openclaw/workspace}"
VERIFIER_STATE_DIR="${OPENCLAW_VERIFIER_STATE_ROOT:-${XDG_STATE_HOME:-$HOME/.local/state}/openclaw/verifier}"
VERIFIER_TRANSACTION_DIR="$VERIFIER_STATE_DIR/transaction"
VERIFIER_LOCK_DIR="$VERIFIER_STATE_DIR/lock"

verifier_values=0
for verifier_value in \
  "${OPENCLAW_VERIFIER_WORKSPACE_DIR:-}" \
  "${OPENCLAW_VERIFIER_GATEWAY_WORKSPACE:-}" \
  "${OPENCLAW_VERIFIER_PACKAGE_MANAGER:-}"; do
  if [[ -n "$verifier_value" ]]; then
    verifier_values=$((verifier_values + 1))
  fi
done
if [[ "$verifier_values" -ne 0 && "$verifier_values" -ne 3 ]]; then
  fail "Guarded verifier setup requires workspace, Gateway workspace, and package manager together."
fi
if [[ "$verifier_values" -eq 3 ]]; then
  VERIFIER_ENABLED="1"
  if [[ -z "$SANDBOX_ENABLED" ]]; then
    fail "Guarded verifier setup requires OPENCLAW_SANDBOX=1."
  fi
  validate_mount_path_value "OPENCLAW_VERIFIER_WORKSPACE_DIR" "$OPENCLAW_VERIFIER_WORKSPACE_DIR"
  validate_mount_path_value "OPENCLAW_VERIFIER_GATEWAY_WORKSPACE" "$OPENCLAW_VERIFIER_GATEWAY_WORKSPACE"
  if [[ ! "$OPENCLAW_VERIFIER_PACKAGE_MANAGER" =~ ^yarn@[0-9]+\.[0-9]+\.[0-9]+([+-][A-Za-z0-9._-]+)?$ ]]; then
    fail "OPENCLAW_VERIFIER_PACKAGE_MANAGER must be one exact pinned Yarn version."
  fi
  published_values=0
  for published_value in \
    "${OPENCLAW_VERIFIER_IMAGE_ID:-}" \
    "${OPENCLAW_VERIFIER_ARTIFACT_DIGEST:-}" \
    "${OPENCLAW_VERIFIER_DEPENDENCY_MANIFEST:-}" \
    "${OPENCLAW_VERIFIER_BROWSER_MANIFEST:-}" \
    "${OPENCLAW_VERIFIER_REPOSITORY_IDENTITY:-}" \
    "${OPENCLAW_VERIFIER_BROWSER_IDENTITY:-}" \
    "${OPENCLAW_VERIFIER_EFFECTIVE_YARN_VERSION:-}"; do
    if [[ -n "$published_value" ]]; then
      published_values=$((published_values + 1))
    fi
  done
  if [[ "$published_values" -ne 0 && "$published_values" -ne 7 ]]; then
    fail "Guarded verifier published toolchain identity is incomplete."
  fi
  if [[ "$published_values" -eq 7 ]]; then
    if [[ ! "$OPENCLAW_VERIFIER_IMAGE_ID" =~ ^sha256:[a-f0-9]{64}$ ]] ||
      [[ ! "$OPENCLAW_VERIFIER_ARTIFACT_DIGEST" =~ ^[a-f0-9]{64}$ ]] ||
      [[ ! "$OPENCLAW_VERIFIER_DEPENDENCY_MANIFEST" =~ ^[a-f0-9]{64}$ ]] ||
      [[ ! "$OPENCLAW_VERIFIER_BROWSER_MANIFEST" =~ ^[a-f0-9]{64}$ ]] ||
      [[ ! "$OPENCLAW_VERIFIER_REPOSITORY_IDENTITY" =~ ^[a-f0-9]{64}$ ]] ||
      [[ ! "$OPENCLAW_VERIFIER_BROWSER_IDENTITY" =~ ^[a-f0-9]{64}$ ]] ||
      [[ ! "$OPENCLAW_VERIFIER_EFFECTIVE_YARN_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([+-][A-Za-z0-9._-]+)?$ ]]; then
      fail "Guarded verifier published toolchain identity is malformed."
    fi
    VERIFIER_RUNTIME_READY="1"
  fi
  if [[ ! -f "$VERIFIER_COMPOSE_FILE" ]]; then
    fail "Guarded verifier Compose contract is missing: $VERIFIER_COMPOSE_FILE"
  fi
  if [[ ! -f "$ROOT_DIR/Dockerfile.sandbox-verifier" ]]; then
    fail "Guarded verifier Dockerfile is missing."
  fi
  if [[ ! -f "$VERIFIER_PUBLISH_DOCKERFILE" ]]; then
    fail "Guarded verifier publication Dockerfile is missing: $VERIFIER_PUBLISH_DOCKERFILE"
  fi
fi

validate_mount_path_value "OPENCLAW_CONFIG_DIR" "$OPENCLAW_CONFIG_DIR"
validate_mount_path_value "OPENCLAW_WORKSPACE_DIR" "$OPENCLAW_WORKSPACE_DIR"
if [[ -n "$HOME_VOLUME_NAME" ]]; then
  if [[ "$HOME_VOLUME_NAME" == *"/"* ]]; then
    validate_mount_path_value "OPENCLAW_HOME_VOLUME" "$HOME_VOLUME_NAME"
  else
    validate_named_volume "$HOME_VOLUME_NAME"
  fi
fi
if contains_disallowed_chars "$EXTRA_MOUNTS"; then
  fail "OPENCLAW_EXTRA_MOUNTS cannot contain control characters."
fi
if [[ -n "$SANDBOX_ENABLED" ]]; then
  validate_mount_path_value "OPENCLAW_DOCKER_SOCKET" "$DOCKER_SOCKET_PATH"
fi
if [[ -n "$TIMEZONE" ]]; then
  if contains_disallowed_chars "$TIMEZONE"; then
    fail "OPENCLAW_TZ contains unsupported control characters."
  fi
  if [[ ! "$TIMEZONE" =~ ^[A-Za-z0-9/_+\-]+$ ]]; then
    fail "OPENCLAW_TZ must be a valid IANA timezone string (e.g. Asia/Shanghai)."
  fi
  if ! is_valid_timezone "$TIMEZONE"; then
    fail "OPENCLAW_TZ must match a timezone in /usr/share/zoneinfo (e.g. Asia/Shanghai)."
  fi
fi

mkdir -p "$OPENCLAW_CONFIG_DIR"
mkdir -p "$OPENCLAW_WORKSPACE_DIR"
# Seed directory tree eagerly so bind mounts work even on Docker Desktop/Windows
# where the container (even as root) cannot create new host subdirectories.
mkdir -p "$OPENCLAW_CONFIG_DIR/identity"
mkdir -p "$OPENCLAW_CONFIG_DIR/agents/main/agent"
mkdir -p "$OPENCLAW_CONFIG_DIR/agents/main/sessions"

export OPENCLAW_CONFIG_DIR
export OPENCLAW_WORKSPACE_DIR
export OPENCLAW_GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
export OPENCLAW_BRIDGE_PORT="${OPENCLAW_BRIDGE_PORT:-18790}"
export OPENCLAW_GATEWAY_BIND="${OPENCLAW_GATEWAY_BIND:-lan}"
export OPENCLAW_IMAGE="$IMAGE_NAME"
export OPENCLAW_DOCKER_APT_PACKAGES="${OPENCLAW_DOCKER_APT_PACKAGES:-}"
export OPENCLAW_EXTENSIONS="${OPENCLAW_EXTENSIONS:-}"
export OPENCLAW_INSTALL_BROWSER="$BROWSER_INSTALL_ENABLED"
export OPENCLAW_EXTRA_MOUNTS="$EXTRA_MOUNTS"
export OPENCLAW_HOME_VOLUME="$HOME_VOLUME_NAME"
export OPENCLAW_ALLOW_INSECURE_PRIVATE_WS="${OPENCLAW_ALLOW_INSECURE_PRIVATE_WS:-}"
export OPENCLAW_SANDBOX="$SANDBOX_ENABLED"
export OPENCLAW_DOCKER_SOCKET="$DOCKER_SOCKET_PATH"
export OPENCLAW_TZ="$TIMEZONE"
export OPENCLAW_VERIFIER_WORKSPACE_DIR="${OPENCLAW_VERIFIER_WORKSPACE_DIR:-}"
export OPENCLAW_VERIFIER_GATEWAY_WORKSPACE="${OPENCLAW_VERIFIER_GATEWAY_WORKSPACE:-}"
export OPENCLAW_VERIFIER_PACKAGE_MANAGER="${OPENCLAW_VERIFIER_PACKAGE_MANAGER:-}"
export OPENCLAW_VERIFIER_IMAGE_ID="${OPENCLAW_VERIFIER_IMAGE_ID:-}"
export OPENCLAW_VERIFIER_ARTIFACT_DIGEST="${OPENCLAW_VERIFIER_ARTIFACT_DIGEST:-}"
export OPENCLAW_VERIFIER_DEPENDENCY_MANIFEST="${OPENCLAW_VERIFIER_DEPENDENCY_MANIFEST:-}"
export OPENCLAW_VERIFIER_BROWSER_MANIFEST="${OPENCLAW_VERIFIER_BROWSER_MANIFEST:-}"
export OPENCLAW_VERIFIER_REPOSITORY_IDENTITY="${OPENCLAW_VERIFIER_REPOSITORY_IDENTITY:-}"
export OPENCLAW_VERIFIER_BROWSER_IDENTITY="${OPENCLAW_VERIFIER_BROWSER_IDENTITY:-}"
export OPENCLAW_VERIFIER_EFFECTIVE_YARN_VERSION="${OPENCLAW_VERIFIER_EFFECTIVE_YARN_VERSION:-}"

# Detect Docker socket GID for sandbox group_add.
DOCKER_GID=""
if [[ -n "$SANDBOX_ENABLED" && -S "$DOCKER_SOCKET_PATH" ]]; then
  DOCKER_GID="$(stat -c '%g' "$DOCKER_SOCKET_PATH" 2>/dev/null || stat -f '%g' "$DOCKER_SOCKET_PATH" 2>/dev/null || echo "")"
fi
export DOCKER_GID

if [[ -z "${OPENCLAW_GATEWAY_TOKEN:-}" ]]; then
  EXISTING_CONFIG_TOKEN="$(read_config_gateway_token || true)"
  if [[ -n "$EXISTING_CONFIG_TOKEN" ]]; then
    OPENCLAW_GATEWAY_TOKEN="$EXISTING_CONFIG_TOKEN"
    echo "Reusing gateway token from $OPENCLAW_CONFIG_DIR/openclaw.json"
  else
    DOTENV_GATEWAY_TOKEN="$(read_env_gateway_token "$ROOT_DIR/.env" || true)"
    if [[ -n "$DOTENV_GATEWAY_TOKEN" ]]; then
      OPENCLAW_GATEWAY_TOKEN="$DOTENV_GATEWAY_TOKEN"
      echo "Reusing gateway token from $ROOT_DIR/.env"
    elif command -v openssl >/dev/null 2>&1; then
      OPENCLAW_GATEWAY_TOKEN="$(openssl rand -hex 32)"
    else
      OPENCLAW_GATEWAY_TOKEN="$(python3 - <<'PY'
import secrets
print(secrets.token_hex(32))
PY
)"
    fi
  fi
fi
export OPENCLAW_GATEWAY_TOKEN

COMPOSE_FILES=("$COMPOSE_FILE")
COMPOSE_ARGS=()

write_extra_compose() {
  local home_volume="$1"
  shift
  local mount
  local gateway_home_mount
  local gateway_config_mount
  local gateway_workspace_mount

  cat >"$EXTRA_COMPOSE_FILE" <<'YAML'
services:
  openclaw-gateway:
    volumes:
YAML

  if [[ -n "$home_volume" ]]; then
    gateway_home_mount="${home_volume}:/home/node"
    gateway_config_mount="${OPENCLAW_CONFIG_DIR}:/home/node/.openclaw"
    gateway_workspace_mount="${OPENCLAW_WORKSPACE_DIR}:/home/node/.openclaw/workspace"
    validate_mount_spec "$gateway_home_mount"
    validate_mount_spec "$gateway_config_mount"
    validate_mount_spec "$gateway_workspace_mount"
    printf '      - %s\n' "$gateway_home_mount" >>"$EXTRA_COMPOSE_FILE"
    printf '      - %s\n' "$gateway_config_mount" >>"$EXTRA_COMPOSE_FILE"
    printf '      - %s\n' "$gateway_workspace_mount" >>"$EXTRA_COMPOSE_FILE"
  fi

  for mount in "$@"; do
    validate_mount_spec "$mount"
    printf '      - %s\n' "$mount" >>"$EXTRA_COMPOSE_FILE"
  done

  cat >>"$EXTRA_COMPOSE_FILE" <<'YAML'
  openclaw-cli:
    volumes:
YAML

  if [[ -n "$home_volume" ]]; then
    printf '      - %s\n' "$gateway_home_mount" >>"$EXTRA_COMPOSE_FILE"
    printf '      - %s\n' "$gateway_config_mount" >>"$EXTRA_COMPOSE_FILE"
    printf '      - %s\n' "$gateway_workspace_mount" >>"$EXTRA_COMPOSE_FILE"
  fi

  for mount in "$@"; do
    validate_mount_spec "$mount"
    printf '      - %s\n' "$mount" >>"$EXTRA_COMPOSE_FILE"
  done

  if [[ -n "$home_volume" && "$home_volume" != *"/"* ]]; then
    validate_named_volume "$home_volume"
    cat >>"$EXTRA_COMPOSE_FILE" <<YAML
volumes:
  ${home_volume}:
YAML
  fi
}

# When sandbox is requested, ensure Docker CLI build arg is set for local builds.
# Docker socket mount is deferred until sandbox prerequisites are verified.
if [[ -n "$SANDBOX_ENABLED" ]]; then
  if [[ -z "${OPENCLAW_INSTALL_DOCKER_CLI:-}" ]]; then
    export OPENCLAW_INSTALL_DOCKER_CLI=1
  fi
fi

VALID_MOUNTS=()
if [[ -n "$EXTRA_MOUNTS" ]]; then
  IFS=',' read -r -a mounts <<<"$EXTRA_MOUNTS"
  for mount in "${mounts[@]}"; do
    mount="${mount#"${mount%%[![:space:]]*}"}"
    mount="${mount%"${mount##*[![:space:]]}"}"
    if [[ -n "$mount" ]]; then
      VALID_MOUNTS+=("$mount")
    fi
  done
fi

if [[ -n "$HOME_VOLUME_NAME" || ${#VALID_MOUNTS[@]} -gt 0 ]]; then
  # Bash 3.2 + nounset treats "${array[@]}" on an empty array as unbound.
  if [[ ${#VALID_MOUNTS[@]} -gt 0 ]]; then
    write_extra_compose "$HOME_VOLUME_NAME" "${VALID_MOUNTS[@]}"
  else
    write_extra_compose "$HOME_VOLUME_NAME"
  fi
  COMPOSE_FILES+=("$EXTRA_COMPOSE_FILE")
elif [[ -f "$EXTRA_COMPOSE_FILE" ]]; then
  # Preserve an operator-managed installation overlay. Verifier setup adds its
  # own generated contract after this file so read-only mounts win by target.
  COMPOSE_FILES+=("$EXTRA_COMPOSE_FILE")
fi
if [[ -n "${VERIFIER_RUNTIME_READY:-}" ]]; then
  COMPOSE_FILES+=("$VERIFIER_COMPOSE_FILE")
fi
for compose_file in "${COMPOSE_FILES[@]}"; do
  COMPOSE_ARGS+=("-f" "$compose_file")
done
# Keep a base compose arg set without sandbox overlay so rollback paths can
# force a known-safe gateway service definition (no docker.sock mount).
BASE_COMPOSE_ARGS=("${COMPOSE_ARGS[@]}")
if [[ -n "${VERIFIER_RUNTIME_READY:-}" && -f "$SANDBOX_COMPOSE_FILE" ]]; then
  COMPOSE_FILES+=("$SANDBOX_COMPOSE_FILE")
  COMPOSE_ARGS+=("-f" "$SANDBOX_COMPOSE_FILE")
  VERIFIER_SOCKET_OVERLAY_READY="1"
fi
COMPOSE_HINT="docker compose"
for compose_file in "${COMPOSE_FILES[@]}"; do
  COMPOSE_HINT+=" -f ${compose_file}"
done

upsert_env() {
  local file="$1"
  shift
  local -a keys=("$@")
  local tmp
  local directory
  directory="$(dirname "$file")"
  umask 077
  tmp="$(mktemp "$directory/.openclaw-env.XXXXXX")"
  # Use a delimited string instead of an associative array so the script
  # works with Bash 3.2 (macOS default) which lacks `declare -A`.
  local seen=" "

  if [[ -f "$file" ]]; then
    while IFS= read -r line || [[ -n "$line" ]]; do
      local key="${line%%=*}"
      local replaced=false
      for k in "${keys[@]}"; do
        if [[ "$key" == "$k" ]]; then
          printf '%s=%s\n' "$k" "${!k-}" >>"$tmp"
          seen="$seen$k "
          replaced=true
          break
        fi
      done
      if [[ "$replaced" == false ]]; then
        printf '%s\n' "$line" >>"$tmp"
      fi
    done <"$file"
  fi

  for k in "${keys[@]}"; do
    if [[ "$seen" != *" $k "* ]]; then
      printf '%s=%s\n' "$k" "${!k-}" >>"$tmp"
    fi
  done

  chmod 600 "$tmp"
  mv "$tmp" "$file"
}

# Guarded verifier toolchains are published only as immutable OCI images.
oci_image_consumers() {
  local image_id="$1"
  local consumers=""
  local container_id=""
  local container_image=""
  if [[ ! "$image_id" =~ ^sha256:[a-f0-9]{64}$ ]]; then
    fail "Refusing to inspect a malformed verifier image ID."
  fi
  for container_id in $(docker ps -a -q --no-trunc); do
    [[ "$container_id" =~ ^[a-f0-9]{64}$ ]] ||
      fail "Verifier image consumer enumeration returned a malformed container ID."
    container_image="$(docker inspect --format '{{.Image}}' "$container_id")"
    [[ "$container_image" =~ ^sha256:[a-f0-9]{64}$ ]] ||
      fail "Verifier image consumer inspection returned a malformed image ID."
    if [[ "$container_image" == "$image_id" ]]; then
      consumers+="${consumers:+ }$container_id"
    fi
  done
  printf '%s' "$consumers"
}

oci_remove_image_if_unused() {
  local image_id="$1"
  if [[ -z "$image_id" ]] || ! docker image inspect "$image_id" >/dev/null 2>&1; then
    return
  fi
  if [[ -n "$(oci_image_consumers "$image_id")" ]]; then
    fail "Guarded verifier image $image_id has active or stopped consumers."
  fi
  docker image rm "$image_id" >/dev/null
}

oci_remove_exact_tag() {
  local tag="$1"
  local image_id="$2"
  local actual=""
  [[ "$tag" =~ ^openclaw-sandbox-verifier:(candidate|published)-[a-f0-9]{32}$ ]] ||
    fail "Refusing to remove an unrecognized verifier transaction tag."
  actual="$(docker image inspect --format '{{.Id}}' "$tag" 2>/dev/null || true)"
  if [[ -n "$actual" ]]; then
    [[ "$actual" == "$image_id" ]] ||
      fail "Verifier transaction tag no longer names the journaled exact image."
    docker image rm "$tag" >/dev/null
  fi
}

oci_sync_paths() {
  node - "$@" <<'NODE'
const fs = require("node:fs");
for (const path of process.argv.slice(2)) {
  const fd = fs.openSync(path, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
NODE
}

oci_file_digest() {
  node - "$1" <<'NODE'
const fs = require("node:fs");
const crypto = require("node:crypto");
const path = process.argv[2];
const stat = fs.lstatSync(path);
if (!stat.isFile() || stat.isSymbolicLink()) {
  throw new Error("Refusing to digest an unsafe verifier transaction file.");
}
process.stdout.write(crypto.createHash("sha256").update(fs.readFileSync(path)).digest("hex"));
NODE
}

oci_assert_owned_mode() {
  local path_value="$1"
  local expected_mode="$2"
  local owner=""
  local mode=""
  [[ ! -L "$path_value" ]] ||
    fail "Guarded verifier lifecycle state must not contain symlinks."
  owner="$(stat -c '%u' "$path_value" 2>/dev/null || stat -f '%u' "$path_value")"
  mode="$(stat -c '%a' "$path_value" 2>/dev/null || stat -f '%Lp' "$path_value")"
  [[ "$owner" == "$(id -u)" && "$mode" == "$expected_mode" ]] ||
    fail "Guarded verifier lifecycle state has unsafe ownership or permissions."
}

oci_pin_transaction_dir() {
  local identity=""
  local actual_dev=""
  local actual_ino=""
  identity="$(
    node - "$VERIFIER_TRANSACTION_DIR" <<'NODE'
const fs = require("node:fs");

const directory = process.argv[2];
const before = fs.lstatSync(directory, { bigint: true });
if (!before.isDirectory() || before.isSymbolicLink()) {
  throw new Error("Verifier transaction directory is not a direct directory.");
}
process.chdir(directory);
const pinned = fs.lstatSync(".", { bigint: true });
if (
  !pinned.isDirectory() ||
  pinned.isSymbolicLink() ||
  pinned.dev !== before.dev ||
  pinned.ino !== before.ino ||
  pinned.mode !== before.mode
) {
  throw new Error("Verifier transaction directory changed while being pinned.");
}
process.stdout.write(`${pinned.dev}|${pinned.ino}`);
NODE
  )" || fail "Verifier transaction directory could not be pinned safely."
  IFS='|' read -r actual_dev actual_ino <<<"$identity"
  [[ "$actual_dev" =~ ^[0-9]+$ && "$actual_ino" =~ ^[0-9]+$ ]] ||
    fail "Verifier transaction directory returned malformed identity."
  if [[ -n "$VERIFIER_TRANSACTION_DIR_DEV" || -n "$VERIFIER_TRANSACTION_DIR_INO" ]]; then
    [[ "$actual_dev" == "$VERIFIER_TRANSACTION_DIR_DEV" &&
      "$actual_ino" == "$VERIFIER_TRANSACTION_DIR_INO" ]] ||
      fail "Verifier transaction directory identity changed."
    return
  fi
  VERIFIER_TRANSACTION_DIR_DEV="$actual_dev"
  VERIFIER_TRANSACTION_DIR_INO="$actual_ino"
}

oci_assert_transaction_dir_pinned() {
  [[ "$VERIFIER_TRANSACTION_DIR_DEV" =~ ^[0-9]+$ &&
    "$VERIFIER_TRANSACTION_DIR_INO" =~ ^[0-9]+$ ]] ||
    fail "Verifier transaction directory is not pinned."
  node - "$VERIFIER_TRANSACTION_DIR" \
    "$VERIFIER_TRANSACTION_DIR_DEV" "$VERIFIER_TRANSACTION_DIR_INO" <<'NODE'
const fs = require("node:fs");

const [directory, expectedDev, expectedIno] = process.argv.slice(2);
const before = fs.lstatSync(directory, { bigint: true });
if (
  !before.isDirectory() ||
  before.isSymbolicLink() ||
  String(before.dev) !== expectedDev ||
  String(before.ino) !== expectedIno
) {
  throw new Error("Verifier transaction directory no longer matches its pinned identity.");
}
process.chdir(directory);
const pinned = fs.lstatSync(".", { bigint: true });
if (
  !pinned.isDirectory() ||
  pinned.isSymbolicLink() ||
  pinned.dev !== before.dev ||
  pinned.ino !== before.ino ||
  pinned.mode !== before.mode
) {
  throw new Error("Verifier transaction directory changed during identity validation.");
}
NODE
}

oci_assert_transaction_tree() {
  oci_assert_transaction_dir_pinned ||
    fail "Verifier transaction directory identity changed."
  node - "$VERIFIER_TRANSACTION_DIR" \
    "$VERIFIER_TRANSACTION_DIR_DEV" "$VERIFIER_TRANSACTION_DIR_INO" "$(id -u)" <<'NODE'
const fs = require("node:fs");

const [directory, expectedDev, expectedIno, expectedUid] = process.argv.slice(2);
const directoryPath = fs.lstatSync(directory, { bigint: true });
if (
  !directoryPath.isDirectory() ||
  directoryPath.isSymbolicLink() ||
  String(directoryPath.dev) !== expectedDev ||
  String(directoryPath.ino) !== expectedIno ||
  Number(directoryPath.mode & 0o7777n) !== 0o700 ||
  String(directoryPath.uid) !== expectedUid
) {
  throw new Error("Verifier transaction directory metadata is unsafe.");
}
process.chdir(directory);
const pinned = fs.lstatSync(".", { bigint: true });
if (
  pinned.dev !== directoryPath.dev ||
  pinned.ino !== directoryPath.ino ||
  pinned.mode !== directoryPath.mode
) {
  throw new Error("Verifier transaction directory changed before tree inspection.");
}
for (const name of fs.readdirSync(".")) {
  if (
    !["journal", "env.backup", "config.backup", "sandbox-overlay.backup"].includes(name) &&
    !/^\.journal\.(?:bootstrap|update|restore)-[a-f0-9]{32}$/.test(name)
  ) {
    throw new Error("Verifier transaction contains unexpected filesystem state.");
  }
  const entry = fs.lstatSync(name, { bigint: true });
  if (
    !entry.isFile() ||
    entry.isSymbolicLink() ||
    entry.nlink !== 1n ||
    Number(entry.mode & 0o7777n) !== 0o600 ||
    String(entry.uid) !== expectedUid
  ) {
    throw new Error("Verifier transaction contains unsafe filesystem state.");
  }
}
NODE
}

oci_assert_lock_tree() {
  local lock_file=""
  oci_assert_owned_mode "$VERIFIER_LOCK_DIR" 700
  for lock_file in "$VERIFIER_LOCK_DIR"/* "$VERIFIER_LOCK_DIR"/.[!.]*; do
    [[ -e "$lock_file" || -L "$lock_file" ]] || continue
    [[ "$(basename "$lock_file")" == "pid" && ! -L "$lock_file" && -f "$lock_file" ]] ||
      fail "Guarded verifier lifecycle lock contains unexpected state."
    oci_assert_owned_mode "$lock_file" 600
  done
}

oci_read_journal() {
  local key="$1"
  if node - "$VERIFIER_TRANSACTION_DIR" \
    "$VERIFIER_TRANSACTION_DIR_DEV" "$VERIFIER_TRANSACTION_DIR_INO" \
    "$(id -u)" "$key" <<'NODE'
const fs = require("node:fs");

const [directory, expectedDev, expectedIno, expectedUid, wanted] = process.argv.slice(2);
const requested = fs.lstatSync(directory, { bigint: true });
process.chdir(directory);
const pinned = fs.lstatSync(".", { bigint: true });
if (
  !pinned.isDirectory() ||
  pinned.isSymbolicLink() ||
  pinned.dev !== requested.dev ||
  pinned.ino !== requested.ino ||
  pinned.mode !== requested.mode ||
  String(pinned.dev) !== expectedDev ||
  String(pinned.ino) !== expectedIno
) {
  throw new Error("Verifier transaction directory identity changed before journal read.");
}
const journal = fs.lstatSync("journal", { bigint: true });
if (
  !journal.isFile() ||
  journal.isSymbolicLink() ||
  journal.nlink !== 1n ||
  journal.size <= 0n ||
  journal.size > 65_536n ||
  Number(journal.mode & 0o7777n) !== 0o600 ||
  String(journal.uid) !== expectedUid
) {
  throw new Error("Verifier transaction journal is missing or unsafe.");
}
const journalFd = fs.openSync("journal", fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
try {
  const opened = fs.fstatSync(journalFd, { bigint: true });
  if (opened.dev !== journal.dev || opened.ino !== journal.ino || opened.nlink !== 1n) {
    throw new Error("Verifier transaction journal changed before it was opened.");
  }
  const lines = fs.readFileSync(journalFd, "utf8").split("\n");
  if (lines.at(-1) !== "") {
    throw new Error("Verifier transaction journal is not newline terminated.");
  }
  const values = lines
    .slice(0, -1)
    .filter((line) => line.startsWith(`${wanted}=`))
    .map((line) => line.slice(wanted.length + 1));
  if (values.length !== 1) {
    throw new Error("Verifier transaction journal key is ambiguous.");
  }
  process.stdout.write(`${values[0]}\n`);
} finally {
  fs.closeSync(journalFd);
}
NODE
  then
    :
  else
    fail "Verifier transaction journal key set is ambiguous."
  fi
}

oci_transaction_has_journal() {
  node - "$VERIFIER_TRANSACTION_DIR" \
    "$VERIFIER_TRANSACTION_DIR_DEV" "$VERIFIER_TRANSACTION_DIR_INO" <<'NODE'
const fs = require("node:fs");

const [directory, expectedDev, expectedIno] = process.argv.slice(2);
const requested = fs.lstatSync(directory, { bigint: true });
process.chdir(directory);
const pinned = fs.lstatSync(".", { bigint: true });
if (
  pinned.dev !== requested.dev ||
  pinned.ino !== requested.ino ||
  pinned.mode !== requested.mode ||
  String(pinned.dev) !== expectedDev ||
  String(pinned.ino) !== expectedIno
) {
  throw new Error("Verifier transaction directory changed before journal presence check.");
}
let journalExists = true;
try {
  fs.lstatSync("journal");
} catch (error) {
  if (error?.code === "ENOENT") {
    journalExists = false;
  } else {
    throw error;
  }
}
if (!journalExists) {
  process.exitCode = 1;
}
NODE
}

oci_reconcile_journal_temps() {
  node - "$VERIFIER_TRANSACTION_DIR" \
    "$VERIFIER_TRANSACTION_DIR_DEV" "$VERIFIER_TRANSACTION_DIR_INO" \
    "$(id -u)" <<'NODE'
const fs = require("node:fs");

const [directory, expectedDev, expectedIno, expectedUid] = process.argv.slice(2);
const expectedKeys = new Set([
  "phase",
  "transaction-id",
  "state-instance-digest",
  "operation-binding",
  "candidate-tag",
  "final-tag",
  "candidate-image-id",
  "final-image-id",
  "runtime-image-id",
  "new-gateway-id",
  "old-gateway-id",
  "old-gateway-image-id",
  "old-image-id",
  "old-stable-image-id",
  "gateway-was-running",
  "env-backup-digest",
  "env-backup-mode",
  "env-backup-parent-dev",
  "env-backup-parent-ino",
  "config-backup-present",
  "config-backup-digest",
  "config-backup-mode",
  "config-backup-parent-dev",
  "config-backup-parent-ino",
  "sandbox-overlay-backup-present",
  "sandbox-overlay-backup-digest",
  "sandbox-overlay-backup-mode",
  "sandbox-overlay-backup-parent-dev",
  "sandbox-overlay-backup-parent-ino",
  "restore-kind",
  "restore-state",
  "restore-temp-name",
  "restore-temp-dev",
  "restore-temp-ino",
  "restore-target-present",
  "restore-target-dev",
  "restore-target-ino",
  "docker-socket-path",
  "gc-old-image",
]);
const requested = fs.lstatSync(directory, { bigint: true });
if (
  !requested.isDirectory() ||
  requested.isSymbolicLink() ||
  String(requested.dev) !== expectedDev ||
  String(requested.ino) !== expectedIno ||
  Number(requested.mode & 0o7777n) !== 0o700 ||
  String(requested.uid) !== expectedUid
) {
  throw new Error("Verifier transaction directory is unsafe before journal reconciliation.");
}
process.chdir(directory);
const assertPinned = () => {
  const pinned = fs.lstatSync(".", { bigint: true });
  if (
    !pinned.isDirectory() ||
    pinned.isSymbolicLink() ||
    pinned.dev !== requested.dev ||
    pinned.ino !== requested.ino ||
    pinned.mode !== requested.mode
  ) {
    throw new Error("Verifier transaction directory changed during journal reconciliation.");
  }
};
const lstatOptional = (name) => {
  try {
    return fs.lstatSync(name, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
};
const readDirectJournal = (name) => {
  const entry = fs.lstatSync(name, { bigint: true });
  if (
    !entry.isFile() ||
    entry.isSymbolicLink() ||
    entry.nlink !== 1n ||
    Number(entry.mode & 0o7777n) !== 0o600 ||
    String(entry.uid) !== expectedUid ||
    entry.size > 65_536n
  ) {
    throw new Error("Verifier transaction journal candidate has unsafe metadata.");
  }
  const fd = fs.openSync(name, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (
      opened.dev !== entry.dev ||
      opened.ino !== entry.ino ||
      opened.mode !== entry.mode ||
      opened.nlink !== 1n ||
      opened.size !== entry.size
    ) {
      throw new Error("Verifier transaction journal candidate changed before it was opened.");
    }
    return { value: fs.readFileSync(fd, "utf8"), identity: opened };
  } finally {
    fs.closeSync(fd);
  }
};
const parseJournal = (value) => {
  const lines = value.split("\n");
  if (lines.at(-1) !== "") {
    return { kind: "incomplete" };
  }
  lines.pop();
  const values = new Map();
  for (const line of lines) {
    const separator = line.indexOf("=");
    if (separator <= 0) {
      return { kind: "malformed" };
    }
    const key = line.slice(0, separator);
    if (!expectedKeys.has(key) || values.has(key)) {
      return { kind: "malformed" };
    }
    values.set(key, line.slice(separator + 1));
  }
  if (values.size !== expectedKeys.size) {
    return { kind: "incomplete" };
  }
  return { kind: "complete", values };
};
const fsyncDirectory = () => {
  const fd = fs.openSync(".", fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
};
const exactTempPattern = /^\.journal\.(?:bootstrap|update|restore)-[a-f0-9]{32}$/;
const journalTemps = fs.readdirSync(".").filter((name) => name.startsWith(".journal."));
if (journalTemps.some((name) => !exactTempPattern.test(name))) {
  throw new Error("Verifier transaction contains an unrecognized journal candidate.");
}
if (journalTemps.length > 1) {
  throw new Error("Verifier transaction contains ambiguous journal candidates.");
}
if (journalTemps.length === 0) {
  process.exit(0);
}
assertPinned();
const temporaryName = journalTemps[0];
const temporary = readDirectJournal(temporaryName);
const temporaryParsed = parseJournal(temporary.value);
const journalState = lstatOptional("journal");
if (journalState) {
  const authoritative = readDirectJournal("journal");
  if (parseJournal(authoritative.value).kind !== "complete") {
    throw new Error("Verifier transaction authoritative journal is malformed.");
  }
  if (temporaryParsed.kind === "malformed") {
    throw new Error("Verifier transaction journal candidate is malformed.");
  }
  assertPinned();
  const finalTemporary = fs.lstatSync(temporaryName, { bigint: true });
  if (
    finalTemporary.dev !== temporary.identity.dev ||
    finalTemporary.ino !== temporary.identity.ino ||
    finalTemporary.mode !== temporary.identity.mode ||
    finalTemporary.nlink !== 1n
  ) {
    throw new Error("Verifier transaction journal candidate changed before reconciliation.");
  }
  fs.unlinkSync(temporaryName);
  fsyncDirectory();
  assertPinned();
  process.exit(0);
}
if (!temporaryName.startsWith(".journal.bootstrap-")) {
  throw new Error("Verifier transaction restore journal candidate has no authoritative journal.");
}
if (temporaryParsed.kind === "malformed") {
  throw new Error("Verifier transaction bootstrap journal candidate is malformed.");
}
if (temporaryParsed.kind === "incomplete") {
  assertPinned();
  const finalTemporary = fs.lstatSync(temporaryName, { bigint: true });
  if (
    finalTemporary.dev !== temporary.identity.dev ||
    finalTemporary.ino !== temporary.identity.ino ||
    finalTemporary.mode !== temporary.identity.mode ||
    finalTemporary.nlink !== 1n
  ) {
    throw new Error("Verifier transaction bootstrap candidate changed before cleanup.");
  }
  fs.unlinkSync(temporaryName);
  fsyncDirectory();
  assertPinned();
  process.exit(0);
}
if (temporaryParsed.values.get("phase") !== "begun") {
  throw new Error("Verifier transaction bootstrap journal candidate has an invalid phase.");
}
assertPinned();
const finalTemporary = fs.lstatSync(temporaryName, { bigint: true });
if (
  finalTemporary.dev !== temporary.identity.dev ||
  finalTemporary.ino !== temporary.identity.ino ||
  finalTemporary.mode !== temporary.identity.mode ||
  finalTemporary.nlink !== 1n
) {
  throw new Error("Verifier transaction bootstrap candidate changed before publication.");
}
fs.renameSync(temporaryName, "journal");
fsyncDirectory();
assertPinned();
const published = fs.lstatSync("journal", { bigint: true });
if (
  published.dev !== temporary.identity.dev ||
  published.ino !== temporary.identity.ino ||
  published.nlink !== 1n
) {
  throw new Error("Verifier transaction bootstrap journal publication changed identity.");
}
NODE
}

oci_validate_journal_shape() {
  node - "$VERIFIER_TRANSACTION_DIR" \
    "$VERIFIER_TRANSACTION_DIR_DEV" "$VERIFIER_TRANSACTION_DIR_INO" \
    "$(id -u)" <<'NODE'
const fs = require("node:fs");
const [directory, expectedDev, expectedIno, expectedUid] = process.argv.slice(2);
const expected = new Set([
  "phase",
  "transaction-id",
  "state-instance-digest",
  "operation-binding",
  "candidate-tag",
  "final-tag",
  "candidate-image-id",
  "final-image-id",
  "runtime-image-id",
  "new-gateway-id",
  "old-gateway-id",
  "old-gateway-image-id",
  "old-image-id",
  "old-stable-image-id",
  "gateway-was-running",
  "env-backup-digest",
  "env-backup-mode",
  "env-backup-parent-dev",
  "env-backup-parent-ino",
  "config-backup-present",
  "config-backup-digest",
  "config-backup-mode",
  "config-backup-parent-dev",
  "config-backup-parent-ino",
  "sandbox-overlay-backup-present",
  "sandbox-overlay-backup-digest",
  "sandbox-overlay-backup-mode",
  "sandbox-overlay-backup-parent-dev",
  "sandbox-overlay-backup-parent-ino",
  "restore-kind",
  "restore-state",
  "restore-temp-name",
  "restore-temp-dev",
  "restore-temp-ino",
  "restore-target-present",
  "restore-target-dev",
  "restore-target-ino",
  "docker-socket-path",
  "gc-old-image",
]);
const requested = fs.lstatSync(directory, { bigint: true });
process.chdir(directory);
const pinned = fs.lstatSync(".", { bigint: true });
if (
  !pinned.isDirectory() ||
  pinned.isSymbolicLink() ||
  pinned.dev !== requested.dev ||
  pinned.ino !== requested.ino ||
  pinned.mode !== requested.mode ||
  String(pinned.dev) !== expectedDev ||
  String(pinned.ino) !== expectedIno
) {
  throw new Error("Verifier transaction directory identity changed before journal validation.");
}
const journal = fs.lstatSync("journal", { bigint: true });
if (
  !journal.isFile() ||
  journal.isSymbolicLink() ||
  journal.nlink !== 1n ||
  journal.size <= 0n ||
  journal.size > 65_536n ||
  Number(journal.mode & 0o7777n) !== 0o600 ||
  String(journal.uid) !== expectedUid
) {
  throw new Error("Verifier transaction journal is unsafe.");
}
const journalFd = fs.openSync("journal", fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
const opened = fs.fstatSync(journalFd, { bigint: true });
if (opened.dev !== journal.dev || opened.ino !== journal.ino || opened.nlink !== 1n) {
  fs.closeSync(journalFd);
  throw new Error("Verifier transaction journal changed before validation.");
}
const seen = new Set();
const lines = fs.readFileSync(journalFd, "utf8").split("\n");
fs.closeSync(journalFd);
if (lines.at(-1) !== "") {
  throw new Error("Verifier transaction journal is not newline terminated.");
}
lines.pop();
for (const line of lines) {
  const separator = line.indexOf("=");
  const key = separator < 0 ? "" : line.slice(0, separator);
  if (!expected.has(key) || seen.has(key)) {
    throw new Error("Verifier transaction journal has an unknown or duplicate key.");
  }
  seen.add(key);
}
if (seen.size !== expected.size) {
  throw new Error("Verifier transaction journal is incomplete.");
}
NODE
}

oci_remove_pinned_transaction_dir() {
  node - "$VERIFIER_TRANSACTION_DIR" \
    "$VERIFIER_TRANSACTION_DIR_DEV" "$VERIFIER_TRANSACTION_DIR_INO" \
    "$(id -u)" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const [directory, expectedDev, expectedIno, expectedUid] = process.argv.slice(2);
const parent = path.dirname(directory);
const leaf = path.basename(directory);
if (leaf === "." || leaf === ".." || path.join(parent, leaf) !== path.normalize(directory)) {
  throw new Error("Verifier transaction directory leaf is malformed.");
}
const parentPath = fs.lstatSync(parent, { bigint: true });
if (!parentPath.isDirectory() || parentPath.isSymbolicLink()) {
  throw new Error("Verifier transaction parent is not a direct directory.");
}
process.chdir(parent);
const pinnedParent = fs.lstatSync(".", { bigint: true });
const currentParent = fs.lstatSync(parent, { bigint: true });
if (
  pinnedParent.dev !== parentPath.dev ||
  pinnedParent.ino !== parentPath.ino ||
  pinnedParent.mode !== parentPath.mode ||
  currentParent.dev !== parentPath.dev ||
  currentParent.ino !== parentPath.ino ||
  currentParent.mode !== parentPath.mode
) {
  throw new Error("Verifier transaction parent changed before cleanup.");
}
const directoryPath = fs.lstatSync(leaf, { bigint: true });
if (
  !directoryPath.isDirectory() ||
  directoryPath.isSymbolicLink() ||
  String(directoryPath.dev) !== expectedDev ||
  String(directoryPath.ino) !== expectedIno ||
  Number(directoryPath.mode & 0o7777n) !== 0o700 ||
  String(directoryPath.uid) !== expectedUid
) {
  throw new Error("Verifier transaction directory is unsafe before cleanup.");
}
process.chdir(leaf);
const assertPinnedDirectory = () => {
  const currentParent = fs.lstatSync("..", { bigint: true });
  const pinnedDirectory = fs.lstatSync(".", { bigint: true });
  if (
    pinnedParent.dev !== parentPath.dev ||
    pinnedParent.ino !== parentPath.ino ||
    currentParent.dev !== parentPath.dev ||
    currentParent.ino !== parentPath.ino ||
    !pinnedDirectory.isDirectory() ||
    pinnedDirectory.isSymbolicLink() ||
    pinnedDirectory.dev !== directoryPath.dev ||
    pinnedDirectory.ino !== directoryPath.ino ||
    String(pinnedDirectory.dev) !== expectedDev ||
    String(pinnedDirectory.ino) !== expectedIno ||
    Number(pinnedDirectory.mode & 0o7777n) !== 0o700 ||
    String(pinnedDirectory.uid) !== expectedUid
  ) {
    throw new Error("Verifier transaction directory identity changed during cleanup.");
  }
};
const fsyncCurrentDirectory = () => {
  const fd = fs.openSync(".", fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
};
assertPinnedDirectory();
const names = fs.readdirSync(".");
for (const name of names) {
  if (!["journal", "env.backup", "config.backup", "sandbox-overlay.backup"].includes(name)) {
    throw new Error("Verifier transaction cleanup found an untracked temporary file.");
  }
  const entry = fs.lstatSync(name, { bigint: true });
  if (
    !entry.isFile() ||
    entry.isSymbolicLink() ||
    entry.nlink !== 1n ||
    Number(entry.mode & 0o7777n) !== 0o600 ||
    String(entry.uid) !== expectedUid
  ) {
    throw new Error("Verifier transaction cleanup found an unsafe file.");
  }
  const entryFd = fs.openSync(name, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(entryFd, { bigint: true });
    if (opened.dev !== entry.dev || opened.ino !== entry.ino || opened.nlink !== 1n) {
      throw new Error("Verifier transaction file changed before cleanup.");
    }
  } finally {
    fs.closeSync(entryFd);
  }
  assertPinnedDirectory();
  const finalEntry = fs.lstatSync(name, { bigint: true });
  if (
    finalEntry.dev !== entry.dev ||
    finalEntry.ino !== entry.ino ||
    finalEntry.nlink !== 1n
  ) {
    throw new Error("Verifier transaction file changed immediately before cleanup.");
  }
  fs.unlinkSync(name);
  fsyncCurrentDirectory();
}
assertPinnedDirectory();
if (fs.readdirSync(".").length !== 0) {
  throw new Error("Verifier transaction directory is not empty after exact cleanup.");
}
process.chdir("..");
const finalParent = fs.lstatSync(".", { bigint: true });
const finalRequestedParent = fs.lstatSync(parent, { bigint: true });
const finalDirectory = fs.lstatSync(leaf, { bigint: true });
if (
  finalParent.dev !== parentPath.dev ||
  finalParent.ino !== parentPath.ino ||
  finalRequestedParent.dev !== parentPath.dev ||
  finalRequestedParent.ino !== parentPath.ino ||
  finalDirectory.dev !== directoryPath.dev ||
  finalDirectory.ino !== directoryPath.ino
) {
  throw new Error("Verifier transaction identity changed before directory removal.");
}
fs.rmdirSync(leaf);
fsyncCurrentDirectory();
const publishedParent = fs.lstatSync(parent, { bigint: true });
if (
  publishedParent.dev !== parentPath.dev ||
  publishedParent.ino !== parentPath.ino
) {
  throw new Error("Verifier transaction parent changed during cleanup publication.");
}
try {
  fs.lstatSync(leaf);
  throw new Error("Verifier transaction directory still exists after cleanup.");
} catch (error) {
  if (error?.code !== "ENOENT") {
    throw error;
  }
}
NODE
  VERIFIER_TRANSACTION_DIR_DEV=""
  VERIFIER_TRANSACTION_DIR_INO=""
}

oci_assert_known_phase() {
  case "$1" in
    begun | candidate-built | candidate-verified | final-built | final-verified | tag-published | env-committed | socket-overlay-written | sandbox-configured | gateway-started | gateway-ready | committed) ;;
    *) fail "Verifier transaction journal contains an unknown phase." ;;
  esac
}

oci_validate_journal_identities() {
  local transaction_id="$1"
  local state_instance_digest="$2"
  local operation_binding="$3"
  local candidate="$4"
  local final="$5"
  local new_gateway="$6"
  local old_image="$7"
  local old_stable="$8"
  local gateway_was_running="$9"
  [[ "$transaction_id" =~ ^[a-f0-9]{32}$ ]] ||
    fail "Verifier journal contains a malformed transaction ID."
  [[ "$state_instance_digest" == "$VERIFIER_STATE_TOKEN_DIGEST" ]] ||
    fail "Verifier journal belongs to a different state instance."
  [[ "$operation_binding" == "$(oci_operation_binding "$transaction_id")" ]] ||
    fail "Verifier journal contains an invalid state-bound operation identity."
  [[ -z "$candidate" || "$candidate" =~ ^sha256:[a-f0-9]{64}$ ]] ||
    fail "Verifier journal contains a malformed candidate image ID."
  [[ -z "$final" || "$final" =~ ^sha256:[a-f0-9]{64}$ ]] ||
    fail "Verifier journal contains a malformed final image ID."
  [[ -z "$new_gateway" || "$new_gateway" =~ ^[a-f0-9]{64}$ ]] ||
    fail "Verifier journal contains a malformed Gateway ID."
  [[ -z "$old_image" || "$old_image" =~ ^sha256:[a-f0-9]{64}$ ]] ||
    fail "Verifier journal contains a malformed prior image ID."
  [[ -z "$old_stable" || "$old_stable" =~ ^sha256:[a-f0-9]{64}$ ]] ||
    fail "Verifier journal contains a malformed prior stable image ID."
  [[ -z "$gateway_was_running" || "$gateway_was_running" == "1" ]] ||
    fail "Verifier journal contains a malformed prior Gateway state."
}

oci_validate_transaction_metadata() {
  local transaction_id="$1"
  local candidate_tag="$2"
  local final_tag="$3"
  local runtime_image="$4"
  local old_gateway="$5"
  local old_gateway_image="$6"
  local env_backup_digest="$7"
  local env_backup_mode="$8"
  local env_backup_parent_dev="$9"
  local env_backup_parent_ino="${10}"
  local config_backup_present="${11}"
  local config_backup_digest="${12}"
  local config_backup_mode="${13}"
  local config_backup_parent_dev="${14}"
  local config_backup_parent_ino="${15}"
  local overlay_backup_present="${16}"
  local overlay_backup_digest="${17}"
  local overlay_backup_mode="${18}"
  local overlay_backup_parent_dev="${19}"
  local overlay_backup_parent_ino="${20}"
  local docker_socket_path="${21}"
  local gc_old_image="${22}"
  [[ "$candidate_tag" == "openclaw-sandbox-verifier:candidate-$transaction_id" &&
    "$final_tag" == "openclaw-sandbox-verifier:published-$transaction_id" ]] ||
    fail "Verifier journal contains altered transaction tag intent."
  [[ "$runtime_image" =~ ^sha256:[a-f0-9]{64}$ ]] ||
    fail "Verifier journal contains a malformed runtime image ID."
  [[ -z "$old_gateway" || "$old_gateway" =~ ^[a-f0-9]{64}$ ]] ||
    fail "Verifier journal contains a malformed prior Gateway ID."
  [[ -z "$old_gateway_image" || "$old_gateway_image" =~ ^sha256:[a-f0-9]{64}$ ]] ||
    fail "Verifier journal contains a malformed prior Gateway image ID."
  [[ "$env_backup_digest" =~ ^[a-f0-9]{64}$ ]] ||
    fail "Verifier journal contains a malformed environment backup digest."
  [[ "$env_backup_mode" =~ ^[0-7]{3,4}$ ]] ||
    fail "Verifier journal contains a malformed environment backup mode."
  [[ "$env_backup_parent_dev" =~ ^[0-9]+$ &&
    "$env_backup_parent_ino" =~ ^[0-9]+$ ]] ||
    fail "Verifier journal contains malformed environment parent identity."
  [[ "$config_backup_present" == "0" || "$config_backup_present" == "1" ]] ||
    fail "Verifier journal contains a malformed config backup state."
  [[ "$overlay_backup_present" == "0" || "$overlay_backup_present" == "1" ]] ||
    fail "Verifier journal contains a malformed sandbox overlay backup state."
  if [[ "$config_backup_present" == "1" ]]; then
    [[ "$config_backup_digest" =~ ^[a-f0-9]{64}$ &&
      "$config_backup_mode" =~ ^[0-7]{3,4}$ ]] ||
      fail "Verifier journal contains malformed config backup metadata."
  else
    [[ -z "$config_backup_digest" && -z "$config_backup_mode" ]] ||
      fail "Verifier journal contains unexpected config backup metadata."
  fi
  if [[ "$overlay_backup_present" == "1" ]]; then
    [[ "$overlay_backup_digest" =~ ^[a-f0-9]{64}$ &&
      "$overlay_backup_mode" =~ ^[0-7]{3,4}$ ]] ||
      fail "Verifier journal contains malformed sandbox overlay backup metadata."
  else
    [[ -z "$overlay_backup_digest" && -z "$overlay_backup_mode" ]] ||
      fail "Verifier journal contains unexpected sandbox overlay backup metadata."
  fi
  [[ "$config_backup_parent_dev" =~ ^[0-9]+$ &&
    "$config_backup_parent_ino" =~ ^[0-9]+$ ]] ||
    fail "Verifier journal contains malformed config parent identity."
  [[ "$overlay_backup_parent_dev" =~ ^[0-9]+$ &&
    "$overlay_backup_parent_ino" =~ ^[0-9]+$ ]] ||
    fail "Verifier journal contains malformed sandbox overlay parent identity."
  if [[ "$docker_socket_path" != /* ]] ||
    contains_disallowed_chars "$docker_socket_path" ||
    [[ "$docker_socket_path" =~ [[:space:]] ]]; then
    fail "Verifier journal contains a malformed Docker socket path."
  fi
  [[ -z "$gc_old_image" || "$gc_old_image" == "1" ]] ||
    fail "Verifier journal contains a malformed image-retention policy."
}

oci_validate_restore_state() {
  local kind=""
  local state=""
  local temp_name=""
  local temp_dev=""
  local temp_ino=""
  local target_present=""
  local target_dev=""
  local target_ino=""
  kind="$(oci_read_journal restore-kind)"
  state="$(oci_read_journal restore-state)"
  temp_name="$(oci_read_journal restore-temp-name)"
  temp_dev="$(oci_read_journal restore-temp-dev)"
  temp_ino="$(oci_read_journal restore-temp-ino)"
  target_present="$(oci_read_journal restore-target-present)"
  target_dev="$(oci_read_journal restore-target-dev)"
  target_ino="$(oci_read_journal restore-target-ino)"
  if [[ -z "$kind" && -z "$state" && -z "$temp_name" &&
    -z "$temp_dev" && -z "$temp_ino" && -z "$target_present" &&
    -z "$target_dev" && -z "$target_ino" ]]; then
    return
  fi
  [[ "$kind" == "env" || "$kind" == "config" || "$kind" == "overlay" ]] ||
    fail "Verifier journal contains an unknown restore target."
  [[ "$state" == "prepared" || "$state" == "temp-written" ||
    "$state" == "target-replaced" || "$state" == "mode-applied" ]] ||
    fail "Verifier journal contains an unknown restore phase."
  [[ "$temp_name" =~ ^\.openclaw-restore-[a-f0-9]{32}$ ]] ||
    fail "Verifier journal contains a malformed restore temporary name."
  if [[ "$state" == "prepared" ]]; then
    [[ -z "$temp_dev" && -z "$temp_ino" ]] ||
      fail "Verifier prepared restore state contains premature file identity."
  else
    [[ "$temp_dev" =~ ^[0-9]+$ && "$temp_ino" =~ ^[0-9]+$ ]] ||
      fail "Verifier restore state contains malformed temporary identity."
  fi
  [[ "$target_present" == "0" || "$target_present" == "1" ]] ||
    fail "Verifier restore state contains malformed target presence."
  if [[ "$target_present" == "1" ]]; then
    [[ "$target_dev" =~ ^[0-9]+$ && "$target_ino" =~ ^[0-9]+$ ]] ||
      fail "Verifier restore state contains malformed target identity."
  else
    [[ -z "$target_dev" && -z "$target_ino" ]] ||
      fail "Verifier restore state contains contradictory absent-target identity."
  fi
}

oci_resolve_transaction_image() {
  local tag="$1"
  local recorded="$2"
  local actual=""
  actual="$(docker image inspect --format '{{.Id}}' "$tag" 2>/dev/null || true)"
  if [[ -n "$actual" && ! "$actual" =~ ^sha256:[a-f0-9]{64}$ ]]; then
    fail "Verifier transaction tag resolved to a malformed image identity."
  fi
  if [[ -n "$recorded" && -n "$actual" && "$recorded" != "$actual" ]]; then
    fail "Verifier transaction tag conflicts with the journaled exact image."
  fi
  printf '%s' "${recorded:-$actual}"
}

oci_validate_phase_state() {
  local phase="$1"
  local candidate="$2"
  local final="$3"
  local new_gateway="$4"
  case "$phase" in
    begun) ;;
    candidate-built | candidate-verified)
      [[ -n "$candidate" ]] ||
        fail "Verifier journal phase is missing its candidate image identity."
      ;;
    final-built | final-verified | tag-published | env-committed | socket-overlay-written | sandbox-configured)
      [[ -n "$candidate" && -n "$final" ]] ||
        fail "Verifier journal phase is missing published image identities."
      ;;
    gateway-started | gateway-ready | committed)
      [[ -n "$candidate" && -n "$final" && -n "$new_gateway" ]] ||
        fail "Verifier journal phase is missing Gateway publication identities."
      ;;
  esac
}

oci_write_journal() {
  local phase="$1"
  local payload=""
  umask 077
  oci_assert_pinned_state_dir
  payload="$(
    printf 'phase=%s\n' "$phase"
    printf 'transaction-id=%s\n' "${OPENCLAW_VERIFIER_TRANSACTION_ID:-}"
    printf 'state-instance-digest=%s\n' "${VERIFIER_STATE_TOKEN_DIGEST:-}"
    printf 'operation-binding=%s\n' "${VERIFIER_OPERATION_BINDING:-}"
    printf 'candidate-tag=%s\n' "${VERIFIER_CANDIDATE_TAG:-}"
    printf 'final-tag=%s\n' "${VERIFIER_FINAL_TAG:-}"
    printf 'candidate-image-id=%s\n' "${VERIFIER_CANDIDATE_IMAGE_ID:-}"
    printf 'final-image-id=%s\n' "${VERIFIER_FINAL_IMAGE_ID:-}"
    printf 'runtime-image-id=%s\n' "${VERIFIER_RUNTIME_IMAGE_ID:-}"
    printf 'new-gateway-id=%s\n' "${VERIFIER_NEW_GATEWAY_ID:-}"
    printf 'old-gateway-id=%s\n' "${VERIFIER_OLD_GATEWAY_ID:-}"
    printf 'old-gateway-image-id=%s\n' "${VERIFIER_OLD_GATEWAY_IMAGE_ID:-}"
    printf 'old-image-id=%s\n' "${VERIFIER_OLD_IMAGE_ID:-}"
    printf 'old-stable-image-id=%s\n' "${VERIFIER_OLD_STABLE_IMAGE_ID:-}"
    printf 'gateway-was-running=%s\n' "${VERIFIER_GATEWAY_WAS_RUNNING:-}"
    printf 'env-backup-digest=%s\n' "${VERIFIER_ENV_BACKUP_DIGEST:-}"
    printf 'env-backup-mode=%s\n' "${VERIFIER_ENV_BACKUP_MODE:-}"
    printf 'env-backup-parent-dev=%s\n' "${VERIFIER_ENV_BACKUP_PARENT_DEV:-}"
    printf 'env-backup-parent-ino=%s\n' "${VERIFIER_ENV_BACKUP_PARENT_INO:-}"
    printf 'config-backup-present=%s\n' "${VERIFIER_CONFIG_BACKUP_PRESENT:-0}"
    printf 'config-backup-digest=%s\n' "${VERIFIER_CONFIG_BACKUP_DIGEST:-}"
    printf 'config-backup-mode=%s\n' "${VERIFIER_CONFIG_BACKUP_MODE:-}"
    printf 'config-backup-parent-dev=%s\n' "${VERIFIER_CONFIG_BACKUP_PARENT_DEV:-}"
    printf 'config-backup-parent-ino=%s\n' "${VERIFIER_CONFIG_BACKUP_PARENT_INO:-}"
    printf 'sandbox-overlay-backup-present=%s\n' "${VERIFIER_OVERLAY_BACKUP_PRESENT:-0}"
    printf 'sandbox-overlay-backup-digest=%s\n' "${VERIFIER_OVERLAY_BACKUP_DIGEST:-}"
    printf 'sandbox-overlay-backup-mode=%s\n' "${VERIFIER_OVERLAY_BACKUP_MODE:-}"
    printf 'sandbox-overlay-backup-parent-dev=%s\n' \
      "${VERIFIER_OVERLAY_BACKUP_PARENT_DEV:-}"
    printf 'sandbox-overlay-backup-parent-ino=%s\n' \
      "${VERIFIER_OVERLAY_BACKUP_PARENT_INO:-}"
    printf 'restore-kind=\n'
    printf 'restore-state=\n'
    printf 'restore-temp-name=\n'
    printf 'restore-temp-dev=\n'
    printf 'restore-temp-ino=\n'
    printf 'restore-target-present=\n'
    printf 'restore-target-dev=\n'
    printf 'restore-target-ino=\n'
    printf 'docker-socket-path=%s\n' "${VERIFIER_DOCKER_SOCKET_PATH:-}"
    printf 'gc-old-image=%s\n' "${OPENCLAW_VERIFIER_GC_OLD_IMAGE:-}"
  )"
  payload+=$'\n'
  node - "$VERIFIER_TRANSACTION_DIR" \
    "$VERIFIER_TRANSACTION_DIR_DEV" "$VERIFIER_TRANSACTION_DIR_INO" \
    "$(id -u)" "$payload" <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");

const [directory, expectedDev, expectedIno, expectedUid, payload] = process.argv.slice(2);
const requested = fs.lstatSync(directory, { bigint: true });
process.chdir(directory);
const assertPinnedDirectory = () => {
  const pinned = fs.lstatSync(".", { bigint: true });
  if (
    !pinned.isDirectory() ||
    pinned.isSymbolicLink() ||
    pinned.dev !== requested.dev ||
    pinned.ino !== requested.ino ||
    pinned.mode !== requested.mode ||
    String(pinned.dev) !== expectedDev ||
    String(pinned.ino) !== expectedIno ||
    Number(pinned.mode & 0o7777n) !== 0o700 ||
    String(pinned.uid) !== expectedUid
  ) {
    throw new Error("Verifier transaction directory identity changed during journal write.");
  }
};
const lstatJournal = (journalPath) => {
  let journal;
  try {
    journal = fs.lstatSync(journalPath, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  if (
    !journal.isFile() ||
    journal.isSymbolicLink() ||
    journal.nlink !== 1n ||
    Number(journal.mode & 0o7777n) !== 0o600 ||
    String(journal.uid) !== expectedUid
  ) {
    throw new Error("Verifier transaction journal is unsafe before publication.");
  }
  return journal;
};
const journalPath = "journal";
const initialJournal = lstatJournal(journalPath);
const temporaryName =
  `.journal.${initialJournal ? "update" : "bootstrap"}-` +
  crypto.randomBytes(16).toString("hex");
const temporaryPath = temporaryName;
let temporaryFd;
try {
  assertPinnedDirectory();
  temporaryFd = fs.openSync(
    temporaryPath,
    fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      fs.constants.O_NOFOLLOW,
    0o600,
  );
  fs.writeFileSync(temporaryFd, payload);
  fs.fsyncSync(temporaryFd);
  const temporary = fs.fstatSync(temporaryFd, { bigint: true });
  if (
    !temporary.isFile() ||
    temporary.isSymbolicLink() ||
    temporary.nlink !== 1n ||
    Number(temporary.mode & 0o7777n) !== 0o600 ||
    String(temporary.uid) !== expectedUid
  ) {
    throw new Error("Verifier journal temporary file is unsafe.");
  }
  fs.closeSync(temporaryFd);
  temporaryFd = undefined;
  assertPinnedDirectory();
  const currentJournal = lstatJournal(journalPath);
  if (
    (initialJournal === undefined && currentJournal !== undefined) ||
    (initialJournal !== undefined &&
      (currentJournal === undefined ||
        currentJournal.dev !== initialJournal.dev ||
        currentJournal.ino !== initialJournal.ino ||
        currentJournal.mode !== initialJournal.mode ||
        currentJournal.nlink !== 1n))
  ) {
    throw new Error("Verifier transaction journal changed before publication.");
  }
  const temporaryPathState = fs.lstatSync(temporaryPath, { bigint: true });
  if (
    temporaryPathState.dev !== temporary.dev ||
    temporaryPathState.ino !== temporary.ino ||
    temporaryPathState.nlink !== 1n
  ) {
    throw new Error("Verifier journal temporary file identity changed before publication.");
  }
  fs.renameSync(temporaryPath, journalPath);
  const directoryFd = fs.openSync(".", fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(directoryFd);
  } finally {
    fs.closeSync(directoryFd);
  }
  assertPinnedDirectory();
  const published = fs.lstatSync(journalPath, { bigint: true });
  if (
    published.dev !== temporary.dev ||
    published.ino !== temporary.ino ||
    published.nlink !== 1n
  ) {
    throw new Error("Verifier journal publication did not retain the exact temporary identity.");
  }
} finally {
  if (temporaryFd !== undefined) {
    fs.closeSync(temporaryFd);
  }
}
NODE
  oci_wait_transaction_state_test_barrier "$phase"
  oci_assert_pinned_state_dir
}

oci_operation_binding() {
  local operation_id="$1"
  [[ "$VERIFIER_STATE_TOKEN_DIGEST" =~ ^[a-f0-9]{64}$ &&
    ( "$operation_id" == "recovery" || "$operation_id" == "cleanup" ||
      "$operation_id" =~ ^[a-f0-9]{32}$ ) ]] ||
    fail "Guarded verifier state operation binding input is malformed."
  node -e '
    const crypto = require("node:crypto");
    process.stdout.write(
      crypto.createHash("sha256").update(`${process.argv[1]}\0${process.argv[2]}`).digest("hex"),
    );
  ' "$VERIFIER_STATE_TOKEN_DIGEST" "$operation_id"
}

oci_prepare_state_instance_token() {
  local expected_digest="${1:-}"
  local digest=""
  [[ -z "$expected_digest" || "$expected_digest" =~ ^[a-f0-9]{64}$ ]] ||
    fail "Guarded verifier expected state-instance digest is malformed."
  digest="$(
    node - "$VERIFIER_STATE_PATH" \
      "$VERIFIER_STATE_DIR_DEV" "$VERIFIER_STATE_DIR_INO" \
      "$expected_digest" <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");

const [statePath, expectedDev, expectedIno, expectedDigest] = process.argv.slice(2);
const expectedUid = BigInt(process.getuid());
const tokenName = ".state-instance";
const state = fs.lstatSync(".", { bigint: true });
const requested = fs.lstatSync(statePath, { bigint: true });
const assertState = (value) => {
  if (
    !value.isDirectory() ||
    value.isSymbolicLink() ||
    String(value.dev) !== expectedDev ||
    String(value.ino) !== expectedIno ||
    value.uid !== expectedUid ||
    Number(value.mode & 0o7777n) !== 0o700
  ) {
    throw new Error("Guarded verifier state root changed during token preparation.");
  }
};
assertState(state);
assertState(requested);

const lstatOptional = (name) => {
  try {
    return fs.lstatSync(name, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
};
let tokenState = lstatOptional(tokenName);
if (!tokenState) {
  if (
    expectedDigest ||
    lstatOptional("transaction") ||
    lstatOptional("lock")
  ) {
    throw new Error("Guarded verifier state-instance token is missing from active state.");
  }
  const injected =
    process.env.OPENCLAW_DOCKER_SETUP_TEST === "1"
      ? process.env.OPENCLAW_TEST_STATE_INSTANCE_TOKEN
      : undefined;
  if (injected !== undefined && !/^[a-f0-9]{64}$/.test(injected)) {
    throw new Error("Guarded verifier injected state-instance token is malformed.");
  }
  const token = injected ?? crypto.randomBytes(32).toString("hex");
  let fd;
  try {
    fd = fs.openSync(
      tokenName,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW,
      0o600,
    );
    fs.writeFileSync(fd, `${token}\n`);
    fs.fsyncSync(fd);
    tokenState = fs.fstatSync(fd, { bigint: true });
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
  const directoryFd = fs.openSync(".", fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(directoryFd);
  } finally {
    fs.closeSync(directoryFd);
  }
}
if (
  !tokenState.isFile() ||
  tokenState.isSymbolicLink() ||
  tokenState.nlink !== 1n ||
  tokenState.uid !== expectedUid ||
  Number(tokenState.mode & 0o7777n) !== 0o600 ||
  tokenState.size !== 65n
) {
  throw new Error("Guarded verifier state-instance token metadata is unsafe.");
}
const fd = fs.openSync(tokenName, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
let raw;
try {
  const opened = fs.fstatSync(fd, { bigint: true });
  if (
    opened.dev !== tokenState.dev ||
    opened.ino !== tokenState.ino ||
    opened.nlink !== 1n
  ) {
    throw new Error("Guarded verifier state-instance token changed before read.");
  }
  raw = fs.readFileSync(fd, "utf8");
} finally {
  fs.closeSync(fd);
}
if (!/^[a-f0-9]{64}\n$/.test(raw)) {
  throw new Error("Guarded verifier state-instance token encoding is malformed.");
}
const finalToken = fs.lstatSync(tokenName, { bigint: true });
if (
  finalToken.dev !== tokenState.dev ||
  finalToken.ino !== tokenState.ino ||
  finalToken.nlink !== 1n
) {
  throw new Error("Guarded verifier state-instance token changed after read.");
}
assertState(fs.lstatSync(".", { bigint: true }));
assertState(fs.lstatSync(statePath, { bigint: true }));
const digest = crypto.createHash("sha256").update(raw.slice(0, -1)).digest("hex");
if (expectedDigest && digest !== expectedDigest) {
  throw new Error("Guarded verifier state-instance token does not match active state.");
}
process.stdout.write(digest);
NODE
  )" || fail "Guarded verifier state-instance token is unsafe."
  [[ "$digest" =~ ^[a-f0-9]{64}$ ]] ||
    fail "Guarded verifier state-instance token returned a malformed digest."
  VERIFIER_STATE_TOKEN_DIGEST="$digest"
}

oci_assert_pinned_state_dir() {
  [[ -n "$VERIFIER_STATE_PATH" &&
    "$VERIFIER_STATE_DIR_DEV" =~ ^[0-9]+$ &&
    "$VERIFIER_STATE_DIR_INO" =~ ^[0-9]+$ &&
    "$VERIFIER_STATE_TOKEN_DIGEST" =~ ^[a-f0-9]{64}$ ]] ||
    fail "Guarded verifier state root has no valid pinned identity."
  if node - "$VERIFIER_STATE_PATH" \
    "$VERIFIER_STATE_DIR_DEV" "$VERIFIER_STATE_DIR_INO" \
    "$VERIFIER_STATE_TOKEN_DIGEST" <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");

const statePath = process.argv[2];
const expectedDev = BigInt(process.argv[3]);
const expectedIno = BigInt(process.argv[4]);
const expectedTokenDigest = process.argv[5];
const expectedUid = BigInt(process.getuid());
const assertIdentity = (value) => {
  if (
    !value.isDirectory() ||
    value.isSymbolicLink() ||
    value.dev !== expectedDev ||
    value.ino !== expectedIno ||
    value.uid !== expectedUid ||
    Number(value.mode & 0o7777n) !== 0o700
  ) {
    throw new Error("Guarded verifier state root does not match its pinned identity.");
  }
};

const pinned = fs.lstatSync(".", { bigint: true });
const requested = fs.lstatSync(statePath, { bigint: true });
assertIdentity(pinned);
assertIdentity(requested);
if (fs.realpathSync(statePath) !== statePath) {
  throw new Error("Guarded verifier state root no longer has its direct canonical path.");
}
const token = fs.lstatSync(".state-instance", { bigint: true });
if (
  !token.isFile() ||
  token.isSymbolicLink() ||
  token.nlink !== 1n ||
  token.uid !== expectedUid ||
  Number(token.mode & 0o7777n) !== 0o600 ||
  token.size !== 65n
) {
  throw new Error("Guarded verifier state-instance token metadata changed.");
}
const tokenFd = fs.openSync(
  ".state-instance",
  fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
);
let raw;
try {
  const opened = fs.fstatSync(tokenFd, { bigint: true });
  if (opened.dev !== token.dev || opened.ino !== token.ino || opened.nlink !== 1n) {
    throw new Error("Guarded verifier state-instance token changed before validation.");
  }
  raw = fs.readFileSync(tokenFd, "utf8");
} finally {
  fs.closeSync(tokenFd);
}
if (
  !/^[a-f0-9]{64}\n$/.test(raw) ||
  crypto.createHash("sha256").update(raw.slice(0, -1)).digest("hex") !==
    expectedTokenDigest
) {
  throw new Error("Guarded verifier state-instance token identity changed.");
}
const finalToken = fs.lstatSync(".state-instance", { bigint: true });
if (
  finalToken.dev !== token.dev ||
  finalToken.ino !== token.ino ||
  finalToken.nlink !== 1n
) {
  throw new Error("Guarded verifier state-instance token changed after validation.");
}
assertIdentity(fs.lstatSync(".", { bigint: true }));
assertIdentity(fs.lstatSync(statePath, { bigint: true }));
NODE
  then
    :
  else
    VERIFIER_STATE_IDENTITY_FAILED="1"
    fail "Guarded verifier state root identity changed after pinning."
  fi
}

oci_prepare_state_marker_contract() {
  local identity=""
  VERIFIER_STATE_MARKER_PHASE=""
  VERIFIER_STATE_TOKEN_DIGEST=""
  VERIFIER_STATE_PARENT_PATH="$(dirname "$VERIFIER_STATE_PATH")"
  identity="$(
    node - "$VERIFIER_STATE_PARENT_PATH" "$VERIFIER_STATE_PATH" <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const [parentPath, statePath] = process.argv.slice(2);
const parent = fs.lstatSync(parentPath, { bigint: true });
if (
  !parent.isDirectory() ||
  parent.isSymbolicLink() ||
  parent.uid !== BigInt(process.getuid()) ||
  Number(parent.mode & 0o022n) !== 0 ||
  fs.realpathSync(parentPath) !== parentPath
) {
  throw new Error("Guarded verifier state parent is not a direct owner-controlled directory.");
}
const markerName =
  `.openclaw-verifier-active-` +
  crypto.createHash("sha256").update(statePath).digest("hex");
const markerPath = path.join(parentPath, markerName);
const markerTemporaryPath = `${markerPath}.tmp`;
const expectedUid = BigInt(process.getuid());
const markerExpectedUid =
  process.env.OPENCLAW_DOCKER_SETUP_TEST === "1" &&
  process.env.OPENCLAW_TEST_MARKER_OWNER_MISMATCH === "1"
    ? expectedUid + 1n
    : expectedUid;
const lstatOptional = (value) => {
  try {
    return fs.lstatSync(value, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
};
let markerState = lstatOptional(markerPath);
let markerTokenDigest = "";
let markerPhase = "";
const markerTemporaryState = lstatOptional(markerTemporaryPath);
if (markerTemporaryState) {
  if (
    !markerTemporaryState.isFile() ||
    markerTemporaryState.isSymbolicLink() ||
    markerTemporaryState.nlink !== 1n ||
    markerTemporaryState.uid !== markerExpectedUid ||
    Number(markerTemporaryState.mode & 0o7777n) !== 0o600
  ) {
    throw new Error("Guarded verifier active-state marker temporary is unsafe.");
  }
  if (markerState) {
    fs.unlinkSync(markerTemporaryPath);
  } else {
    fs.renameSync(markerTemporaryPath, markerPath);
    markerState = fs.lstatSync(markerPath, { bigint: true });
  }
  const parentFd = fs.openSync(parentPath, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(parentFd);
  } finally {
    fs.closeSync(parentFd);
  }
}
if (markerState) {
  if (
    !markerState.isFile() ||
    markerState.isSymbolicLink() ||
    markerState.nlink !== 1n ||
    markerState.uid !== markerExpectedUid ||
    Number(markerState.mode & 0o7777n) !== 0o600 ||
    markerState.size <= 0n ||
    markerState.size > 16_384n
  ) {
    throw new Error("Guarded verifier active-state marker is unsafe.");
  }
  const fd = fs.openSync(markerPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let marker;
  let markerRaw;
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (
      opened.dev !== markerState.dev ||
      opened.ino !== markerState.ino ||
      opened.nlink !== 1n
    ) {
      throw new Error("Guarded verifier active-state marker changed before read.");
    }
    markerRaw = fs.readFileSync(fd, "utf8");
    marker = JSON.parse(markerRaw);
  } finally {
    fs.closeSync(fd);
  }
  if (
    marker?.contractVersion !== 2 ||
    (marker.markerState !== "active" && marker.markerState !== "cleanup") ||
    marker.statePath !== statePath ||
    !/^[0-9]+$/.test(marker.stateDev) ||
    !/^[0-9]+$/.test(marker.stateIno) ||
    marker.parentDev !== String(parent.dev) ||
    marker.parentIno !== String(parent.ino) ||
    !/^[a-f0-9]{64}$/.test(marker.stateTokenDigest) ||
    typeof marker.operationId !== "string" ||
    !/^(?:recovery|cleanup|[a-f0-9]{32})$/.test(marker.operationId) ||
    !/^[a-f0-9]{64}$/.test(marker.operationBinding) ||
    marker.operationBinding !==
      crypto
        .createHash("sha256")
        .update(`${marker.stateTokenDigest}\0${marker.operationId}`)
        .digest("hex") ||
    markerRaw !== `${JSON.stringify(marker)}\n` ||
    Object.keys(marker).join(",") !==
      "contractVersion,markerState,statePath,stateDev,stateIno,parentDev,parentIno,stateTokenDigest,operationId,operationBinding"
  ) {
    throw new Error("Guarded verifier active-state marker is malformed.");
  }
  markerTokenDigest = marker.stateTokenDigest;
  markerPhase = marker.markerState;
  const expectedDev = BigInt(marker.stateDev);
  const expectedIno = BigInt(marker.stateIno);
  const current = lstatOptional(statePath);
  const injectedAliases = new Set();
  if (
    process.env.OPENCLAW_DOCKER_SETUP_TEST === "1" &&
    process.env.OPENCLAW_TEST_STATE_IDENTITY_ALIASES
  ) {
    for (const candidatePath of process.env.OPENCLAW_TEST_STATE_IDENTITY_ALIASES.split("|")) {
      if (
        !path.isAbsolute(candidatePath) ||
        path.dirname(candidatePath) !== parentPath ||
        path.basename(candidatePath) === markerName
      ) {
        throw new Error("Guarded verifier injected state identity alias is unsafe.");
      }
      injectedAliases.add(candidatePath);
    }
  }
  const identityMatches = (candidatePath, value) =>
    value?.isDirectory() &&
    !value.isSymbolicLink() &&
    ((value.dev === expectedDev && value.ino === expectedIno) ||
      injectedAliases.has(candidatePath));
  const tokenDigest = (candidatePath) => {
    const tokenPath = path.join(candidatePath, ".state-instance");
    const tokenState = lstatOptional(tokenPath);
    if (!tokenState) {
      return undefined;
    }
    if (
      !tokenState.isFile() ||
      tokenState.isSymbolicLink() ||
      tokenState.nlink !== 1n ||
      tokenState.uid !== expectedUid ||
      Number(tokenState.mode & 0o7777n) !== 0o600 ||
      tokenState.size !== 65n
    ) {
      throw new Error("Guarded verifier state-instance token metadata is unsafe.");
    }
    const tokenFd = fs.openSync(tokenPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let raw;
    try {
      const opened = fs.fstatSync(tokenFd, { bigint: true });
      if (
        opened.dev !== tokenState.dev ||
        opened.ino !== tokenState.ino ||
        opened.nlink !== 1n
      ) {
        throw new Error("Guarded verifier state-instance token changed before read.");
      }
      raw = fs.readFileSync(tokenFd, "utf8");
    } finally {
      fs.closeSync(tokenFd);
    }
    if (!/^[a-f0-9]{64}\n$/.test(raw)) {
      throw new Error("Guarded verifier state-instance token encoding is malformed.");
    }
    const finalToken = fs.lstatSync(tokenPath, { bigint: true });
    if (
      finalToken.dev !== tokenState.dev ||
      finalToken.ino !== tokenState.ino ||
      finalToken.nlink !== 1n
    ) {
      throw new Error("Guarded verifier state-instance token changed after read.");
    }
    return crypto.createHash("sha256").update(raw.slice(0, -1)).digest("hex");
  };
  const matches = (candidatePath, value) =>
    identityMatches(candidatePath, value) &&
    tokenDigest(candidatePath) === marker.stateTokenDigest;
  if (!matches(statePath, current)) {
    const displaced = [];
    for (const name of fs.readdirSync(parentPath)) {
      const candidatePath = path.join(parentPath, name);
      const candidate = lstatOptional(candidatePath);
      if (matches(candidatePath, candidate)) {
        displaced.push(candidatePath);
      }
    }
    const location =
      displaced.length === 1
        ? ` retained at ${JSON.stringify(displaced[0])}`
        : ` with ${displaced.length} matching direct children`;
    throw new Error(
      `Active verifier state expects dev=${marker.stateDev} ino=${marker.stateIno}; ` +
        `configured path ${JSON.stringify(statePath)} has a different state instance; ` +
        `original is${location}. ` +
        "Restore the exact original directory before retry.",
    );
  }
}
process.stdout.write(
  `${parent.dev}|${parent.ino}|${markerName}|${markerTokenDigest}|${markerPhase}`,
);
NODE
  )" || fail "Guarded verifier active-state marker contract is unsafe."
  IFS='|' read -r \
    VERIFIER_STATE_PARENT_DEV VERIFIER_STATE_PARENT_INO \
    VERIFIER_STATE_MARKER_NAME VERIFIER_STATE_TOKEN_DIGEST \
    VERIFIER_STATE_MARKER_PHASE <<<"$identity"
  [[ "$VERIFIER_STATE_PARENT_DEV" =~ ^[0-9]+$ &&
    "$VERIFIER_STATE_PARENT_INO" =~ ^[0-9]+$ &&
    "$VERIFIER_STATE_MARKER_NAME" =~ ^\.openclaw-verifier-active-[a-f0-9]{64}$ &&
    ( -z "$VERIFIER_STATE_TOKEN_DIGEST" ||
      "$VERIFIER_STATE_TOKEN_DIGEST" =~ ^[a-f0-9]{64}$ ) &&
    ( -z "$VERIFIER_STATE_MARKER_PHASE" ||
      "$VERIFIER_STATE_MARKER_PHASE" == "active" ||
      "$VERIFIER_STATE_MARKER_PHASE" == "cleanup" ) ]] ||
    fail "Guarded verifier active-state marker identity is malformed."
}

oci_publish_state_marker() {
  local operation_id="${1:-recovery}"
  local operation_binding=""
  [[ "$operation_id" == "recovery" || "$operation_id" == "cleanup" ||
    "$operation_id" =~ ^[a-f0-9]{32}$ ]] ||
    fail "Guarded verifier active-state operation identity is malformed."
  oci_assert_pinned_state_dir
  operation_binding="$(oci_operation_binding "$operation_id")"
  node - "$VERIFIER_STATE_MARKER_NAME" \
    "$VERIFIER_STATE_PARENT_DEV" "$VERIFIER_STATE_PARENT_INO" \
    "$VERIFIER_STATE_PATH" "$VERIFIER_STATE_DIR_DEV" "$VERIFIER_STATE_DIR_INO" \
    "$VERIFIER_STATE_TOKEN_DIGEST" "$operation_id" "$operation_binding" <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");

const [
  markerName,
  expectedParentDev,
  expectedParentIno,
  statePath,
  stateDev,
  stateIno,
  stateTokenDigest,
  operationId,
  operationBinding,
] = process.argv.slice(2);
const expectedUid = BigInt(process.getuid());
process.chdir("..");
const parent = fs.lstatSync(".", { bigint: true });
if (
  !parent.isDirectory() ||
  parent.isSymbolicLink() ||
  String(parent.dev) !== expectedParentDev ||
  String(parent.ino) !== expectedParentIno ||
  parent.uid !== expectedUid
) {
  throw new Error("Guarded verifier active-state marker parent identity changed.");
}
const expected = {
  contractVersion: 2,
  markerState: "active",
  statePath,
  stateDev,
  stateIno,
  parentDev: expectedParentDev,
  parentIno: expectedParentIno,
  stateTokenDigest,
  operationId,
  operationBinding,
};
const readExisting = () => {
  let value;
  try {
    value = fs.lstatSync(markerName, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  if (
    !value.isFile() ||
    value.isSymbolicLink() ||
    value.nlink !== 1n ||
    value.uid !== expectedUid ||
    Number(value.mode & 0o7777n) !== 0o600
  ) {
    throw new Error("Guarded verifier active-state marker is unsafe.");
  }
  const fd = fs.openSync(markerName, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (
      opened.dev !== value.dev ||
      opened.ino !== value.ino ||
      opened.nlink !== 1n
    ) {
      throw new Error("Guarded verifier active-state marker changed before read.");
    }
    const raw = fs.readFileSync(fd, "utf8");
    const parsed = JSON.parse(raw);
    if (raw !== `${JSON.stringify(parsed)}\n`) {
      throw new Error("Guarded verifier active-state marker encoding is not canonical.");
    }
    return parsed;
  } finally {
    fs.closeSync(fd);
  }
};
const existing = readExisting();
if (existing) {
  if (
    existing.contractVersion !== 2 ||
    (existing.markerState !== "active" && existing.markerState !== "cleanup") ||
    existing.statePath !== statePath ||
    existing.stateDev !== stateDev ||
    existing.stateIno !== stateIno ||
    existing.parentDev !== expectedParentDev ||
    existing.parentIno !== expectedParentIno ||
    existing.stateTokenDigest !== stateTokenDigest ||
    typeof existing.operationId !== "string" ||
    !/^(?:recovery|cleanup|[a-f0-9]{32})$/.test(existing.operationId) ||
    !/^[a-f0-9]{64}$/.test(existing.operationBinding) ||
    existing.operationBinding !==
      crypto
        .createHash("sha256")
        .update(`${stateTokenDigest}\0${existing.operationId}`)
        .digest("hex") ||
    Object.keys(existing).sort().join(",") !==
      "contractVersion,markerState,operationBinding,operationId,parentDev,parentIno,stateDev,stateIno,statePath,stateTokenDigest"
  ) {
    throw new Error("Guarded verifier active-state marker conflicts with pinned state.");
  }
  process.exit(0);
}
const temporary = `${markerName}.tmp`;
let fd;
try {
  fd = fs.openSync(
    temporary,
    fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      fs.constants.O_NOFOLLOW,
    0o600,
  );
  fs.writeFileSync(fd, `${JSON.stringify(expected)}\n`);
  fs.fsyncSync(fd);
  const written = fs.fstatSync(fd, { bigint: true });
  if (
    !written.isFile() ||
    written.isSymbolicLink() ||
    written.nlink !== 1n ||
    written.uid !== expectedUid ||
    Number(written.mode & 0o7777n) !== 0o600
  ) {
    throw new Error("Guarded verifier active-state marker temporary is unsafe.");
  }
  fs.closeSync(fd);
  fd = undefined;
  if (readExisting()) {
    throw new Error("Guarded verifier active-state marker appeared before publication.");
  }
  fs.renameSync(temporary, markerName);
  const parentFd = fs.openSync(".", fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(parentFd);
  } finally {
    fs.closeSync(parentFd);
  }
} finally {
  if (fd !== undefined) {
    fs.closeSync(fd);
  }
}
NODE
}

oci_mark_state_cleanup() {
  local operation_binding=""
  [[ -n "$VERIFIER_STATE_MARKER_NAME" ]] || return
  oci_assert_pinned_state_dir
  operation_binding="$(oci_operation_binding cleanup)"
  node - "$VERIFIER_STATE_MARKER_NAME" \
    "$VERIFIER_STATE_PARENT_DEV" "$VERIFIER_STATE_PARENT_INO" \
    "$VERIFIER_STATE_PATH" "$VERIFIER_STATE_DIR_DEV" "$VERIFIER_STATE_DIR_INO" \
    "$VERIFIER_STATE_TOKEN_DIGEST" "$operation_binding" <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");

const [
  markerName,
  expectedParentDev,
  expectedParentIno,
  statePath,
  stateDev,
  stateIno,
  stateTokenDigest,
  cleanupBinding,
] = process.argv.slice(2);
const expectedUid = BigInt(process.getuid());
process.chdir("..");
const parent = fs.lstatSync(".", { bigint: true });
if (
  !parent.isDirectory() ||
  parent.isSymbolicLink() ||
  String(parent.dev) !== expectedParentDev ||
  String(parent.ino) !== expectedParentIno ||
  parent.uid !== expectedUid
) {
  throw new Error("Guarded verifier active-state marker parent changed before cleanup phase.");
}
const markerState = fs.lstatSync(markerName, { bigint: true });
if (
  !markerState.isFile() ||
  markerState.isSymbolicLink() ||
  markerState.nlink !== 1n ||
  markerState.uid !== expectedUid ||
  Number(markerState.mode & 0o7777n) !== 0o600
) {
  throw new Error("Guarded verifier active-state marker is unsafe before cleanup phase.");
}
const markerFd = fs.openSync(markerName, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
let marker;
let raw;
try {
  const opened = fs.fstatSync(markerFd, { bigint: true });
  if (
    opened.dev !== markerState.dev ||
    opened.ino !== markerState.ino ||
    opened.nlink !== 1n
  ) {
    throw new Error("Guarded verifier active-state marker changed before cleanup phase.");
  }
  raw = fs.readFileSync(markerFd, "utf8");
  marker = JSON.parse(raw);
} finally {
  fs.closeSync(markerFd);
}
if (
  marker?.contractVersion !== 2 ||
  (marker.markerState !== "active" && marker.markerState !== "cleanup") ||
  marker.statePath !== statePath ||
  marker.stateDev !== stateDev ||
  marker.stateIno !== stateIno ||
  marker.parentDev !== expectedParentDev ||
  marker.parentIno !== expectedParentIno ||
  marker.stateTokenDigest !== stateTokenDigest ||
  typeof marker.operationId !== "string" ||
  !/^(?:recovery|cleanup|[a-f0-9]{32})$/.test(marker.operationId) ||
  marker.operationBinding !==
    crypto
      .createHash("sha256")
      .update(`${stateTokenDigest}\0${marker.operationId}`)
      .digest("hex") ||
  raw !== `${JSON.stringify(marker)}\n` ||
  Object.keys(marker).join(",") !==
    "contractVersion,markerState,statePath,stateDev,stateIno,parentDev,parentIno,stateTokenDigest,operationId,operationBinding"
) {
  throw new Error("Guarded verifier active-state marker is malformed before cleanup phase.");
}
if (marker.markerState === "cleanup") {
  if (marker.operationId !== "cleanup" || marker.operationBinding !== cleanupBinding) {
    throw new Error("Guarded verifier cleanup marker has a stale operation binding.");
  }
  process.exit(0);
}
const cleanupMarker = {
  ...marker,
  markerState: "cleanup",
  operationId: "cleanup",
  operationBinding: cleanupBinding,
};
const temporary = `${markerName}.tmp`;
let temporaryFd;
try {
  temporaryFd = fs.openSync(
    temporary,
    fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      fs.constants.O_NOFOLLOW,
    0o600,
  );
  fs.writeFileSync(temporaryFd, `${JSON.stringify(cleanupMarker)}\n`);
  fs.fsyncSync(temporaryFd);
  const written = fs.fstatSync(temporaryFd, { bigint: true });
  if (
    !written.isFile() ||
    written.isSymbolicLink() ||
    written.nlink !== 1n ||
    written.uid !== expectedUid ||
    Number(written.mode & 0o7777n) !== 0o600
  ) {
    throw new Error("Guarded verifier cleanup marker temporary is unsafe.");
  }
  fs.closeSync(temporaryFd);
  temporaryFd = undefined;
  const finalMarker = fs.lstatSync(markerName, { bigint: true });
  if (
    finalMarker.dev !== markerState.dev ||
    finalMarker.ino !== markerState.ino ||
    finalMarker.nlink !== 1n
  ) {
    throw new Error("Guarded verifier active-state marker changed before cleanup publication.");
  }
  fs.renameSync(temporary, markerName);
  const parentFd = fs.openSync(".", fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(parentFd);
  } finally {
    fs.closeSync(parentFd);
  }
} finally {
  if (temporaryFd !== undefined) {
    fs.closeSync(temporaryFd);
  }
}
NODE
  VERIFIER_STATE_MARKER_PHASE="cleanup"
}

oci_remove_state_marker() {
  [[ -n "$VERIFIER_STATE_MARKER_NAME" ]] || return
  oci_assert_pinned_state_dir
  node - "$VERIFIER_STATE_MARKER_NAME" \
    "$VERIFIER_STATE_PARENT_DEV" "$VERIFIER_STATE_PARENT_INO" \
    "$VERIFIER_STATE_PATH" "$VERIFIER_STATE_DIR_DEV" "$VERIFIER_STATE_DIR_INO" \
    "$VERIFIER_STATE_TOKEN_DIGEST" <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");

const [
  markerName,
  expectedParentDev,
  expectedParentIno,
  statePath,
  stateDev,
  stateIno,
  stateTokenDigest,
] = process.argv.slice(2);
process.chdir("..");
const parent = fs.lstatSync(".", { bigint: true });
if (
  !parent.isDirectory() ||
  parent.isSymbolicLink() ||
  String(parent.dev) !== expectedParentDev ||
  String(parent.ino) !== expectedParentIno ||
  parent.uid !== BigInt(process.getuid())
) {
  throw new Error("Guarded verifier active-state marker parent identity changed before cleanup.");
}
let markerState;
try {
  markerState = fs.lstatSync(markerName, { bigint: true });
} catch (error) {
  if (error?.code === "ENOENT") {
    process.exit(0);
  }
  throw error;
}
if (
  !markerState.isFile() ||
  markerState.isSymbolicLink() ||
  markerState.nlink !== 1n ||
  markerState.uid !== BigInt(process.getuid()) ||
  Number(markerState.mode & 0o7777n) !== 0o600
) {
  throw new Error("Guarded verifier active-state marker is unsafe before cleanup.");
}
const markerFd = fs.openSync(markerName, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
let marker;
let markerRaw;
try {
  const openedMarker = fs.fstatSync(markerFd, { bigint: true });
  if (
    openedMarker.dev !== markerState.dev ||
    openedMarker.ino !== markerState.ino ||
    openedMarker.nlink !== 1n
  ) {
    throw new Error("Guarded verifier active-state marker changed before cleanup read.");
  }
  markerRaw = fs.readFileSync(markerFd, "utf8");
  marker = JSON.parse(markerRaw);
} finally {
  fs.closeSync(markerFd);
}
if (
  marker?.contractVersion !== 2 ||
  marker.markerState !== "cleanup" ||
  marker.statePath !== statePath ||
  marker.stateDev !== stateDev ||
  marker.stateIno !== stateIno ||
  marker.parentDev !== expectedParentDev ||
  marker.parentIno !== expectedParentIno ||
  marker.stateTokenDigest !== stateTokenDigest ||
  typeof marker.operationId !== "string" ||
  marker.operationId !== "cleanup" ||
  !/^[a-f0-9]{64}$/.test(marker.operationBinding) ||
  marker.operationBinding !==
    crypto
      .createHash("sha256")
      .update(`${stateTokenDigest}\0${marker.operationId}`)
      .digest("hex") ||
  markerRaw !== `${JSON.stringify(marker)}\n` ||
  Object.keys(marker).join(",") !==
    "contractVersion,markerState,statePath,stateDev,stateIno,parentDev,parentIno,stateTokenDigest,operationId,operationBinding"
) {
  throw new Error("Guarded verifier active-state marker identity changed before cleanup.");
}
const finalMarkerState = fs.lstatSync(markerName, { bigint: true });
if (
  finalMarkerState.dev !== markerState.dev ||
  finalMarkerState.ino !== markerState.ino ||
  finalMarkerState.nlink !== 1n
) {
  throw new Error("Guarded verifier active-state marker changed before cleanup unlink.");
}
fs.unlinkSync(markerName);
const parentFd = fs.openSync(".", fs.constants.O_RDONLY);
try {
  fs.fsyncSync(parentFd);
} finally {
  fs.closeSync(parentFd);
}
NODE
}

oci_pin_state_dir() {
  local identity=""
  local state_path="$VERIFIER_STATE_DIR"
  identity="$(
    node - "$state_path" <<'NODE'
const fs = require("node:fs");

const statePath = process.argv[2];
const before = fs.lstatSync(statePath, { bigint: true });
if (
  !before.isDirectory() ||
  before.isSymbolicLink() ||
  before.uid !== BigInt(process.getuid()) ||
  Number(before.mode & 0o7777n) !== 0o700 ||
  fs.realpathSync(statePath) !== statePath
) {
  throw new Error("Guarded verifier state root is not a direct owner-only directory.");
}
process.stdout.write(`${before.dev}|${before.ino}`);
NODE
  )" || fail "Guarded verifier state root could not be pinned safely."
  IFS='|' read -r VERIFIER_STATE_DIR_DEV VERIFIER_STATE_DIR_INO <<<"$identity"
  [[ "$VERIFIER_STATE_DIR_DEV" =~ ^[0-9]+$ &&
    "$VERIFIER_STATE_DIR_INO" =~ ^[0-9]+$ ]] ||
    fail "Guarded verifier state root returned malformed identity."
  VERIFIER_STATE_PATH="$state_path"
  cd "$VERIFIER_STATE_PATH" ||
    fail "Guarded verifier state root could not become the pinned working directory."
  oci_prepare_state_instance_token "$VERIFIER_STATE_TOKEN_DIGEST"
  oci_assert_pinned_state_dir
  # All lifecycle paths remain relative to the pinned CWD. Repository and
  # Compose inputs use their explicit absolute paths.
  VERIFIER_STATE_DIR="."
  VERIFIER_TRANSACTION_DIR="transaction"
  VERIFIER_LOCK_DIR="lock"
}

oci_wait_state_dir_test_barrier() {
  if [[ "${OPENCLAW_DOCKER_SETUP_TEST:-}" != "1" ||
    -z "${OPENCLAW_TEST_STATE_ROOT_READY:-}" ||
    -z "${OPENCLAW_TEST_STATE_ROOT_CONTINUE:-}" ]]; then
    return
  fi
  node - "$OPENCLAW_TEST_STATE_ROOT_READY" "$OPENCLAW_TEST_STATE_ROOT_CONTINUE" \
    "$VERIFIER_STATE_PATH" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const ready = process.argv[2];
const proceed = process.argv[3];
const statePath = process.argv[4];
if (!path.isAbsolute(ready) || !path.isAbsolute(proceed) || !path.isAbsolute(statePath)) {
  throw new Error("Verifier state-root test barrier paths must be absolute.");
}
fs.writeFileSync(ready, `${statePath}\n`, { flag: "wx", mode: 0o600 });
const deadline = Date.now() + 10_000;
const waitState = new Int32Array(new SharedArrayBuffer(4));
while (!fs.existsSync(proceed)) {
  if (Date.now() >= deadline) {
    throw new Error("Verifier state-root test barrier timed out.");
  }
  Atomics.wait(waitState, 0, 0, 10);
}
NODE
}

oci_wait_transaction_state_test_barrier() {
  local phase="$1"
  if [[ "${OPENCLAW_DOCKER_SETUP_TEST:-}" != "1" ||
    "${OPENCLAW_TEST_TRANSACTION_STATE_PHASE:-}" != "$phase" ||
    -z "${OPENCLAW_TEST_TRANSACTION_STATE_READY:-}" ||
    -z "${OPENCLAW_TEST_TRANSACTION_STATE_CONTINUE:-}" ]]; then
    return
  fi
  node - "$OPENCLAW_TEST_TRANSACTION_STATE_READY" \
    "$OPENCLAW_TEST_TRANSACTION_STATE_CONTINUE" "$phase" "$VERIFIER_STATE_PATH" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const [ready, proceed, phase, statePath] = process.argv.slice(2);
if (!path.isAbsolute(ready) || !path.isAbsolute(proceed) || !path.isAbsolute(statePath)) {
  throw new Error("Verifier transaction-state test barrier paths must be absolute.");
}
fs.writeFileSync(ready, `${phase}\t${statePath}\n`, { flag: "wx", mode: 0o600 });
const deadline = Date.now() + 10_000;
const waitState = new Int32Array(new SharedArrayBuffer(4));
while (!fs.existsSync(proceed)) {
  if (Date.now() >= deadline) {
    throw new Error("Verifier transaction-state test barrier timed out.");
  }
  Atomics.wait(waitState, 0, 0, 10);
}
NODE
  if [[ "${OPENCLAW_TEST_TRANSACTION_STATE_SIGKILL:-}" == "1" ]]; then
    kill -9 "$$"
  fi
}

oci_assert_state_dir() {
  local canonical=""
  local canonical_pair=""
  local gateway_config=""
  local verifier_workspace_canonical=""
  umask 077
  [[ "$VERIFIER_STATE_DIR" == /* ]] ||
    fail "Guarded verifier state root must be an absolute path."
  [[ -n "${OPENCLAW_VERIFIER_WORKSPACE_DIR:-}" &&
    "$OPENCLAW_VERIFIER_WORKSPACE_DIR" == /* ]] ||
    fail "Guarded verifier workspace must be an absolute path."
  canonical_pair="$(
    node - "$VERIFIER_STATE_DIR" "$OPENCLAW_VERIFIER_WORKSPACE_DIR" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const allowDarwinVarAlias = (requested, actual) =>
  process.platform === "darwin" &&
  (requested === "/var" || requested.startsWith("/var/")) &&
  actual === `/private${requested}`;

const assertCanonicalAlias = (label, requested, actual) => {
  if (requested !== actual && !allowDarwinVarAlias(requested, actual)) {
    throw new Error(`${label} traverses a symlink.`);
  }
};

const canonicalizeExisting = (label, value) => {
  const requested = path.resolve(value);
  const actual = fs.realpathSync(value);
  assertCanonicalAlias(label, requested, actual);
  const stat = fs.statSync(actual);
  if (!stat.isDirectory()) {
    throw new Error(`${label} is not a directory.`);
  }
  return actual;
};

const canonicalizeProspective = (label, value) => {
  const requested = path.resolve(value);
  let cursor = requested;
  const suffix = [];
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      throw new Error(`${label} has no existing canonical ancestor.`);
    }
    suffix.unshift(path.basename(cursor));
    cursor = parent;
  }
  const actualAncestor = fs.realpathSync(cursor);
  const actual = path.join(actualAncestor, ...suffix);
  assertCanonicalAlias(label, requested, actual);
  if (fs.existsSync(requested)) {
    const requestedStat = fs.lstatSync(requested);
    if (requestedStat.isSymbolicLink()) {
      throw new Error(`${label} must not be a symlink.`);
    }
    if (!requestedStat.isDirectory()) {
      throw new Error(`${label} is not a directory.`);
    }
    const existingActual = fs.realpathSync(requested);
    assertCanonicalAlias(label, requested, existingActual);
    return existingActual;
  }
  return actual;
};

const overlaps = (left, right) =>
  left === right ||
  left.startsWith(`${right}${path.sep}`) ||
  right.startsWith(`${left}${path.sep}`);

const state = canonicalizeProspective(
  "Guarded verifier state root",
  process.argv[2],
);
const workspace = canonicalizeExisting(
  "Guarded verifier workspace",
  process.argv[3],
);
if (overlaps(state, workspace)) {
  throw new Error("Guarded verifier state root overlaps the declared verifier workspace.");
}
process.stdout.write(`${state}\t${workspace}`);
NODE
  )" || fail "Guarded verifier state root or workspace is not safely canonical."
  IFS=$'\t' read -r canonical verifier_workspace_canonical <<<"$canonical_pair"
  [[ -n "$canonical" && -n "$verifier_workspace_canonical" ]] ||
    fail "Guarded verifier state root or workspace canonicalization returned incomplete output."
  VERIFIER_STATE_DIR="$canonical"
  VERIFIER_TRANSACTION_DIR="$VERIFIER_STATE_DIR/transaction"
  VERIFIER_LOCK_DIR="$VERIFIER_STATE_DIR/lock"
  OPENCLAW_VERIFIER_WORKSPACE_DIR="$verifier_workspace_canonical"
  export OPENCLAW_VERIFIER_WORKSPACE_DIR
  mkdir -p "$(dirname "$VERIFIER_STATE_DIR")"
  VERIFIER_STATE_PATH="$VERIFIER_STATE_DIR"
  oci_prepare_state_marker_contract
  [[ ! -L "$VERIFIER_STATE_DIR" ]] ||
    fail "Guarded verifier state directory must not be a symlink."
  [[ -d "$VERIFIER_STATE_DIR" ]] || mkdir -m 700 "$VERIFIER_STATE_DIR"
  oci_assert_owned_mode "$VERIFIER_STATE_DIR" 700
  oci_pin_state_dir
  gateway_config="$(docker compose "${COMPOSE_ARGS[@]}" config --format json)"
  printf '%s' "$gateway_config" |
    node -e '
      const fs = require("node:fs");
      const path = require("node:path");
      const state = fs.realpathSync(process.argv[1]);
      const config = JSON.parse(fs.readFileSync(0, "utf8"));
      const service = config.services?.["openclaw-gateway"];
      if (!service || !Array.isArray(service.volumes)) {
        throw new Error("Gateway Compose configuration has no bounded volume inventory.");
      }
      const overlaps = (left, right) =>
        left === right ||
        left.startsWith(`${right}${path.sep}`) ||
        right.startsWith(`${left}${path.sep}`);
      for (const volume of service.volumes) {
        if (
          typeof volume !== "object" ||
          volume === null ||
          volume.type !== "bind"
        ) {
          continue;
        }
        if (typeof volume.source !== "string" || !path.isAbsolute(volume.source)) {
          throw new Error("Gateway bind source is not an absolute path.");
        }
        const source = fs.realpathSync(volume.source);
        if (overlaps(state, source)) {
          throw new Error("Guarded verifier state root overlaps a Gateway bind.");
        }
      }
    ' "$VERIFIER_STATE_PATH" ||
    fail "Guarded verifier state root is not isolated from Gateway binds."
  oci_wait_state_dir_test_barrier
  oci_assert_pinned_state_dir
}

oci_restore_stable_tag() {
  local old_image_id="$1"
  local current=""
  current="$(
    docker image inspect --format '{{.Id}}' openclaw-sandbox-verifier:bookworm-slim 2>/dev/null ||
      true
  )"
  if [[ -n "$current" && "$current" != "$old_image_id" ]]; then
    docker image rm openclaw-sandbox-verifier:bookworm-slim >/dev/null
  fi
  if [[ "$old_image_id" =~ ^sha256:[a-f0-9]{64}$ ]]; then
    docker tag "$old_image_id" openclaw-sandbox-verifier:bookworm-slim
  fi
}

oci_backup_transaction_file() {
  local source="$1"
  local backup="$2"
  local required="$3"
  local present_var="$4"
  local digest_var="$5"
  local mode_var="$6"
  local parent_dev_var="$7"
  local parent_ino_var="$8"
  local metadata=""
  [[ "$required" == "0" || "$required" == "1" ]] ||
    fail "Verifier transaction backup requirement is malformed."
  if metadata="$(
    node - "$source" "$backup" "$required" \
      "$VERIFIER_STATE_DIR_DEV" "$VERIFIER_STATE_DIR_INO" <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const [source, backup, required, expectedStateDev, expectedStateIno] = process.argv.slice(2);
if (path.isAbsolute(backup) || !path.isAbsolute(source)) {
  throw new Error("Verifier transaction input must be absolute and backup must be state-relative.");
}
const pinnedState = fs.lstatSync(".", { bigint: true });
if (
  !pinnedState.isDirectory() ||
  pinnedState.isSymbolicLink() ||
  String(pinnedState.dev) !== expectedStateDev ||
  String(pinnedState.ino) !== expectedStateIno
) {
  throw new Error("Verifier transaction backup did not inherit the pinned state root.");
}
const directory = path.dirname(source);
const leaf = path.basename(source);
if (leaf === "." || leaf === ".." || path.join(directory, leaf) !== path.normalize(source)) {
  throw new Error("Verifier transaction input leaf is malformed.");
}
const requestedParent = fs.lstatSync(directory, { bigint: true });
if (!requestedParent.isDirectory() || requestedParent.isSymbolicLink()) {
  throw new Error("Verifier transaction input parent is not a direct directory.");
}
const sameIdentity = (left, right) =>
  left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
const backupDirectory = path.dirname(backup);
const backupLeaf = path.basename(backup);
if (
  backupDirectory !== "transaction" ||
  backupLeaf === "." ||
  backupLeaf === ".." ||
  path.join(backupDirectory, backupLeaf) !== path.normalize(backup)
) {
  throw new Error("Verifier transaction backup leaf is malformed.");
}
const requestedBackupParent = fs.lstatSync(backupDirectory, { bigint: true });
if (!requestedBackupParent.isDirectory() || requestedBackupParent.isSymbolicLink()) {
  throw new Error("Verifier transaction backup parent is not a direct directory.");
}
const assertRequestedParent = () => {
  const current = fs.lstatSync(directory, { bigint: true });
  if (
    !current.isDirectory() ||
    current.isSymbolicLink() ||
    !sameIdentity(requestedParent, current)
  ) {
    throw new Error("Verifier transaction input parent identity changed.");
  }
};
const lstatOptional = (value) => {
  try {
    return fs.lstatSync(value);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
};
const beforePath = lstatOptional(source);
if (!beforePath) {
  if (required === "1") {
    throw new Error("Required verifier transaction input is missing.");
  }
  assertRequestedParent();
  process.stdout.write(`0|||${requestedParent.dev}|${requestedParent.ino}`);
  process.exit(0);
}
if (!beforePath.isFile() || beforePath.isSymbolicLink() || beforePath.nlink !== 1) {
  throw new Error("Verifier transaction input is not a direct single-link regular file.");
}
process.chdir(backupDirectory);
if (!sameIdentity(requestedBackupParent, fs.lstatSync(".", { bigint: true }))) {
  throw new Error("Verifier transaction backup parent changed before it was pinned.");
}
let sourceFd;
let backupFd;
let backupDirectoryFd;
let backupIdentity;
try {
  backupFd = fs.openSync(
    backupLeaf,
    fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      fs.constants.O_NOFOLLOW,
    0o600,
  );
  backupDirectoryFd = fs.openSync(".", fs.constants.O_RDONLY);
  backupIdentity = fs.fstatSync(backupFd);
  if (backupIdentity.nlink !== 1) {
    throw new Error("Verifier transaction backup is not a single-link file.");
  }
  process.chdir(directory);
  const pinnedParent = fs.lstatSync(".", { bigint: true });
  if (!sameIdentity(requestedParent, pinnedParent)) {
    throw new Error("Verifier transaction input parent changed after backup pinning.");
  }
  const finalBeforePath = fs.lstatSync(leaf);
  if (!sameIdentity(beforePath, finalBeforePath) || finalBeforePath.nlink !== 1) {
    throw new Error("Verifier transaction input changed before it was opened.");
  }
  sourceFd = fs.openSync(leaf, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const beforeFd = fs.fstatSync(sourceFd);
  if (!sameIdentity(beforeFd, beforePath) || beforeFd.nlink !== 1) {
    throw new Error("Verifier transaction input identity changed before backup.");
  }
  if (
    process.env.OPENCLAW_DOCKER_SETUP_TEST === "1" &&
    process.env.OPENCLAW_TEST_BACKUP_READY &&
    process.env.OPENCLAW_TEST_BACKUP_CONTINUE &&
    process.env.OPENCLAW_TEST_BACKUP_TARGET === source
  ) {
    const ready = process.env.OPENCLAW_TEST_BACKUP_READY;
    const proceed = process.env.OPENCLAW_TEST_BACKUP_CONTINUE;
    if (!path.isAbsolute(ready) || !path.isAbsolute(proceed)) {
      throw new Error("Verifier transaction backup test barrier paths must be absolute.");
    }
    fs.writeFileSync(ready, `${source}\n`, { flag: "wx", mode: 0o600 });
    const deadline = Date.now() + 10_000;
    const waitState = new Int32Array(new SharedArrayBuffer(4));
    while (!fs.existsSync(proceed)) {
      if (Date.now() >= deadline) {
        throw new Error("Verifier transaction backup test barrier timed out.");
      }
      Atomics.wait(waitState, 0, 0, 10);
    }
  }
  const readSnapshot = (size) => {
    const value = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const count = fs.readSync(sourceFd, value, offset, size - offset, offset);
      if (count === 0) {
        throw new Error("Verifier transaction input changed while being read.");
      }
      offset += count;
    }
    return value;
  };
  const first = readSnapshot(beforeFd.size);
  const middleFd = fs.fstatSync(sourceFd);
  const second = readSnapshot(middleFd.size);
  const afterFd = fs.fstatSync(sourceFd);
  const finalPath = fs.lstatSync(leaf);
  if (
    !sameIdentity(beforeFd, afterFd) ||
    !sameIdentity(beforeFd, finalPath) ||
    afterFd.nlink !== 1 ||
    finalPath.nlink !== 1 ||
    beforeFd.size !== afterFd.size ||
    beforeFd.mtimeMs !== afterFd.mtimeMs ||
    beforeFd.ctimeMs !== afterFd.ctimeMs ||
    middleFd.size !== beforeFd.size ||
    !first.equals(second)
  ) {
    throw new Error("Verifier transaction input changed during backup.");
  }
  fs.writeFileSync(backupFd, first);
  fs.fsyncSync(backupFd);
  fs.fsyncSync(backupDirectoryFd);
  const finalBackup = fs.fstatSync(backupFd);
  if (!sameIdentity(backupIdentity, finalBackup) || finalBackup.nlink !== 1) {
    throw new Error("Verifier transaction backup identity changed while being written.");
  }
  assertRequestedParent();
  if (!sameIdentity(requestedBackupParent, fs.fstatSync(backupDirectoryFd, { bigint: true }))) {
    throw new Error("Verifier transaction backup parent identity changed.");
  }
  const mode = (beforeFd.mode & 0o7777).toString(8);
  const digest = crypto.createHash("sha256").update(first).digest("hex");
  process.stdout.write(
    `1|${mode}|${digest}|${requestedParent.dev}|${requestedParent.ino}`,
  );
} finally {
  if (sourceFd !== undefined) {
    fs.closeSync(sourceFd);
  }
  if (backupFd !== undefined) {
    fs.closeSync(backupFd);
  }
  if (backupDirectoryFd !== undefined) {
    fs.closeSync(backupDirectoryFd);
  }
}
NODE
  )"; then
    :
  else
    fail "Refusing to back up unsafe or changing verifier transaction input."
  fi
  IFS='|' read -r \
    "$present_var" "$mode_var" "$digest_var" "$parent_dev_var" "$parent_ino_var" \
    <<<"$metadata"
  [[ "${!present_var}" == "0" || "${!present_var}" == "1" ]] ||
    fail "Verifier transaction backup returned malformed presence metadata."
  [[ "${!parent_dev_var}" =~ ^[0-9]+$ && "${!parent_ino_var}" =~ ^[0-9]+$ ]] ||
    fail "Verifier transaction backup returned malformed parent identity."
  if [[ "${!present_var}" == "1" ]]; then
    [[ "${!mode_var}" =~ ^[0-7]{3,4}$ && "${!digest_var}" =~ ^[a-f0-9]{64}$ ]] ||
      fail "Verifier transaction backup returned malformed file metadata."
  else
    [[ "$required" == "0" && -z "${!mode_var}" && -z "${!digest_var}" ]] ||
      fail "Verifier transaction backup returned contradictory absent-file metadata."
  fi
}

oci_restore_transaction_file() {
  local target="$1"
  local backup="$2"
  local present="$3"
  local digest="$4"
  local mode="$5"
  local parent_dev="$6"
  local parent_ino="$7"
  local restore_kind="$8"
  [[ "$present" == "0" || "$present" == "1" ]] ||
    fail "Verifier recovery file state is malformed."
  [[ "$parent_dev" =~ ^[0-9]+$ && "$parent_ino" =~ ^[0-9]+$ ]] ||
    fail "Verifier recovery parent identity is malformed."
  [[ "$restore_kind" == "env" || "$restore_kind" == "config" ||
    "$restore_kind" == "overlay" ]] ||
    fail "Verifier recovery target kind is malformed."
  if [[ "$present" == "0" ]]; then
    [[ -z "$digest" && -z "$mode" ]] ||
      fail "Verifier recovery found contradictory absent-file metadata."
  else
    [[ "$digest" =~ ^[a-f0-9]{64}$ && "$mode" =~ ^[0-7]{3,4}$ ]] ||
      fail "Verifier recovery optional-file metadata is malformed."
  fi
  oci_assert_pinned_state_dir
  if node - "$target" "$backup" "$present" "$digest" "$mode" \
    "$parent_dev" "$parent_ino" "$VERIFIER_TRANSACTION_DIR" \
    "$VERIFIER_TRANSACTION_DIR_DEV" "$VERIFIER_TRANSACTION_DIR_INO" \
    "$VERIFIER_STATE_DIR_DEV" "$VERIFIER_STATE_DIR_INO" "$restore_kind" <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const [
  target,
  backupInput,
  present,
  expectedDigest,
  expectedMode,
  expectedParentDev,
  expectedParentIno,
  transactionDirectoryInput,
  expectedTransactionDev,
  expectedTransactionIno,
  expectedStateDev,
  expectedStateIno,
  restoreKind,
] = process.argv.slice(2);
if (
  path.isAbsolute(backupInput) ||
  path.isAbsolute(transactionDirectoryInput) ||
  path.dirname(transactionDirectoryInput) !== "." ||
  path.basename(transactionDirectoryInput) !== "transaction" ||
  path.dirname(backupInput) !== transactionDirectoryInput
) {
  throw new Error("Verifier recovery state paths must be direct state-relative leaves.");
}
const pinnedState = fs.lstatSync(".", { bigint: true });
if (
  !pinnedState.isDirectory() ||
  pinnedState.isSymbolicLink() ||
  String(pinnedState.dev) !== expectedStateDev ||
  String(pinnedState.ino) !== expectedStateIno
) {
  throw new Error("Verifier recovery did not inherit the pinned state root.");
}
// Resolve only from the kernel-retained pinned CWD, never from the configured
// state-root pathname. Exact transaction identity checks guard every reuse.
const backup = path.resolve(backupInput);
const transactionDirectory = path.resolve(transactionDirectoryInput);
if (
  !path.isAbsolute(target) ||
  !path.isAbsolute(transactionDirectory)
) {
  throw new Error("Verifier recovery paths must be absolute.");
}
const requestedTransactionDirectory = fs.lstatSync(transactionDirectory, { bigint: true });
const assertRequestedTransactionDirectory = () => {
  const current = fs.lstatSync(transactionDirectory, { bigint: true });
  if (
    !current.isDirectory() ||
    current.isSymbolicLink() ||
    current.dev !== requestedTransactionDirectory.dev ||
    current.ino !== requestedTransactionDirectory.ino ||
    current.mode !== requestedTransactionDirectory.mode ||
    String(current.dev) !== expectedTransactionDev ||
    String(current.ino) !== expectedTransactionIno ||
    Number(current.mode & 0o7777n) !== 0o700 ||
    current.uid !== BigInt(process.getuid())
  ) {
    throw new Error("Verifier recovery transaction directory identity changed.");
  }
};
const pinTransactionDirectory = () => {
  assertRequestedTransactionDirectory();
  process.chdir(transactionDirectory);
  const pinned = fs.lstatSync(".", { bigint: true });
  if (
    pinned.dev !== requestedTransactionDirectory.dev ||
    pinned.ino !== requestedTransactionDirectory.ino ||
    pinned.mode !== requestedTransactionDirectory.mode
  ) {
    throw new Error("Verifier recovery transaction directory changed before it was pinned.");
  }
  assertRequestedTransactionDirectory();
};
const assertTransactionDirectoryPinned = () => {
  const pinned = fs.lstatSync(".", { bigint: true });
  const current = fs.lstatSync(transactionDirectory, { bigint: true });
  if (
    !pinned.isDirectory() ||
    pinned.isSymbolicLink() ||
    pinned.dev !== current.dev ||
    pinned.ino !== current.ino ||
    String(pinned.dev) !== expectedTransactionDev ||
    String(pinned.ino) !== expectedTransactionIno ||
    Number(pinned.mode & 0o7777n) !== 0o700 ||
    pinned.uid !== BigInt(process.getuid())
  ) {
    throw new Error("Verifier recovery transaction directory identity changed.");
  }
};
pinTransactionDirectory();
assertTransactionDirectoryPinned();
const journalPath = "journal";
const restoreKeys = [
  "restore-kind",
  "restore-state",
  "restore-temp-name",
  "restore-temp-dev",
  "restore-temp-ino",
  "restore-target-present",
  "restore-target-dev",
  "restore-target-ino",
];
const readJournal = () => {
  pinTransactionDirectory();
  assertTransactionDirectoryPinned();
  const journalPathState = fs.lstatSync(journalPath, { bigint: true });
  if (
    !journalPathState.isFile() ||
    journalPathState.isSymbolicLink() ||
    journalPathState.nlink !== 1n ||
    journalPathState.size <= 0n ||
    journalPathState.size > 65_536n ||
    Number(journalPathState.mode & 0o7777n) !== 0o600 ||
    journalPathState.uid !== BigInt(process.getuid())
  ) {
    throw new Error("Verifier recovery journal is unsafe.");
  }
  const journalFd = fs.openSync(journalPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let journalValue;
  try {
    const opened = fs.fstatSync(journalFd, { bigint: true });
    if (
      opened.dev !== journalPathState.dev ||
      opened.ino !== journalPathState.ino ||
      opened.nlink !== 1n
    ) {
      throw new Error("Verifier recovery journal changed before it was opened.");
    }
    journalValue = fs.readFileSync(journalFd, "utf8");
  } finally {
    fs.closeSync(journalFd);
  }
  assertTransactionDirectoryPinned();
  const lines = journalValue.split("\n");
  if (lines.at(-1) !== "") {
    throw new Error("Verifier recovery journal is not newline terminated.");
  }
  lines.pop();
  const values = new Map();
  for (const line of lines) {
    const separator = line.indexOf("=");
    if (separator <= 0) {
      throw new Error("Verifier recovery journal contains a malformed line.");
    }
    const key = line.slice(0, separator);
    if (values.has(key)) {
      throw new Error("Verifier recovery journal contains duplicate keys.");
    }
    values.set(key, line.slice(separator + 1));
  }
  for (const key of restoreKeys) {
    if (!values.has(key)) {
      throw new Error("Verifier recovery journal lacks restore state.");
    }
  }
  return { lines, values };
};
const writeRestoreState = ({
  kind,
  state,
  tempName,
  tempDev,
  tempIno,
  targetPresent,
  targetDev,
  targetIno,
}) => {
  const { lines } = readJournal();
  const replacements = new Map([
    ["restore-kind", kind],
    ["restore-state", state],
    ["restore-temp-name", tempName],
    ["restore-temp-dev", tempDev],
    ["restore-temp-ino", tempIno],
    ["restore-target-present", targetPresent],
    ["restore-target-dev", targetDev],
    ["restore-target-ino", targetIno],
  ]);
  const next = lines
    .map((line) => {
      const separator = line.indexOf("=");
      const key = line.slice(0, separator);
      return replacements.has(key) ? `${key}=${replacements.get(key)}` : line;
    })
    .join("\n");
  const temporaryName = `.journal.restore-${crypto.randomBytes(16).toString("hex")}`;
  const temporaryJournal = temporaryName;
  const initialJournal = fs.lstatSync(journalPath, { bigint: true });
  let fd;
  let temporaryIdentity;
  try {
    assertTransactionDirectoryPinned();
    fd = fs.openSync(
      temporaryJournal,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW,
      0o600,
    );
    fs.writeFileSync(fd, `${next}\n`);
    fs.fsyncSync(fd);
    temporaryIdentity = fs.fstatSync(fd, { bigint: true });
    if (
      !temporaryIdentity.isFile() ||
      temporaryIdentity.isSymbolicLink() ||
      temporaryIdentity.nlink !== 1n ||
      Number(temporaryIdentity.mode & 0o7777n) !== 0o600 ||
      temporaryIdentity.uid !== BigInt(process.getuid())
    ) {
      throw new Error("Verifier recovery journal temporary file is unsafe.");
    }
    fs.closeSync(fd);
    fd = undefined;
    if (
      process.env.OPENCLAW_DOCKER_SETUP_TEST === "1" &&
      process.env.OPENCLAW_TEST_RESTORE_JOURNAL_READY &&
      process.env.OPENCLAW_TEST_RESTORE_JOURNAL_CONTINUE
    ) {
      const ready = process.env.OPENCLAW_TEST_RESTORE_JOURNAL_READY;
      const proceed = process.env.OPENCLAW_TEST_RESTORE_JOURNAL_CONTINUE;
      if (!path.isAbsolute(ready) || !path.isAbsolute(proceed)) {
        throw new Error("Verifier recovery journal test barrier paths must be absolute.");
      }
      fs.writeFileSync(ready, `${temporaryName}\n`, { flag: "wx", mode: 0o600 });
      const deadline = Date.now() + 10_000;
      const waitState = new Int32Array(new SharedArrayBuffer(4));
      while (!fs.existsSync(proceed)) {
        if (Date.now() >= deadline) {
          throw new Error("Verifier recovery journal test barrier timed out.");
        }
        Atomics.wait(waitState, 0, 0, 10);
      }
    }
    assertTransactionDirectoryPinned();
    const temporaryPathState = fs.lstatSync(temporaryJournal, { bigint: true });
    if (
      temporaryPathState.dev !== temporaryIdentity.dev ||
      temporaryPathState.ino !== temporaryIdentity.ino ||
      temporaryPathState.nlink !== 1n
    ) {
      throw new Error("Verifier recovery journal temporary identity changed.");
    }
    const existingJournal = fs.lstatSync(journalPath, { bigint: true });
    if (
      !existingJournal.isFile() ||
      existingJournal.isSymbolicLink() ||
      existingJournal.nlink !== 1n ||
      Number(existingJournal.mode & 0o7777n) !== 0o600 ||
      existingJournal.uid !== BigInt(process.getuid()) ||
      existingJournal.dev !== initialJournal.dev ||
      existingJournal.ino !== initialJournal.ino ||
      existingJournal.mode !== initialJournal.mode
    ) {
      throw new Error("Verifier recovery journal changed before publication.");
    }
    fs.renameSync(temporaryJournal, journalPath);
    const directoryFd = fs.openSync(".", fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(directoryFd);
    } finally {
      fs.closeSync(directoryFd);
    }
    assertTransactionDirectoryPinned();
    const published = fs.lstatSync(journalPath, { bigint: true });
    if (
      published.dev !== temporaryIdentity.dev ||
      published.ino !== temporaryIdentity.ino ||
      published.nlink !== 1n
    ) {
      throw new Error("Verifier recovery journal publication changed identity.");
    }
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
};
const restoreOrder = new Map([
  ["env", 0],
  ["config", 1],
  ["overlay", 2],
]);
const currentRestore = readJournal().values;
const activeKind = currentRestore.get("restore-kind");
const activeState = currentRestore.get("restore-state");
const activeTempName = currentRestore.get("restore-temp-name");
const activeTempDev = currentRestore.get("restore-temp-dev");
const activeTempIno = currentRestore.get("restore-temp-ino");
const activeTargetPresent = currentRestore.get("restore-target-present");
const activeTargetDev = currentRestore.get("restore-target-dev");
const activeTargetIno = currentRestore.get("restore-target-ino");
const isDecimalIdentity = (value) => /^[0-9]+$/.test(value);
if (activeKind) {
  if (
    !restoreOrder.has(activeKind) ||
    !["prepared", "temp-written", "target-replaced", "mode-applied"].includes(activeState) ||
    !/^\.openclaw-restore-[a-f0-9]{32}$/.test(activeTempName) ||
    !["0", "1"].includes(activeTargetPresent) ||
    (activeTargetPresent === "0" && (activeTargetDev || activeTargetIno)) ||
    (activeTargetPresent === "1" &&
      (!isDecimalIdentity(activeTargetDev) || !isDecimalIdentity(activeTargetIno))) ||
    (activeState === "prepared" && (activeTempDev || activeTempIno)) ||
    (activeState !== "prepared" &&
      (!isDecimalIdentity(activeTempDev) || !isDecimalIdentity(activeTempIno)))
  ) {
    throw new Error("Verifier recovery journal contains malformed restore state.");
  }
} else if (
  activeState ||
  activeTempName ||
  activeTempDev ||
  activeTempIno ||
  activeTargetPresent ||
  activeTargetDev ||
  activeTargetIno
) {
  throw new Error("Verifier recovery journal contains partial restore state.");
}
if (activeKind && activeKind !== restoreKind) {
  if (
    restoreOrder.get(activeKind) < restoreOrder.get(restoreKind)
  ) {
    throw new Error("Verifier recovery journal targets an inconsistent restore order.");
  }
  process.exit(0);
}
const directory = path.dirname(target);
const leaf = path.basename(target);
if (leaf === "." || leaf === ".." || path.join(directory, leaf) !== path.normalize(target)) {
  throw new Error("Verifier recovery target leaf is malformed.");
}
const sameParentIdentity = (value) =>
  String(value.dev) === expectedParentDev &&
  String(value.ino) === expectedParentIno &&
  value.isDirectory() &&
  !value.isSymbolicLink();
const assertRequestedParent = () => {
  const current = fs.lstatSync(directory, { bigint: true });
  if (!sameParentIdentity(current)) {
    throw new Error("Verifier recovery target parent identity changed.");
  }
};
const requestedParent = fs.lstatSync(directory, { bigint: true });
if (!sameParentIdentity(requestedParent)) {
  throw new Error("Verifier recovery target parent does not match the journal.");
}
const pinTargetDirectory = () => {
  assertRequestedParent();
  process.chdir(directory);
  if (!sameParentIdentity(fs.lstatSync(".", { bigint: true }))) {
    throw new Error("Verifier recovery target parent changed before it was pinned.");
  }
  assertRequestedParent();
};
pinTargetDirectory();
const lstatOptional = (value) => {
  try {
    return fs.lstatSync(value);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
};
const sameIdentity = (left, right) =>
  left === undefined
    ? right === undefined
    : right !== undefined &&
      left.dev === right.dev &&
      left.ino === right.ino &&
      left.mode === right.mode &&
      left.nlink === right.nlink;
const sameObjectIdentity = (value, expectedDev, expectedIno) =>
  value !== undefined &&
  String(value.dev) === expectedDev &&
  String(value.ino) === expectedIno;
const directMode = (value) => value.mode & 0o7777;
const digestFileDescriptor = (fd) =>
  crypto.createHash("sha256").update(fs.readFileSync(fd)).digest("hex");
const fsyncCurrentDirectory = () => {
  const directoryFd = fs.openSync(".", fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(directoryFd);
  } finally {
    fs.closeSync(directoryFd);
  }
};
const assertDirectRegular = (label, value) => {
  if (
    value?.isSymbolicLink() ||
    (value && (!value.isFile() || value.nlink !== 1))
  ) {
    throw new Error(`${label} is a symlink, hardlink, or special node.`);
  }
};
const beforeTarget = lstatOptional(leaf);
assertDirectRegular("Verifier recovery target", beforeTarget);

if (present === "0") {
  if (activeKind === restoreKind) {
    throw new Error("Verifier recovery journal contains restore state for an absent backup.");
  }
  const finalTarget = lstatOptional(leaf);
  assertDirectRegular("Verifier recovery target", finalTarget);
  if (!sameIdentity(beforeTarget, finalTarget)) {
    throw new Error("Verifier recovery target identity changed before removal.");
  }
  assertRequestedParent();
  if (finalTarget) {
    fs.unlinkSync(leaf);
    fsyncCurrentDirectory();
  }
  assertRequestedParent();
} else {
  const backupDirectory = path.dirname(backup);
  const backupLeaf = path.basename(backup);
  if (
    backupLeaf === "." ||
    backupLeaf === ".." ||
    path.join(backupDirectory, backupLeaf) !== path.normalize(backup) ||
    path.normalize(backupDirectory) !== path.normalize(transactionDirectory)
  ) {
    throw new Error("Verifier recovery backup leaf is malformed.");
  }
  const requestedBackupParent = requestedTransactionDirectory;
  const sameBackupParentIdentity = (value) =>
    value.isDirectory() &&
    !value.isSymbolicLink() &&
    value.dev === requestedBackupParent.dev &&
    value.ino === requestedBackupParent.ino &&
    value.mode === requestedBackupParent.mode;
  const assertRequestedBackupParent = () => {
    const current = fs.lstatSync(transactionDirectory, { bigint: true });
    if (
      !sameBackupParentIdentity(current) ||
      String(current.dev) !== expectedTransactionDev ||
      String(current.ino) !== expectedTransactionIno
    ) {
      throw new Error("Verifier recovery backup parent identity changed.");
    }
  };
  pinTransactionDirectory();
  const backupPath = fs.lstatSync(backupLeaf);
  if (
    !backupPath.isFile() ||
    backupPath.isSymbolicLink() ||
    backupPath.nlink !== 1
  ) {
    throw new Error("Verifier recovery backup is not a direct single-link regular file.");
  }
  const backupFd = fs.openSync(
    backupLeaf,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  try {
    const backupStat = fs.fstatSync(backupFd);
    if (!sameIdentity(backupStat, backupPath) || backupStat.nlink !== 1) {
      throw new Error("Verifier recovery backup identity changed.");
    }
    const value = fs.readFileSync(backupFd);
    const finalBackup = fs.fstatSync(backupFd);
    const finalBackupPath = fs.lstatSync(backupLeaf);
    if (
      !sameIdentity(backupStat, finalBackup) ||
      !sameIdentity(backupStat, finalBackupPath) ||
      finalBackup.nlink !== 1 ||
      finalBackupPath.nlink !== 1
    ) {
      throw new Error("Verifier recovery backup changed while being read.");
    }
    if (crypto.createHash("sha256").update(value).digest("hex") !== expectedDigest) {
      throw new Error("Verifier recovery backup digest changed.");
    }
    assertRequestedBackupParent();
    pinTargetDirectory();
    const targetAfterBackup = lstatOptional(leaf);
    assertDirectRegular("Verifier recovery target", targetAfterBackup);
    if (!sameIdentity(beforeTarget, targetAfterBackup)) {
      throw new Error("Verifier recovery target changed while backup was read.");
    }
    const expectedModeNumber = Number.parseInt(expectedMode, 8);
    const targetIdentity = beforeTarget
      ? {
          present: "1",
          dev: String(beforeTarget.dev),
          ino: String(beforeTarget.ino),
        }
      : { present: "0", dev: "", ino: "" };
    let restoreState = activeState;
    let temporary = activeTempName;
    let temporaryDev = activeTempDev;
    let temporaryIno = activeTempIno;
    let recordedTargetPresent = activeTargetPresent;
    let recordedTargetDev = activeTargetDev;
    let recordedTargetIno = activeTargetIno;
    const writeCurrentRestoreState = (state) => {
      writeRestoreState({
        kind: restoreKind,
        state,
        tempName: temporary,
        tempDev: temporaryDev,
        tempIno: temporaryIno,
        targetPresent: recordedTargetPresent,
        targetDev: recordedTargetDev,
        targetIno: recordedTargetIno,
      });
      pinTargetDirectory();
      restoreState = state;
    };
    const clearCurrentRestoreState = () => {
      writeRestoreState({
        kind: "",
        state: "",
        tempName: "",
        tempDev: "",
        tempIno: "",
        targetPresent: "",
        targetDev: "",
        targetIno: "",
      });
      pinTargetDirectory();
      restoreState = "";
    };
    const assertRecordedInitialTarget = () => {
      const current = lstatOptional(leaf);
      assertDirectRegular("Verifier recovery target", current);
      if (
        (recordedTargetPresent === "0" && current !== undefined) ||
        (recordedTargetPresent === "1" &&
          !sameObjectIdentity(current, recordedTargetDev, recordedTargetIno))
      ) {
        throw new Error("Verifier recovery target no longer matches prepared restore state.");
      }
    };
    const inspectRestoreFile = ({
      file,
      expectedDev,
      expectedIno,
      allowedModes,
      label,
    }) => {
      const before = lstatOptional(file);
      assertDirectRegular(label, before);
      if (
        !sameObjectIdentity(before, expectedDev, expectedIno) ||
        !allowedModes.has(directMode(before))
      ) {
        throw new Error(`${label} identity or mode does not match restore state.`);
      }
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const opened = fs.fstatSync(fd);
        if (
          !sameIdentity(before, opened) ||
          opened.nlink !== 1 ||
          digestFileDescriptor(fd) !== expectedDigest
        ) {
          throw new Error(`${label} changed or has unexpected content.`);
        }
        const after = fs.fstatSync(fd);
        const afterPath = lstatOptional(file);
        if (!sameIdentity(opened, after) || !sameIdentity(opened, afterPath)) {
          throw new Error(`${label} changed while being inspected.`);
        }
        return opened;
      } finally {
        fs.closeSync(fd);
      }
    };

    if (!restoreState) {
      temporary = `.openclaw-restore-${crypto.randomBytes(16).toString("hex")}`;
      recordedTargetPresent = targetIdentity.present;
      recordedTargetDev = targetIdentity.dev;
      recordedTargetIno = targetIdentity.ino;
      writeCurrentRestoreState("prepared");
    } else if (restoreState !== "target-replaced" && restoreState !== "mode-applied") {
      const targetMatchesPreparedState =
        recordedTargetPresent === targetIdentity.present &&
        (recordedTargetPresent === "0" ||
          (recordedTargetDev === targetIdentity.dev &&
            recordedTargetIno === targetIdentity.ino));
      const targetMatchesRenamedTemporary =
        restoreState === "temp-written" &&
        sameObjectIdentity(beforeTarget, temporaryDev, temporaryIno);
      if (!targetMatchesPreparedState && !targetMatchesRenamedTemporary) {
        throw new Error("Verifier recovery target changed since restore preparation.");
      }
    }

    if (restoreState === "prepared") {
      assertRecordedInitialTarget();
      const existingTemporary = lstatOptional(temporary);
      if (existingTemporary) {
        assertDirectRegular("Verifier recovery temporary file", existingTemporary);
        if (directMode(existingTemporary) !== 0o600) {
          throw new Error("Verifier recovery temporary file is not restrictive.");
        }
        temporaryDev = String(existingTemporary.dev);
        temporaryIno = String(existingTemporary.ino);
        inspectRestoreFile({
          file: temporary,
          expectedDev: temporaryDev,
          expectedIno: temporaryIno,
          allowedModes: new Set([0o600]),
          label: "Verifier recovery temporary file",
        });
      } else {
        let temporaryFd;
        try {
          temporaryFd = fs.openSync(
            temporary,
            fs.constants.O_RDWR |
              fs.constants.O_CREAT |
              fs.constants.O_EXCL |
              fs.constants.O_NOFOLLOW,
            0o600,
          );
          const openedTemporary = fs.fstatSync(temporaryFd);
          if (
            openedTemporary.nlink !== 1 ||
            directMode(openedTemporary) !== 0o600
          ) {
            throw new Error(
              "Verifier recovery temporary file is not a restrictive single-link file.",
            );
          }
          fs.writeFileSync(temporaryFd, value);
          fs.fsyncSync(temporaryFd);
          const writtenTemporary = fs.fstatSync(temporaryFd);
          if (!sameIdentity(openedTemporary, writtenTemporary)) {
            throw new Error(
              "Verifier recovery temporary file identity changed while writing.",
            );
          }
          temporaryDev = String(writtenTemporary.dev);
          temporaryIno = String(writtenTemporary.ino);
        } finally {
          if (temporaryFd !== undefined) {
            fs.closeSync(temporaryFd);
          }
        }
        inspectRestoreFile({
          file: temporary,
          expectedDev: temporaryDev,
          expectedIno: temporaryIno,
          allowedModes: new Set([0o600]),
          label: "Verifier recovery temporary file",
        });
      }
      fsyncCurrentDirectory();
      assertRequestedBackupParent();
      assertRequestedParent();
      assertRecordedInitialTarget();
      writeCurrentRestoreState("temp-written");
    }

    if (restoreState === "temp-written") {
      const currentTemporary = lstatOptional(temporary);
      if (currentTemporary) {
        inspectRestoreFile({
          file: temporary,
          expectedDev: temporaryDev,
          expectedIno: temporaryIno,
          allowedModes: new Set([0o600]),
          label: "Verifier recovery temporary file",
        });
        assertRequestedBackupParent();
        assertRequestedParent();
        // Keep the exact journaled target identity check adjacent to rename so a
        // substituted path is rejected before publication.
        assertRecordedInitialTarget();
        fs.renameSync(temporary, leaf);
        fsyncCurrentDirectory();
        assertRequestedParent();
      } else {
        inspectRestoreFile({
          file: leaf,
          expectedDev: temporaryDev,
          expectedIno: temporaryIno,
          allowedModes: new Set([0o600, expectedModeNumber]),
          label: "Verifier recovery replaced target",
        });
      }
      writeCurrentRestoreState("target-replaced");
    }

    if (restoreState === "target-replaced") {
      if (lstatOptional(temporary)) {
        throw new Error("Verifier recovery found an ambiguous post-rename temporary file.");
      }
      const replaced = inspectRestoreFile({
        file: leaf,
        expectedDev: temporaryDev,
        expectedIno: temporaryIno,
        allowedModes: new Set([0o600, expectedModeNumber]),
        label: "Verifier recovery replaced target",
      });
      if (directMode(replaced) === 0o600 && expectedModeNumber !== 0o600) {
        const targetFd = fs.openSync(
          leaf,
          fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
        );
        try {
          const openedTarget = fs.fstatSync(targetFd);
          if (!sameIdentity(replaced, openedTarget)) {
            throw new Error("Verifier recovery replaced target changed before mode restore.");
          }
          fs.fchmodSync(targetFd, expectedModeNumber);
          fs.fsyncSync(targetFd);
          const modeRestored = fs.fstatSync(targetFd);
          if (
            !sameObjectIdentity(modeRestored, temporaryDev, temporaryIno) ||
            modeRestored.nlink !== 1 ||
            directMode(modeRestored) !== expectedModeNumber
          ) {
            throw new Error("Verifier recovery could not restore the target mode.");
          }
        } finally {
          fs.closeSync(targetFd);
        }
        fsyncCurrentDirectory();
      }
      inspectRestoreFile({
        file: leaf,
        expectedDev: temporaryDev,
        expectedIno: temporaryIno,
        allowedModes: new Set([expectedModeNumber]),
        label: "Verifier recovery mode-restored target",
      });
      assertRequestedParent();
      writeCurrentRestoreState("mode-applied");
    }

    if (restoreState === "mode-applied") {
      if (lstatOptional(temporary)) {
        throw new Error("Verifier recovery found an ambiguous completed temporary file.");
      }
      inspectRestoreFile({
        file: leaf,
        expectedDev: temporaryDev,
        expectedIno: temporaryIno,
        allowedModes: new Set([expectedModeNumber]),
        label: "Verifier recovery completed target",
      });
      assertRequestedBackupParent();
      assertRequestedParent();
      clearCurrentRestoreState();
    }
  } finally {
    fs.closeSync(backupFd);
  }
}
NODE
  then
    :
  else
    fail "Verifier recovery target or backup changed; retaining recovery state."
  fi
  oci_assert_pinned_state_dir
}

oci_assert_transaction_parent_identity() {
  local target="$1"
  local expected_dev="$2"
  local expected_ino="$3"
  [[ "$expected_dev" =~ ^[0-9]+$ && "$expected_ino" =~ ^[0-9]+$ ]] ||
    fail "Verifier transaction parent identity is malformed."
  if node - "$target" "$expected_dev" "$expected_ino" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const [target, expectedDev, expectedIno] = process.argv.slice(2);
const parent = fs.lstatSync(path.dirname(target), { bigint: true });
if (
  !parent.isDirectory() ||
  parent.isSymbolicLink() ||
  String(parent.dev) !== expectedDev ||
  String(parent.ino) !== expectedIno
) {
  throw new Error("Verifier transaction parent identity changed.");
}
NODE
  then
    :
  else
    fail "Verifier transaction parent changed; retaining recovery state."
  fi
}

write_sandbox_compose_overlay() {
  local tmp=""
  [[ -S "$DOCKER_SOCKET_PATH" ]] ||
    fail "Guarded verifier setup requires the configured Docker socket."
  tmp="$(mktemp "$ROOT_DIR/.docker-compose.sandbox.XXXXXX")"
  node - "$tmp" "$DOCKER_SOCKET_PATH" "${DOCKER_GID:-}" <<'NODE'
const fs = require("node:fs");
const [outputPath, socketPath, dockerGid] = process.argv.slice(2);
const lines = [
  "services:",
  "  openclaw-gateway:",
  "    volumes:",
  `      - source: ${JSON.stringify(socketPath)}`,
  "        target: /var/run/docker.sock",
  "        type: bind",
];
if (dockerGid) {
  lines.push("    group_add:", `      - ${JSON.stringify(dockerGid)}`);
}
fs.writeFileSync(outputPath, `${lines.join("\n")}\n`, { mode: 0o600 });
NODE
  chmod 600 "$tmp"
  mv "$tmp" "$SANDBOX_COMPOSE_FILE"
  oci_sync_paths "$SANDBOX_COMPOSE_FILE" "$ROOT_DIR"
}

oci_assert_exact_gateway_ready() {
  local gateway_id="$1"
  local image_id="$2"
  local socket_path="$3"
  local config_value=""
  local mounts_json=""
  [[ "$gateway_id" =~ ^[a-f0-9]{64}$ && "$image_id" =~ ^sha256:[a-f0-9]{64}$ ]] ||
    fail "Refusing to validate malformed Gateway publication identities."
  [[ -S "$socket_path" ]] ||
    fail "Guarded verifier publication Docker socket disappeared."
  [[ "$(docker inspect --format '{{.Image}}' "$gateway_id")" == "$image_id" &&
    "$(docker inspect --format '{{.State.Running}}' "$gateway_id")" == "true" &&
    "$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' \
      "$gateway_id")" == "healthy" ]] ||
    fail "Guarded verifier publication Gateway identity or health changed."
  mounts_json="$(docker inspect --format '{{json .Mounts}}' "$gateway_id")"
  node - "$socket_path" "$mounts_json" <<'NODE'
const fs = require("node:fs");
const expected = fs.realpathSync(process.argv[2]);
const mounts = JSON.parse(process.argv[3]);
const socketMounts = mounts.filter((mount) => mount.Destination === "/var/run/docker.sock");
if (
  socketMounts.length !== 1 ||
  socketMounts[0].Type !== "bind" ||
  fs.realpathSync(socketMounts[0].Source) !== expected ||
  socketMounts[0].RW !== true
) {
  throw new Error("Gateway Docker socket mount does not match the verifier transaction.");
}
NODE
  config_value="$(
    docker exec "$gateway_id" node dist/index.js config get agents.defaults.sandbox.mode
  )"
  [[ "${config_value//$'\r'/}" == "non-main" ]] ||
    fail "Guarded verifier Gateway sandbox mode is not active."
  config_value="$(
    docker exec "$gateway_id" node dist/index.js config get agents.defaults.sandbox.scope
  )"
  [[ "${config_value//$'\r'/}" == "agent" ]] ||
    fail "Guarded verifier Gateway sandbox scope is not active."
  config_value="$(
    docker exec "$gateway_id" node dist/index.js config get agents.defaults.sandbox.workspaceAccess
  )"
  [[ "${config_value//$'\r'/}" == "none" ]] ||
    fail "Guarded verifier Gateway sandbox workspace policy is not active."
  docker exec "$gateway_id" node -e \
    'fetch("http://127.0.0.1:18789/readyz").then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1))'
}

finish_committed_verifier_transaction() {
  local transaction_id=""
  local state_instance_digest=""
  local operation_binding=""
  local candidate_tag=""
  local final_tag=""
  local candidate=""
  local final=""
  local runtime_image=""
  local new_gateway=""
  local old_gateway=""
  local old_gateway_image=""
  local old_image=""
  local old_stable=""
  local gateway_was_running=""
  local env_backup_digest=""
  local env_backup_mode=""
  local env_backup_parent_dev=""
  local env_backup_parent_ino=""
  local config_backup_present=""
  local config_backup_digest=""
  local config_backup_mode=""
  local config_backup_parent_dev=""
  local config_backup_parent_ino=""
  local overlay_backup_present=""
  local overlay_backup_digest=""
  local overlay_backup_mode=""
  local overlay_backup_parent_dev=""
  local overlay_backup_parent_ino=""
  local docker_socket_path=""
  local gc_old_image=""
  [[ ! -L "$VERIFIER_TRANSACTION_DIR" ]] ||
    fail "Verifier transaction directory must not be a symlink."
  [[ -d "$VERIFIER_TRANSACTION_DIR" ]] || return
  oci_pin_transaction_dir
  oci_reconcile_journal_temps
  oci_assert_transaction_tree
  oci_validate_journal_shape
  oci_assert_known_phase "$(oci_read_journal phase)"
  [[ "$(oci_read_journal phase)" == "committed" ]] ||
    fail "Refusing committed cleanup for an uncommitted verifier transaction."
  transaction_id="$(oci_read_journal transaction-id)"
  state_instance_digest="$(oci_read_journal state-instance-digest)"
  operation_binding="$(oci_read_journal operation-binding)"
  candidate_tag="$(oci_read_journal candidate-tag)"
  final_tag="$(oci_read_journal final-tag)"
  candidate="$(
    oci_resolve_transaction_image "$candidate_tag" "$(oci_read_journal candidate-image-id)"
  )"
  final="$(oci_resolve_transaction_image "$final_tag" "$(oci_read_journal final-image-id)")"
  runtime_image="$(oci_read_journal runtime-image-id)"
  new_gateway="$(oci_read_journal new-gateway-id)"
  old_gateway="$(oci_read_journal old-gateway-id)"
  old_gateway_image="$(oci_read_journal old-gateway-image-id)"
  old_image="$(oci_read_journal old-image-id)"
  old_stable="$(oci_read_journal old-stable-image-id)"
  gateway_was_running="$(oci_read_journal gateway-was-running)"
  env_backup_digest="$(oci_read_journal env-backup-digest)"
  env_backup_mode="$(oci_read_journal env-backup-mode)"
  env_backup_parent_dev="$(oci_read_journal env-backup-parent-dev)"
  env_backup_parent_ino="$(oci_read_journal env-backup-parent-ino)"
  config_backup_present="$(oci_read_journal config-backup-present)"
  config_backup_digest="$(oci_read_journal config-backup-digest)"
  config_backup_mode="$(oci_read_journal config-backup-mode)"
  config_backup_parent_dev="$(oci_read_journal config-backup-parent-dev)"
  config_backup_parent_ino="$(oci_read_journal config-backup-parent-ino)"
  overlay_backup_present="$(oci_read_journal sandbox-overlay-backup-present)"
  overlay_backup_digest="$(oci_read_journal sandbox-overlay-backup-digest)"
  overlay_backup_mode="$(oci_read_journal sandbox-overlay-backup-mode)"
  overlay_backup_parent_dev="$(oci_read_journal sandbox-overlay-backup-parent-dev)"
  overlay_backup_parent_ino="$(oci_read_journal sandbox-overlay-backup-parent-ino)"
  docker_socket_path="$(oci_read_journal docker-socket-path)"
  gc_old_image="$(oci_read_journal gc-old-image)"
  oci_validate_journal_identities \
    "$transaction_id" "$state_instance_digest" "$operation_binding" \
    "$candidate" "$final" "$new_gateway" \
    "$old_image" "$old_stable" "$gateway_was_running"
  oci_validate_transaction_metadata \
    "$transaction_id" "$candidate_tag" "$final_tag" "$runtime_image" \
    "$old_gateway" "$old_gateway_image" "$env_backup_digest" "$env_backup_mode" \
    "$env_backup_parent_dev" "$env_backup_parent_ino" \
    "$config_backup_present" "$config_backup_digest" "$config_backup_mode" \
    "$config_backup_parent_dev" "$config_backup_parent_ino" \
    "$overlay_backup_present" "$overlay_backup_digest" "$overlay_backup_mode" \
    "$overlay_backup_parent_dev" "$overlay_backup_parent_ino" \
    "$docker_socket_path" "$gc_old_image"
  oci_validate_restore_state
  [[ -z "$(oci_read_journal restore-state)" ]] ||
    fail "Committed verifier transaction retains incomplete restore state."
  oci_validate_phase_state "committed" "$candidate" "$final" "$new_gateway"
  oci_assert_exact_gateway_ready "$new_gateway" "$runtime_image" "$docker_socket_path"
  if [[ -n "$candidate" ]]; then
    oci_remove_exact_tag "$candidate_tag" "$candidate"
    # The published metadata image is an intentional direct child of the
    # candidate. Remove only the transaction tag; Docker must retain the
    # untagged parent identity while the published child remains installed.
  fi
  if [[ -n "$final" ]]; then
    oci_remove_exact_tag "$final_tag" "$final"
  fi
  if [[ "$gc_old_image" == "1" &&
    "$old_image" =~ ^sha256:[a-f0-9]{64}$ &&
    "$old_image" != "$final" ]]; then
    oci_remove_image_if_unused "$old_image"
  fi
  [[ ! -L "$VERIFIER_LOCK_DIR" ]] ||
    fail "Guarded verifier lifecycle lock must not be a symlink."
  [[ ! -d "$VERIFIER_LOCK_DIR" ]] || oci_assert_lock_tree
  oci_mark_state_cleanup
  oci_remove_pinned_transaction_dir
  rm -rf "$VERIFIER_LOCK_DIR"
  oci_sync_paths "$VERIFIER_STATE_DIR"
  oci_remove_state_marker
}

rollback_verifier_transaction() {
  local status="${1:-1}"
  local phase=""
  local candidate_tag=""
  local final_tag=""
  local candidate=""
  local final=""
  local runtime_image=""
  local new_gateway=""
  local old_gateway=""
  local old_gateway_image=""
  local old_image=""
  local old_stable=""
  local gateway_was_running=""
  local transaction_id=""
  local state_instance_digest=""
  local operation_binding=""
  local env_backup_digest=""
  local env_backup_mode=""
  local env_backup_parent_dev=""
  local env_backup_parent_ino=""
  local config_backup_present=""
  local config_backup_digest=""
  local config_backup_mode=""
  local config_backup_parent_dev=""
  local config_backup_parent_ino=""
  local overlay_backup_present=""
  local overlay_backup_digest=""
  local overlay_backup_mode=""
  local overlay_backup_parent_dev=""
  local overlay_backup_parent_ino=""
  local docker_socket_path=""
  local gc_old_image=""
  local current_gateway=""
  local restored_gateway=""
  trap - EXIT INT TERM
  set -e
  if [[ -n "$VERIFIER_STATE_IDENTITY_FAILED" ]]; then
    echo "ERROR: Retaining verifier journal, lock, and active-state marker after state-root identity loss." >&2
    exit "$status"
  fi
  if [[ -L "$VERIFIER_TRANSACTION_DIR" ]]; then
    fail "Verifier transaction directory must not be a symlink."
  fi
  if [[ -d "$VERIFIER_TRANSACTION_DIR" ]]; then
    oci_pin_transaction_dir
    oci_reconcile_journal_temps
    oci_assert_transaction_tree
    oci_validate_journal_shape
    phase="$(oci_read_journal phase)"
    oci_assert_known_phase "$phase"
    if [[ "$phase" == "committed" ]]; then
      finish_committed_verifier_transaction
      exit "$status"
    fi
    transaction_id="$(oci_read_journal transaction-id)"
    state_instance_digest="$(oci_read_journal state-instance-digest)"
    operation_binding="$(oci_read_journal operation-binding)"
    candidate_tag="$(oci_read_journal candidate-tag)"
    final_tag="$(oci_read_journal final-tag)"
    candidate="$(
      oci_resolve_transaction_image "$candidate_tag" "$(oci_read_journal candidate-image-id)"
    )"
    final="$(oci_resolve_transaction_image "$final_tag" "$(oci_read_journal final-image-id)")"
    runtime_image="$(oci_read_journal runtime-image-id)"
    new_gateway="$(oci_read_journal new-gateway-id)"
    old_gateway="$(oci_read_journal old-gateway-id)"
    old_gateway_image="$(oci_read_journal old-gateway-image-id)"
    old_image="$(oci_read_journal old-image-id)"
    old_stable="$(oci_read_journal old-stable-image-id)"
    gateway_was_running="$(oci_read_journal gateway-was-running)"
    env_backup_digest="$(oci_read_journal env-backup-digest)"
    env_backup_mode="$(oci_read_journal env-backup-mode)"
    env_backup_parent_dev="$(oci_read_journal env-backup-parent-dev)"
    env_backup_parent_ino="$(oci_read_journal env-backup-parent-ino)"
    config_backup_present="$(oci_read_journal config-backup-present)"
    config_backup_digest="$(oci_read_journal config-backup-digest)"
    config_backup_mode="$(oci_read_journal config-backup-mode)"
    config_backup_parent_dev="$(oci_read_journal config-backup-parent-dev)"
    config_backup_parent_ino="$(oci_read_journal config-backup-parent-ino)"
    overlay_backup_present="$(oci_read_journal sandbox-overlay-backup-present)"
    overlay_backup_digest="$(oci_read_journal sandbox-overlay-backup-digest)"
    overlay_backup_mode="$(oci_read_journal sandbox-overlay-backup-mode)"
    overlay_backup_parent_dev="$(oci_read_journal sandbox-overlay-backup-parent-dev)"
    overlay_backup_parent_ino="$(oci_read_journal sandbox-overlay-backup-parent-ino)"
    docker_socket_path="$(oci_read_journal docker-socket-path)"
    gc_old_image="$(oci_read_journal gc-old-image)"
    oci_validate_journal_identities \
      "$transaction_id" "$state_instance_digest" "$operation_binding" \
      "$candidate" "$final" "$new_gateway" \
      "$old_image" "$old_stable" "$gateway_was_running"
    oci_validate_transaction_metadata \
      "$transaction_id" "$candidate_tag" "$final_tag" "$runtime_image" \
      "$old_gateway" "$old_gateway_image" "$env_backup_digest" "$env_backup_mode" \
      "$env_backup_parent_dev" "$env_backup_parent_ino" \
      "$config_backup_present" "$config_backup_digest" "$config_backup_mode" \
      "$config_backup_parent_dev" "$config_backup_parent_ino" \
      "$overlay_backup_present" "$overlay_backup_digest" "$overlay_backup_mode" \
      "$overlay_backup_parent_dev" "$overlay_backup_parent_ino" \
      "$docker_socket_path" "$gc_old_image"
    oci_validate_restore_state
    oci_validate_phase_state "$phase" "$candidate" "$final" "$new_gateway"
    oci_assert_owned_mode "$VERIFIER_TRANSACTION_DIR/env.backup" 600
    oci_restore_transaction_file \
      "$ENV_FILE" \
      "$VERIFIER_TRANSACTION_DIR/env.backup" \
      "1" "$env_backup_digest" "$env_backup_mode" \
      "$env_backup_parent_dev" "$env_backup_parent_ino" "env"
    reload_verifier_shell_from_env
    oci_restore_stable_tag "$old_stable"
    oci_restore_transaction_file \
      "$OPENCLAW_CONFIG_DIR/openclaw.json" \
      "$VERIFIER_TRANSACTION_DIR/config.backup" \
      "$config_backup_present" "$config_backup_digest" "$config_backup_mode" \
      "$config_backup_parent_dev" "$config_backup_parent_ino" "config"
    oci_restore_transaction_file \
      "$SANDBOX_COMPOSE_FILE" \
      "$VERIFIER_TRANSACTION_DIR/sandbox-overlay.backup" \
      "$overlay_backup_present" "$overlay_backup_digest" "$overlay_backup_mode" \
      "$overlay_backup_parent_dev" "$overlay_backup_parent_ino" "overlay"

    local -a rollback_args=(-f "$COMPOSE_FILE")
    [[ ! -f "$EXTRA_COMPOSE_FILE" ]] ||
      rollback_args+=("-f" "$EXTRA_COMPOSE_FILE")
    [[ ! "$old_image" =~ ^sha256:[a-f0-9]{64}$ ]] ||
      rollback_args+=("-f" "$VERIFIER_COMPOSE_FILE")
    [[ ! -f "$SANDBOX_COMPOSE_FILE" ]] ||
      rollback_args+=("-f" "$SANDBOX_COMPOSE_FILE")
    current_gateway="$(docker compose "${rollback_args[@]}" ps -q openclaw-gateway)"
    [[ -z "$current_gateway" || "$current_gateway" =~ ^[a-f0-9]{64}$ ]] ||
      fail "Verifier recovery found a malformed current Gateway identity."
    if [[ -n "$current_gateway" && "$current_gateway" != "$old_gateway" ]]; then
      docker rm -f "$current_gateway" >/dev/null
      current_gateway=""
    fi
    if [[ "$gateway_was_running" == "1" ]]; then
      [[ "$old_gateway_image" =~ ^sha256:[a-f0-9]{64}$ ]] ||
        fail "Verifier recovery lacks the prior running Gateway image."
      OPENCLAW_IMAGE="$old_gateway_image" \
        docker compose "${rollback_args[@]}" up -d --no-deps --force-recreate openclaw-gateway
      restored_gateway="$(docker compose "${rollback_args[@]}" ps -q openclaw-gateway)"
      [[ "$restored_gateway" =~ ^[a-f0-9]{64}$ &&
        "$(docker inspect --format '{{.Image}}' "$restored_gateway")" == "$old_gateway_image" &&
        "$(docker inspect --format '{{.State.Running}}' "$restored_gateway")" == "true" ]] ||
        fail "Verifier recovery did not restore the exact prior Gateway image."
    elif [[ -n "$old_gateway_image" ]]; then
      if [[ -n "$current_gateway" ]]; then
        docker stop "$current_gateway" >/dev/null
        restored_gateway="$current_gateway"
      else
        OPENCLAW_IMAGE="$old_gateway_image" \
          docker compose "${rollback_args[@]}" create --no-deps --force-recreate openclaw-gateway
        restored_gateway="$(docker compose "${rollback_args[@]}" ps -a -q openclaw-gateway)"
      fi
      [[ "$restored_gateway" =~ ^[a-f0-9]{64}$ &&
        "$(docker inspect --format '{{.Image}}' "$restored_gateway")" == "$old_gateway_image" &&
        "$(docker inspect --format '{{.State.Running}}' "$restored_gateway")" == "false" ]] ||
        fail "Verifier recovery did not restore the prior stopped Gateway state."
    fi
    [[ -z "$final" ]] || oci_remove_exact_tag "$final_tag" "$final"
    [[ -z "$candidate" ]] || oci_remove_exact_tag "$candidate_tag" "$candidate"
    if [[ -n "$final" && "$final" != "$old_image" ]]; then
      oci_remove_image_if_unused "$final"
    fi
    if [[ -n "$candidate" && "$candidate" != "$final" ]]; then
      oci_remove_image_if_unused "$candidate"
    fi
  fi
  [[ ! -L "$VERIFIER_LOCK_DIR" ]] ||
    fail "Guarded verifier lifecycle lock must not be a symlink."
  [[ ! -d "$VERIFIER_LOCK_DIR" ]] || oci_assert_lock_tree
  oci_mark_state_cleanup
  if [[ -d "$VERIFIER_TRANSACTION_DIR" ]]; then
    oci_remove_pinned_transaction_dir
  fi
  rm -rf "$VERIFIER_LOCK_DIR"
  oci_sync_paths "$VERIFIER_STATE_DIR"
  oci_remove_state_marker
  exit "$status"
}

recover_existing_verifier_transaction_before_mutation() {
  local lock_pid=""
  local phase=""
  oci_assert_pinned_state_dir
  if [[ ! -e "$VERIFIER_LOCK_DIR" && ! -L "$VERIFIER_LOCK_DIR" &&
    ! -e "$VERIFIER_TRANSACTION_DIR" && ! -L "$VERIFIER_TRANSACTION_DIR" ]]; then
    if [[ "$VERIFIER_STATE_MARKER_PHASE" == "cleanup" ]]; then
      oci_remove_state_marker
    elif [[ "$VERIFIER_STATE_MARKER_PHASE" == "active" ]]; then
      fail "Active verifier state marker has no matching lock or transaction."
    fi
    return
  fi
  oci_publish_state_marker recovery
  [[ ! -L "$VERIFIER_LOCK_DIR" ]] ||
    fail "Guarded verifier lifecycle lock must not be a symlink."
  [[ ! -L "$VERIFIER_TRANSACTION_DIR" ]] ||
    fail "Existing verifier transaction state is unsafe."
  if ! mkdir -m 700 "$VERIFIER_LOCK_DIR" 2>/dev/null; then
    [[ ! -L "$VERIFIER_LOCK_DIR" ]] ||
      fail "Guarded verifier lifecycle lock must not be a symlink."
    [[ -d "$VERIFIER_LOCK_DIR" ]] ||
      fail "Guarded verifier lifecycle lock is not a directory."
    oci_assert_lock_tree
    if [[ -e "$VERIFIER_LOCK_DIR/pid" ]]; then
      [[ ! -L "$VERIFIER_LOCK_DIR/pid" && -f "$VERIFIER_LOCK_DIR/pid" ]] ||
        fail "Guarded verifier lifecycle lock owner record is unsafe."
      oci_assert_owned_mode "$VERIFIER_LOCK_DIR/pid" 600
      IFS= read -r lock_pid <"$VERIFIER_LOCK_DIR/pid" || true
    fi
    if [[ "$lock_pid" =~ ^[0-9]+$ ]] && kill -0 "$lock_pid" 2>/dev/null; then
      fail "Another guarded verifier update owns the lifecycle lock."
    fi
    [[ -z "$lock_pid" || "$lock_pid" =~ ^[0-9]+$ ]] ||
      fail "Guarded verifier lifecycle lock contains a malformed owner record."
    rm -rf "$VERIFIER_LOCK_DIR"
    mkdir -m 700 "$VERIFIER_LOCK_DIR"
  fi
  oci_assert_lock_tree
  printf '%s\n' "$$" >"$VERIFIER_LOCK_DIR/pid"
  chmod 600 "$VERIFIER_LOCK_DIR/pid"
  oci_assert_owned_mode "$VERIFIER_LOCK_DIR/pid" 600
  oci_sync_paths "$VERIFIER_LOCK_DIR/pid" "$VERIFIER_LOCK_DIR"

  if [[ -e "$VERIFIER_TRANSACTION_DIR" || -L "$VERIFIER_TRANSACTION_DIR" ]]; then
    [[ ! -L "$VERIFIER_TRANSACTION_DIR" && -d "$VERIFIER_TRANSACTION_DIR" ]] ||
      fail "Existing verifier transaction state is unsafe."
    oci_pin_transaction_dir
    oci_reconcile_journal_temps
    oci_assert_transaction_tree
    if ! oci_transaction_has_journal; then
      oci_mark_state_cleanup
      oci_remove_pinned_transaction_dir
    else
      oci_validate_journal_shape
      phase="$(oci_read_journal phase)"
      oci_assert_known_phase "$phase"
      if [[ "$phase" == "committed" ]]; then
        finish_committed_verifier_transaction
      else
        # Recovery exits with the prior failure status. Most importantly, it
        # runs before any setup write can replace a substituted protected path.
        rollback_verifier_transaction 1
      fi
    fi
  fi
  if [[ -e "../$VERIFIER_STATE_MARKER_NAME" || -L "../$VERIFIER_STATE_MARKER_NAME" ]]; then
    oci_mark_state_cleanup
  fi
  if [[ -d "$VERIFIER_LOCK_DIR" ]]; then
    oci_assert_lock_tree
    rm -rf "$VERIFIER_LOCK_DIR"
  fi
  oci_sync_paths "$VERIFIER_STATE_DIR"
  oci_remove_state_marker
  VERIFIER_TRANSACTION_DIR_DEV=""
  VERIFIER_TRANSACTION_DIR_INO=""
}

begin_verifier_transaction() {
  local lock_pid=""
  local env_backup_present=""
  oci_assert_pinned_state_dir
  if ! mkdir -m 700 "$VERIFIER_LOCK_DIR" 2>/dev/null; then
    [[ ! -L "$VERIFIER_LOCK_DIR" ]] ||
      fail "Guarded verifier lifecycle lock must not be a symlink."
    [[ -d "$VERIFIER_LOCK_DIR" ]] ||
      fail "Guarded verifier lifecycle lock is not a directory."
    oci_assert_lock_tree
    if [[ -e "$VERIFIER_LOCK_DIR/pid" ]]; then
      [[ ! -L "$VERIFIER_LOCK_DIR/pid" && -f "$VERIFIER_LOCK_DIR/pid" ]] ||
        fail "Guarded verifier lifecycle lock owner record is unsafe."
      oci_assert_owned_mode "$VERIFIER_LOCK_DIR/pid" 600
      IFS= read -r lock_pid <"$VERIFIER_LOCK_DIR/pid" || true
    fi
    if [[ "$lock_pid" =~ ^[0-9]+$ ]] && kill -0 "$lock_pid" 2>/dev/null; then
      fail "Another guarded verifier update owns the lifecycle lock."
    fi
    [[ -z "$lock_pid" || "$lock_pid" =~ ^[0-9]+$ ]] ||
      fail "Guarded verifier lifecycle lock contains a malformed owner record."
    if [[ -e "$VERIFIER_TRANSACTION_DIR" || -L "$VERIFIER_TRANSACTION_DIR" ]]; then
      [[ ! -L "$VERIFIER_TRANSACTION_DIR" && -d "$VERIFIER_TRANSACTION_DIR" ]] ||
        fail "A stale verifier lock has unsafe transaction state."
      oci_pin_transaction_dir
      oci_reconcile_journal_temps
      oci_assert_transaction_tree
    fi
    rm -rf "$VERIFIER_LOCK_DIR"
    mkdir -m 700 "$VERIFIER_LOCK_DIR"
  fi
  oci_assert_lock_tree
  printf '%s\n' "$$" >"$VERIFIER_LOCK_DIR/pid"
  chmod 600 "$VERIFIER_LOCK_DIR/pid"
  oci_assert_owned_mode "$VERIFIER_LOCK_DIR/pid" 600
  oci_sync_paths "$VERIFIER_LOCK_DIR/pid" "$VERIFIER_LOCK_DIR"
  [[ ! -L "$VERIFIER_TRANSACTION_DIR" ]] ||
    fail "Verifier transaction directory must not be a symlink."
  if [[ -d "$VERIFIER_TRANSACTION_DIR" ]]; then
    oci_pin_transaction_dir
    oci_reconcile_journal_temps
    oci_assert_transaction_tree
    if ! oci_transaction_has_journal; then
      oci_remove_pinned_transaction_dir
    else
      oci_validate_journal_shape
    fi
    if [[ -d "$VERIFIER_TRANSACTION_DIR" &&
      "$(oci_read_journal phase)" == "committed" ]]; then
      finish_committed_verifier_transaction
      VERIFIER_TRANSACTION_DIR_DEV=""
      VERIFIER_TRANSACTION_DIR_INO=""
      mkdir -m 700 "$VERIFIER_LOCK_DIR"
      printf '%s\n' "$$" >"$VERIFIER_LOCK_DIR/pid"
      chmod 600 "$VERIFIER_LOCK_DIR/pid"
      oci_sync_paths "$VERIFIER_LOCK_DIR/pid" "$VERIFIER_LOCK_DIR"
    elif [[ -d "$VERIFIER_TRANSACTION_DIR" ]]; then
      rollback_verifier_transaction 1
    fi
  fi
  VERIFIER_TRANSACTION_DIR_DEV=""
  VERIFIER_TRANSACTION_DIR_INO=""
  oci_publish_state_marker "$OPENCLAW_VERIFIER_TRANSACTION_ID"
  mkdir -m 700 "$VERIFIER_TRANSACTION_DIR"
  oci_pin_transaction_dir
  oci_backup_transaction_file \
    "$ENV_FILE" \
    "$VERIFIER_TRANSACTION_DIR/env.backup" \
    "1" env_backup_present VERIFIER_ENV_BACKUP_DIGEST VERIFIER_ENV_BACKUP_MODE \
    VERIFIER_ENV_BACKUP_PARENT_DEV VERIFIER_ENV_BACKUP_PARENT_INO
  [[ "$env_backup_present" == "1" ]] ||
    fail "Required verifier environment backup was not captured."
  oci_backup_transaction_file \
    "$OPENCLAW_CONFIG_DIR/openclaw.json" \
    "$VERIFIER_TRANSACTION_DIR/config.backup" \
    "0" VERIFIER_CONFIG_BACKUP_PRESENT VERIFIER_CONFIG_BACKUP_DIGEST \
    VERIFIER_CONFIG_BACKUP_MODE VERIFIER_CONFIG_BACKUP_PARENT_DEV \
    VERIFIER_CONFIG_BACKUP_PARENT_INO
  oci_backup_transaction_file \
    "$SANDBOX_COMPOSE_FILE" \
    "$VERIFIER_TRANSACTION_DIR/sandbox-overlay.backup" \
    "0" VERIFIER_OVERLAY_BACKUP_PRESENT VERIFIER_OVERLAY_BACKUP_DIGEST \
    VERIFIER_OVERLAY_BACKUP_MODE VERIFIER_OVERLAY_BACKUP_PARENT_DEV \
    VERIFIER_OVERLAY_BACKUP_PARENT_INO
  oci_write_journal begun
  trap 'rollback_verifier_transaction $?' EXIT INT TERM
}

oci_fact() {
  printf '%s\n' "$1" |
    sed -n "s/.*\\\"$2\\\":\\\"\\([^\\\"]*\\)\\\".*/\\1/p" |
    tail -n 1
}

oci_verify_image() {
  local image_id="$1"
  local dependency="${2:-}"
  local browser="${3:-}"
  if [[ -n "$dependency" || -n "$browser" ]]; then
    set -- \
      --dependency-manifest "$dependency" \
      --browser-manifest "$browser"
  else
    # Bash 3.2 with nounset rejects an empty "${array[@]}" expansion.
    # Positional "$@" is well-defined for both zero and populated arguments.
    set --
  fi
  docker run --rm --network none --read-only --cap-drop ALL \
    --security-opt no-new-privileges --user root \
    --workdir "$OPENCLAW_VERIFIER_GATEWAY_WORKSPACE" \
    --mount "type=bind,src=$OPENCLAW_VERIFIER_WORKSPACE_DIR,dst=$OPENCLAW_VERIFIER_GATEWAY_WORKSPACE,readonly" \
    --mount "type=image,src=$image_id,dst=$OPENCLAW_VERIFIER_GATEWAY_WORKSPACE/node_modules,readonly,image-subpath=opt/openclaw-verifier/dependencies" \
    --mount "type=image,src=$image_id,dst=/home/node/.cache/ms-playwright,readonly,image-subpath=opt/openclaw-verifier/browsers" \
    --tmpfs /tmp:rw,nosuid,nodev,noexec,size=64m \
    --env OPENCLAW_VERIFIER_VERIFY=1 --entrypoint node "$image_id" \
    /opt/openclaw/openclaw.mjs sandbox verifier-verify \
    --workspace "$OPENCLAW_VERIFIER_GATEWAY_WORKSPACE" \
    --browser-root /home/node/.cache/ms-playwright \
    --repository-head "$VERIFIER_REPOSITORY_HEAD" \
    --source-revision "$OPENCLAW_SOURCE_REVISION" \
    "$@"
}

prepare_and_publish_verifier_toolchain() {
  local output=""
  local final_output=""
  local declared=""
  local gateway=""
  local gateway_health=""
  local digest=""
  local candidate_layers=""
  local final_layers=""
  oci_assert_pinned_state_dir
  OPENCLAW_VERIFIER_TRANSACTION_ID="$(
    node -e 'process.stdout.write(require("node:crypto").randomBytes(16).toString("hex"))'
  )"
  VERIFIER_OPERATION_BINDING="$(
    oci_operation_binding "$OPENCLAW_VERIFIER_TRANSACTION_ID"
  )"
  VERIFIER_CANDIDATE_TAG="openclaw-sandbox-verifier:candidate-$OPENCLAW_VERIFIER_TRANSACTION_ID"
  VERIFIER_FINAL_TAG="openclaw-sandbox-verifier:published-$OPENCLAW_VERIFIER_TRANSACTION_ID"
  VERIFIER_CANDIDATE_IMAGE_ID=""
  VERIFIER_FINAL_IMAGE_ID=""
  VERIFIER_NEW_GATEWAY_ID=""
  VERIFIER_RUNTIME_IMAGE_ID=""
  VERIFIER_OLD_GATEWAY_ID=""
  VERIFIER_OLD_GATEWAY_IMAGE_ID=""
  VERIFIER_OLD_IMAGE_ID="${OPENCLAW_VERIFIER_IMAGE_ID:-}"
  VERIFIER_OLD_STABLE_IMAGE_ID="$(
    docker image inspect --format '{{.Id}}' openclaw-sandbox-verifier:bookworm-slim 2>/dev/null ||
      true
  )"
  VERIFIER_GATEWAY_WAS_RUNNING=""
  VERIFIER_ENV_BACKUP_DIGEST=""
  VERIFIER_ENV_BACKUP_MODE=""
  VERIFIER_ENV_BACKUP_PARENT_DEV=""
  VERIFIER_ENV_BACKUP_PARENT_INO=""
  VERIFIER_CONFIG_BACKUP_PRESENT="0"
  VERIFIER_CONFIG_BACKUP_DIGEST=""
  VERIFIER_CONFIG_BACKUP_MODE=""
  VERIFIER_CONFIG_BACKUP_PARENT_DEV=""
  VERIFIER_CONFIG_BACKUP_PARENT_INO=""
  VERIFIER_OVERLAY_BACKUP_PRESENT="0"
  VERIFIER_OVERLAY_BACKUP_DIGEST=""
  VERIFIER_OVERLAY_BACKUP_MODE=""
  VERIFIER_OVERLAY_BACKUP_PARENT_DEV=""
  VERIFIER_OVERLAY_BACKUP_PARENT_INO=""
  VERIFIER_DOCKER_SOCKET_PATH="$DOCKER_SOCKET_PATH"
  VERIFIER_REPOSITORY_HEAD="$(
    git -C "$OPENCLAW_VERIFIER_WORKSPACE_DIR" rev-parse --verify 'HEAD^{commit}'
  )"
  [[ "$VERIFIER_REPOSITORY_HEAD" =~ ^[a-f0-9]{40}$ ]] ||
    fail "Guarded verifier workspace requires an exact repository HEAD."
  declared="$(
    node -p "require(process.argv[1]).packageManager" \
      "$OPENCLAW_VERIFIER_WORKSPACE_DIR/package.json"
  )"
  [[ "$declared" == "$OPENCLAW_VERIFIER_PACKAGE_MANAGER" ]] ||
    fail "Guarded verifier packageManager does not match the operator contract."

  gateway="$(docker compose "${COMPOSE_ARGS[@]}" ps -a -q openclaw-gateway)"
  if [[ -n "$gateway" ]]; then
    [[ "$gateway" =~ ^[a-f0-9]{64}$ ]] ||
      fail "Existing Gateway resolved to a malformed immutable container ID."
    VERIFIER_OLD_GATEWAY_ID="$gateway"
    VERIFIER_OLD_GATEWAY_IMAGE_ID="$(docker inspect --format '{{.Image}}' "$gateway")"
    [[ "$VERIFIER_OLD_GATEWAY_IMAGE_ID" =~ ^sha256:[a-f0-9]{64}$ ]] ||
      fail "Existing Gateway resolved to a malformed immutable image ID."
    if [[ "$(docker inspect --format '{{.State.Running}}' "$gateway")" == "true" ]]; then
      VERIFIER_GATEWAY_WAS_RUNNING="1"
    fi
  fi
  VERIFIER_RUNTIME_IMAGE_ID="$(docker image inspect --format '{{.Id}}' "$IMAGE_NAME")"
  [[ "$VERIFIER_RUNTIME_IMAGE_ID" =~ ^sha256:[a-f0-9]{64}$ ]] ||
    fail "Guarded verifier runtime image did not resolve to an immutable image ID."
  [[ -S "$DOCKER_SOCKET_PATH" ]] ||
    fail "Guarded verifier setup requires the configured Docker socket before publication."
  OPENCLAW_IMAGE="$VERIFIER_RUNTIME_IMAGE_ID" \
    docker compose "${COMPOSE_ARGS[@]}" run --rm --no-deps \
    --entrypoint docker openclaw-gateway --version >/dev/null

  begin_verifier_transaction
  run_docker_build \
    --build-arg "OPENCLAW_RUNTIME_IMAGE=$VERIFIER_RUNTIME_IMAGE_ID" \
    --build-arg "OPENCLAW_SOURCE_REVISION=$OPENCLAW_SOURCE_REVISION" \
    --build-arg "OPENCLAW_VERIFIER_PACKAGE_MANAGER=$OPENCLAW_VERIFIER_PACKAGE_MANAGER" \
    --build-arg "OPENCLAW_VERIFIER_REPOSITORY_HEAD=$VERIFIER_REPOSITORY_HEAD" \
    -t "$VERIFIER_CANDIDATE_TAG" \
    -f "$ROOT_DIR/Dockerfile.sandbox-verifier" \
    "$OPENCLAW_VERIFIER_WORKSPACE_DIR"
  VERIFIER_CANDIDATE_IMAGE_ID="$(
    docker image inspect --format '{{.Id}}' "$VERIFIER_CANDIDATE_TAG"
  )"
  [[ "$VERIFIER_CANDIDATE_IMAGE_ID" =~ ^sha256:[a-f0-9]{64}$ ]] ||
    fail "Verifier candidate build returned a malformed image ID."
  oci_write_journal candidate-built

  output="$(oci_verify_image "$VERIFIER_CANDIDATE_IMAGE_ID")"
  OPENCLAW_VERIFIER_DEPENDENCY_MANIFEST="$(oci_fact "$output" dependencyManifestDigest)"
  OPENCLAW_VERIFIER_BROWSER_MANIFEST="$(oci_fact "$output" browserManifestDigest)"
  OPENCLAW_VERIFIER_ARTIFACT_DIGEST="$(oci_fact "$output" toolchainDigest)"
  OPENCLAW_VERIFIER_REPOSITORY_IDENTITY="$(oci_fact "$output" repositoryIdentityDigest)"
  OPENCLAW_VERIFIER_BROWSER_IDENTITY="$(oci_fact "$output" browserIdentityDigest)"
  OPENCLAW_VERIFIER_EFFECTIVE_YARN_VERSION="$(oci_fact "$output" effectiveYarnVersion)"
  for digest in \
    "$OPENCLAW_VERIFIER_DEPENDENCY_MANIFEST" \
    "$OPENCLAW_VERIFIER_BROWSER_MANIFEST" \
    "$OPENCLAW_VERIFIER_ARTIFACT_DIGEST" \
    "$OPENCLAW_VERIFIER_REPOSITORY_IDENTITY" \
    "$OPENCLAW_VERIFIER_BROWSER_IDENTITY"; do
    [[ "$digest" =~ ^[a-f0-9]{64}$ ]] ||
      fail "Verifier candidate returned malformed provenance."
  done
  [[ "$OPENCLAW_VERIFIER_EFFECTIVE_YARN_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([+-][A-Za-z0-9._-]+)?$ ]] ||
    fail "Verifier candidate returned malformed Yarn provenance."
  oci_write_journal candidate-verified

  run_docker_build \
    --build-arg "OPENCLAW_VERIFIER_CANDIDATE_IMAGE=$VERIFIER_CANDIDATE_IMAGE_ID" \
    --build-arg "OPENCLAW_VERIFIER_DEPENDENCY_MANIFEST=$OPENCLAW_VERIFIER_DEPENDENCY_MANIFEST" \
    --build-arg "OPENCLAW_VERIFIER_BROWSER_MANIFEST=$OPENCLAW_VERIFIER_BROWSER_MANIFEST" \
    --build-arg "OPENCLAW_VERIFIER_ARTIFACT_DIGEST=$OPENCLAW_VERIFIER_ARTIFACT_DIGEST" \
    --build-arg "OPENCLAW_VERIFIER_REPOSITORY_IDENTITY=$OPENCLAW_VERIFIER_REPOSITORY_IDENTITY" \
    --build-arg "OPENCLAW_VERIFIER_BROWSER_IDENTITY=$OPENCLAW_VERIFIER_BROWSER_IDENTITY" \
    --build-arg "OPENCLAW_VERIFIER_EFFECTIVE_YARN_VERSION=$OPENCLAW_VERIFIER_EFFECTIVE_YARN_VERSION" \
    -t "$VERIFIER_FINAL_TAG" \
    -f "$VERIFIER_PUBLISH_DOCKERFILE" \
    "$ROOT_DIR"
  VERIFIER_FINAL_IMAGE_ID="$(docker image inspect --format '{{.Id}}' "$VERIFIER_FINAL_TAG")"
  [[ "$VERIFIER_FINAL_IMAGE_ID" =~ ^sha256:[a-f0-9]{64}$ ]] ||
    fail "Verifier publication returned a malformed image ID."
  candidate_layers="$(
    docker image inspect --format '{{json .RootFS.Layers}}' "$VERIFIER_CANDIDATE_IMAGE_ID"
  )"
  final_layers="$(
    docker image inspect --format '{{json .RootFS.Layers}}' "$VERIFIER_FINAL_IMAGE_ID"
  )"
  node - "$candidate_layers" "$final_layers" <<'NODE'
const candidate = JSON.parse(process.argv[2]);
const published = JSON.parse(process.argv[3]);
if (
  !Array.isArray(candidate) ||
  !Array.isArray(published) ||
  candidate.length !== published.length ||
  candidate.some((layer, index) => layer !== published[index])
) {
  throw new Error("Published verifier image is not an exact metadata-only child of the candidate.");
}
NODE
  oci_write_journal final-built
  final_output="$(
    oci_verify_image \
      "$VERIFIER_FINAL_IMAGE_ID" \
      "$OPENCLAW_VERIFIER_DEPENDENCY_MANIFEST" \
      "$OPENCLAW_VERIFIER_BROWSER_MANIFEST"
  )"
  [[ "$(oci_fact "$final_output" toolchainDigest)" == "$OPENCLAW_VERIFIER_ARTIFACT_DIGEST" ]] ||
    fail "Verifier OCI artifact changed after publication labeling."
  oci_write_journal final-verified

  docker tag "$VERIFIER_FINAL_IMAGE_ID" openclaw-sandbox-verifier:bookworm-slim
  oci_write_journal tag-published
  OPENCLAW_VERIFIER_IMAGE_ID="$VERIFIER_FINAL_IMAGE_ID"
  export OPENCLAW_VERIFIER_IMAGE_ID
  export OPENCLAW_VERIFIER_ARTIFACT_DIGEST
  export OPENCLAW_VERIFIER_DEPENDENCY_MANIFEST
  export OPENCLAW_VERIFIER_BROWSER_MANIFEST
  export OPENCLAW_VERIFIER_REPOSITORY_IDENTITY
  export OPENCLAW_VERIFIER_BROWSER_IDENTITY
  export OPENCLAW_VERIFIER_EFFECTIVE_YARN_VERSION
  upsert_env "$ENV_FILE" \
    OPENCLAW_VERIFIER_IMAGE_ID \
    OPENCLAW_VERIFIER_ARTIFACT_DIGEST \
    OPENCLAW_VERIFIER_DEPENDENCY_MANIFEST \
    OPENCLAW_VERIFIER_BROWSER_MANIFEST \
    OPENCLAW_VERIFIER_REPOSITORY_IDENTITY \
    OPENCLAW_VERIFIER_BROWSER_IDENTITY \
    OPENCLAW_VERIFIER_EFFECTIVE_YARN_VERSION
  oci_write_journal env-committed
  if [[ -z "${VERIFIER_RUNTIME_READY:-}" ]]; then
    COMPOSE_ARGS+=("-f" "$VERIFIER_COMPOSE_FILE")
    BASE_COMPOSE_ARGS+=("-f" "$VERIFIER_COMPOSE_FILE")
    COMPOSE_HINT+=" -f ${VERIFIER_COMPOSE_FILE}"
    VERIFIER_RUNTIME_READY="1"
  fi
  write_sandbox_compose_overlay
  if [[ -z "$VERIFIER_SOCKET_OVERLAY_READY" ]]; then
    COMPOSE_ARGS+=("-f" "$SANDBOX_COMPOSE_FILE")
    COMPOSE_HINT+=" -f ${SANDBOX_COMPOSE_FILE}"
    VERIFIER_SOCKET_OVERLAY_READY="1"
  fi
  oci_write_journal socket-overlay-written
  OPENCLAW_IMAGE="$VERIFIER_RUNTIME_IMAGE_ID" \
    run_prestart_cli config set --batch-json \
    '[{"path":"agents.defaults.sandbox.mode","value":"non-main"},{"path":"agents.defaults.sandbox.scope","value":"agent"},{"path":"agents.defaults.sandbox.workspaceAccess","value":"none"}]' >/dev/null
  oci_write_journal sandbox-configured

  OPENCLAW_IMAGE="$VERIFIER_RUNTIME_IMAGE_ID" \
    docker compose "${COMPOSE_ARGS[@]}" up -d --no-deps --force-recreate openclaw-gateway
  gateway="$(docker compose "${COMPOSE_ARGS[@]}" ps -q openclaw-gateway)"
  if [[ ! "$gateway" =~ ^[a-f0-9]{64}$ ]] ||
    [[ "$(docker inspect --format '{{.Image}}' "$gateway")" != "$VERIFIER_RUNTIME_IMAGE_ID" ]] ||
    [[ "$(docker inspect --format '{{.State.Running}}' "$gateway")" != "true" ]]; then
    fail "Guarded verifier publication did not produce a running exact-image Gateway."
  fi
  VERIFIER_NEW_GATEWAY_ID="$gateway"
  oci_write_journal gateway-started
  gateway_health=""
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
    gateway_health="$(
      docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' \
        "$gateway"
    )"
    if [[ "$gateway_health" == "healthy" ]]; then
      break
    fi
    if [[ "$gateway_health" == "unhealthy" ]]; then
      fail "Guarded verifier publication produced an unhealthy Gateway."
    fi
    sleep 5
  done
  if [[ "$gateway_health" != "healthy" ]]; then
    fail "Guarded verifier publication Gateway did not become healthy."
  fi
  oci_assert_exact_gateway_ready \
    "$gateway" "$VERIFIER_RUNTIME_IMAGE_ID" "$DOCKER_SOCKET_PATH"
  oci_write_journal gateway-ready
  commit_verifier_transaction
}

commit_verifier_transaction() {
  [[ ! -L "$VERIFIER_TRANSACTION_DIR" ]] ||
    fail "Verifier transaction directory must not be a symlink."
  [[ -d "$VERIFIER_TRANSACTION_DIR" ]] || return
  oci_assert_transaction_parent_identity \
    "$ENV_FILE" "$VERIFIER_ENV_BACKUP_PARENT_DEV" "$VERIFIER_ENV_BACKUP_PARENT_INO"
  oci_assert_transaction_parent_identity \
    "$OPENCLAW_CONFIG_DIR/openclaw.json" \
    "$VERIFIER_CONFIG_BACKUP_PARENT_DEV" "$VERIFIER_CONFIG_BACKUP_PARENT_INO"
  oci_assert_transaction_parent_identity \
    "$SANDBOX_COMPOSE_FILE" \
    "$VERIFIER_OVERLAY_BACKUP_PARENT_DEV" "$VERIFIER_OVERLAY_BACKUP_PARENT_INO"
  oci_write_journal committed
  finish_committed_verifier_transaction
  trap - EXIT INT TERM
}

if [[ -n "$VERIFIER_ENABLED" ]]; then
  # Reject unsafe persistent state placement before mutating .env, building
  # images, or changing the running Gateway.
  oci_assert_state_dir
  recover_existing_verifier_transaction_before_mutation
  oci_assert_pinned_state_dir
fi

upsert_env "$ENV_FILE" \
  OPENCLAW_CONFIG_DIR \
  OPENCLAW_WORKSPACE_DIR \
  OPENCLAW_GATEWAY_PORT \
  OPENCLAW_BRIDGE_PORT \
  OPENCLAW_GATEWAY_BIND \
  OPENCLAW_GATEWAY_TOKEN \
  OPENCLAW_IMAGE \
  OPENCLAW_EXTRA_MOUNTS \
  OPENCLAW_HOME_VOLUME \
  OPENCLAW_DOCKER_APT_PACKAGES \
  OPENCLAW_EXTENSIONS \
  OPENCLAW_INSTALL_BROWSER \
  OPENCLAW_SANDBOX \
  OPENCLAW_DOCKER_SOCKET \
  DOCKER_GID \
  OPENCLAW_INSTALL_DOCKER_CLI \
  OPENCLAW_ALLOW_INSECURE_PRIVATE_WS \
  OPENCLAW_TZ \
  OPENCLAW_VERIFIER_WORKSPACE_DIR \
  OPENCLAW_VERIFIER_GATEWAY_WORKSPACE \
  OPENCLAW_VERIFIER_PACKAGE_MANAGER \
  OPENCLAW_VERIFIER_IMAGE_ID \
  OPENCLAW_VERIFIER_ARTIFACT_DIGEST \
  OPENCLAW_VERIFIER_DEPENDENCY_MANIFEST \
  OPENCLAW_VERIFIER_BROWSER_MANIFEST \
  OPENCLAW_VERIFIER_REPOSITORY_IDENTITY \
  OPENCLAW_VERIFIER_BROWSER_IDENTITY \
  OPENCLAW_VERIFIER_EFFECTIVE_YARN_VERSION

if [[ "$IMAGE_NAME" == "openclaw:local" ]]; then
  SOURCE_REVISION=""
  if [[ -n "$SOURCE_REVISION_WAS_EXPLICIT" ]]; then
    SOURCE_REVISION="${OPENCLAW_SOURCE_REVISION:-}"
  fi
  if [[ -z "$SOURCE_REVISION" ]]; then
    SOURCE_REVISION="$(git -C "$ROOT_DIR" rev-parse --verify 'HEAD^{commit}')"
  fi
  if [[ ! "$SOURCE_REVISION" =~ ^[a-f0-9]{40}$ ]]; then
    fail "Local image builds require an exact OPENCLAW_SOURCE_REVISION or Git HEAD."
  fi
  if [[ -n "$VERIFIER_ENABLED" ]]; then
    assert_clean_verifier_checkout "$SOURCE_REVISION"
  fi
  PROVENANCE_IMAGE="${IMAGE_NAME}-provenance"
  PROVENANCE_URI="embedded:/opt/openclaw/build-provenance"
  echo "==> Building Docker image: $IMAGE_NAME"
  run_docker_build \
    --build-arg "OPENCLAW_SOURCE_REVISION=${SOURCE_REVISION}" \
    --build-arg "OPENCLAW_PROVENANCE_ARTIFACT_URI=${PROVENANCE_URI}" \
    --build-arg "OPENCLAW_DOCKER_APT_PACKAGES=${OPENCLAW_DOCKER_APT_PACKAGES}" \
    --build-arg "OPENCLAW_EXTENSIONS=${OPENCLAW_EXTENSIONS}" \
    --build-arg "OPENCLAW_INSTALL_BROWSER=${OPENCLAW_INSTALL_BROWSER}" \
    --build-arg "OPENCLAW_INSTALL_DOCKER_CLI=${OPENCLAW_INSTALL_DOCKER_CLI:-}" \
    -t "$IMAGE_NAME" \
    -f "$ROOT_DIR/Dockerfile" \
    "$ROOT_DIR"
  echo "==> Retaining source maps in provenance image: $PROVENANCE_IMAGE"
  run_docker_build \
    --target provenance-artifacts \
    --build-arg "OPENCLAW_SOURCE_REVISION=${SOURCE_REVISION}" \
    --build-arg "OPENCLAW_PROVENANCE_ARTIFACT_URI=${PROVENANCE_URI}" \
    --build-arg "OPENCLAW_EXTENSIONS=${OPENCLAW_EXTENSIONS}" \
    --build-arg "OPENCLAW_INSTALL_BROWSER=${OPENCLAW_INSTALL_BROWSER}" \
    -t "$PROVENANCE_IMAGE" \
    -f "$ROOT_DIR/Dockerfile" \
    "$ROOT_DIR"
else
  echo "==> Pulling Docker image: $IMAGE_NAME"
  if ! docker pull "$IMAGE_NAME"; then
    echo "ERROR: Failed to pull image $IMAGE_NAME. Please check the image name and your access permissions." >&2
    exit 1
  fi
  SOURCE_REVISION=""
  if [[ -n "$SOURCE_REVISION_WAS_EXPLICIT" ]]; then
    SOURCE_REVISION="${OPENCLAW_SOURCE_REVISION:-}"
  fi
  if [[ -n "$VERIFIER_ENABLED" ]]; then
    DEPLOYED_SOURCE_REVISION="$(docker image inspect --format '{{ index .Config.Labels \"org.opencontainers.image.revision\" }}' "$IMAGE_NAME")"
    if [[ ! "$DEPLOYED_SOURCE_REVISION" =~ ^[a-f0-9]{40}$ ]]; then
      fail "Registry verifier setup requires an exact deployed image revision label."
    fi
    if [[ -n "$SOURCE_REVISION" && "$SOURCE_REVISION" != "$DEPLOYED_SOURCE_REVISION" ]]; then
      fail "OPENCLAW_SOURCE_REVISION does not match the pulled Gateway image."
    fi
    SOURCE_REVISION="$DEPLOYED_SOURCE_REVISION"
    assert_clean_verifier_checkout "$SOURCE_REVISION"
  fi
fi
export OPENCLAW_SOURCE_REVISION="$SOURCE_REVISION"
upsert_env "$ENV_FILE" OPENCLAW_SOURCE_REVISION

# Ensure bind-mounted data directories are writable by the container's `node`
# user (uid 1000). Host-created dirs inherit the host user's uid which may
# differ, causing EACCES when the container tries to mkdir/write.
# Running a brief root container to chown is the portable Docker idiom --
# it works regardless of the host uid and doesn't require host-side root.
echo ""
echo "==> Fixing data-directory permissions"
# Use -xdev to restrict chown to the config-dir mount only — without it,
# the recursive chown would cross into the workspace bind mount and rewrite
# ownership of all user project files on Linux hosts.
# After fixing the config dir, only the OpenClaw metadata subdirectory
# (.openclaw/) inside the workspace gets chowned, not the user's project files.
run_prestart_gateway --user root --entrypoint sh openclaw-gateway -c \
  'find /home/node/.openclaw -xdev -exec chown node:node {} +; \
   [ -d /home/node/.openclaw/workspace/.openclaw ] && chown -R node:node /home/node/.openclaw/workspace/.openclaw || true'

echo ""
echo "==> Onboarding (interactive)"
echo "Docker setup pins Gateway mode to local."
echo "Gateway runtime bind comes from OPENCLAW_GATEWAY_BIND (default: lan)."
echo "Current runtime bind: $OPENCLAW_GATEWAY_BIND"
echo "Gateway token: $OPENCLAW_GATEWAY_TOKEN"
echo "Tailscale exposure: Off (use host-level tailnet/Tailscale setup separately)."
echo "Install Gateway daemon: No (managed by Docker Compose)"
echo ""
run_prestart_cli onboard --mode local --no-install-daemon

echo ""
echo "==> Docker gateway defaults"
sync_gateway_config

echo ""
echo "==> Provider setup (optional)"
echo "WhatsApp (QR):"
echo "  ${COMPOSE_HINT} run --rm openclaw-cli channels login"
echo "Telegram (bot token):"
echo "  ${COMPOSE_HINT} run --rm openclaw-cli channels add --channel telegram --token <token>"
echo "Discord (bot token):"
echo "  ${COMPOSE_HINT} run --rm openclaw-cli channels add --channel discord --token <token>"
echo "Docs: https://docs.openclaw.ai/channels"

if [[ -n "$SANDBOX_ENABLED" ]]; then
  echo ""
  echo "==> Sandbox setup"
  if [[ -f "$ROOT_DIR/Dockerfile.sandbox" ]]; then
    echo "Building sandbox image: openclaw-sandbox:bookworm-slim"
    run_docker_build \
      -t "openclaw-sandbox:bookworm-slim" \
      -f "$ROOT_DIR/Dockerfile.sandbox" \
      "$ROOT_DIR"
  else
    echo "WARNING: Dockerfile.sandbox not found in $ROOT_DIR" >&2
    echo "  Sandbox config will be applied but no sandbox image will be built." >&2
    echo "  Agent exec may fail if the configured sandbox image does not exist." >&2
  fi
fi

if [[ -n "$VERIFIER_ENABLED" ]]; then
  echo ""
  echo "==> Publishing guarded verifier toolchain"
  prepare_and_publish_verifier_toolchain
fi

echo ""
echo "==> Starting gateway"
if [[ -n "$VERIFIER_ENABLED" ]]; then
  echo "Guarded verifier Gateway publication committed after readiness validation."
else
  docker compose "${COMPOSE_ARGS[@]}" up -d openclaw-gateway
fi

# --- Sandbox setup (opt-in via OPENCLAW_SANDBOX=1) ---
if [[ -n "$SANDBOX_ENABLED" && -z "$VERIFIER_ENABLED" ]]; then
  # Defense-in-depth: verify Docker CLI in the running image before enabling
  # sandbox. This avoids claiming sandbox is enabled when the image cannot
  # launch sandbox containers.
  if ! docker compose "${COMPOSE_ARGS[@]}" run --rm --entrypoint docker openclaw-gateway --version >/dev/null 2>&1; then
    echo "WARNING: Docker CLI not found inside the container image." >&2
    echo "  Sandbox requires Docker CLI. Rebuild with --build-arg OPENCLAW_INSTALL_DOCKER_CLI=1" >&2
    echo "  or use a local build (OPENCLAW_IMAGE=openclaw:local). Skipping sandbox setup." >&2
    SANDBOX_ENABLED=""
  fi
fi

# Apply sandbox config only if prerequisites are met.
if [[ -n "$SANDBOX_ENABLED" && -z "$VERIFIER_ENABLED" ]]; then
  # Mount Docker socket via a dedicated compose overlay. This overlay is
  # created only after sandbox prerequisites pass, so the socket is never
  # exposed when sandbox cannot actually run.
  if [[ -S "$DOCKER_SOCKET_PATH" ]]; then
    cat >"$SANDBOX_COMPOSE_FILE" <<YAML
services:
  openclaw-gateway:
    volumes:
      - ${DOCKER_SOCKET_PATH}:/var/run/docker.sock
YAML
    if [[ -n "${DOCKER_GID:-}" ]]; then
      cat >>"$SANDBOX_COMPOSE_FILE" <<YAML
    group_add:
      - "${DOCKER_GID}"
YAML
    fi
    COMPOSE_ARGS+=("-f" "$SANDBOX_COMPOSE_FILE")
    echo "==> Sandbox: added Docker socket mount"
  else
    echo "WARNING: OPENCLAW_SANDBOX enabled but Docker socket not found at $DOCKER_SOCKET_PATH." >&2
    echo "  Sandbox requires Docker socket access. Skipping sandbox setup." >&2
    SANDBOX_ENABLED=""
  fi
fi

if [[ -n "$SANDBOX_ENABLED" && -z "$VERIFIER_ENABLED" ]]; then
  # Enable sandbox in OpenClaw config.
  sandbox_config_ok=true
  if ! run_runtime_cli current no-deps \
    config set agents.defaults.sandbox.mode "non-main" >/dev/null; then
    echo "WARNING: Failed to set agents.defaults.sandbox.mode" >&2
    sandbox_config_ok=false
  fi
  if ! run_runtime_cli current no-deps \
    config set agents.defaults.sandbox.scope "agent" >/dev/null; then
    echo "WARNING: Failed to set agents.defaults.sandbox.scope" >&2
    sandbox_config_ok=false
  fi
  if ! run_runtime_cli current no-deps \
    config set agents.defaults.sandbox.workspaceAccess "none" >/dev/null; then
    echo "WARNING: Failed to set agents.defaults.sandbox.workspaceAccess" >&2
    sandbox_config_ok=false
  fi

  if [[ "$sandbox_config_ok" == true ]]; then
    echo "Sandbox enabled: mode=non-main, scope=agent, workspaceAccess=none"
    echo "Docs: https://docs.openclaw.ai/gateway/sandboxing"
    # Restart gateway with sandbox compose overlay to pick up socket mount + config.
    docker compose "${COMPOSE_ARGS[@]}" up -d openclaw-gateway
  else
    echo "WARNING: Sandbox config was partially applied. Check errors above." >&2
    echo "  Skipping gateway restart to avoid exposing Docker socket without a full sandbox policy." >&2
    if ! run_runtime_cli base no-deps \
      config set agents.defaults.sandbox.mode "off" >/dev/null; then
      echo "WARNING: Failed to roll back agents.defaults.sandbox.mode to off" >&2
    else
      echo "Sandbox mode rolled back to off due to partial sandbox config failure."
    fi
    if [[ -n "${SANDBOX_COMPOSE_FILE:-}" ]]; then
      rm -f "$SANDBOX_COMPOSE_FILE"
    fi
  fi
elif [[ -z "$VERIFIER_ENABLED" ]]; then
  # Keep reruns deterministic: if sandbox is not active for this run, reset
  # persisted sandbox mode so future execs do not require docker.sock by stale
  # config alone.
  if ! run_runtime_cli current with-deps \
    config set agents.defaults.sandbox.mode "off" >/dev/null; then
    echo "WARNING: Failed to reset agents.defaults.sandbox.mode to off" >&2
  fi
  if [[ -f "$SANDBOX_COMPOSE_FILE" ]]; then
    rm -f "$SANDBOX_COMPOSE_FILE"
  fi
fi

echo ""
echo "Gateway running with host port mapping."
echo "Access from tailnet devices via the host's tailnet IP."
echo "Config: $OPENCLAW_CONFIG_DIR"
echo "Workspace: $OPENCLAW_WORKSPACE_DIR"
echo "Token: $OPENCLAW_GATEWAY_TOKEN"
echo ""
echo "Commands:"
echo "  ${COMPOSE_HINT} logs -f openclaw-gateway"
echo "  ${COMPOSE_HINT} exec openclaw-gateway node dist/index.js health --token \"$OPENCLAW_GATEWAY_TOKEN\""
