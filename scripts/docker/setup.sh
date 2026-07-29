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
VERIFIER_RUNTIME_IMAGE_REF=""
VERIFIER_OLD_GATEWAY_ID=""
VERIFIER_OLD_GATEWAY_IMAGE_ID=""
VERIFIER_GATEWAY_COMPOSE_PROJECT=""
VERIFIER_GATEWAY_COMPOSE_SERVICE=""
VERIFIER_GATEWAY_CANDIDATE_LABEL=""
VERIFIER_GATEWAY_CREATE_BINDING=""
VERIFIER_CONFIG_BACKUP_PRESENT="0"
VERIFIER_CONFIG_BACKUP_DIGEST=""
VERIFIER_CONFIG_BACKUP_MODE=""
VERIFIER_CONFIG_BACKUP_PARENT_DEV=""
VERIFIER_CONFIG_BACKUP_PARENT_INO=""
VERIFIER_CONFIG_DEV=""
VERIFIER_CONFIG_INO=""
VERIFIER_TRANSACTION_FORMAT="2"
VERIFIER_CONFIG_POLICY="write"
VERIFIER_JOURNAL_CONTRACT_VERSION=""
VERIFIER_OPERATION_CONTRACT_VERSION=""
VERIFIER_OPERATION_FORMAT=""
VERIFIER_OPERATION_CONFIG_POLICY=""
VERIFIER_CONFIGURED_GATEWAY_BIND=""
VERIFIER_RUNTIME_GATEWAY_BIND=""
VERIFIER_BIND_OVERRIDE_AUTHORIZED="0"
VERIFIER_OPERATION_CONFIGURED_GATEWAY_BIND=""
VERIFIER_OPERATION_RUNTIME_GATEWAY_BIND=""
VERIFIER_OPERATION_BIND_OVERRIDE_AUTHORIZED=""
VERIFIER_COMMITTED_RECOVERY_COMPLETED=""
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
PROTECTED_CONFIG_DEV=""
PROTECTED_CONFIG_INO=""
PROTECTED_CONFIG_MODE=""
PROTECTED_CONFIG_DIGEST=""
PROTECTED_CONFIG_PARENT_DEV=""
PROTECTED_CONFIG_PARENT_INO=""
PROTECTED_CONFIG_GATEWAY_BIND=""
DEFER_PROTECTED_CONFIG_VALIDATION=""
SOURCE_REVISION_WAS_EXPLICIT=""
if printenv OPENCLAW_SOURCE_REVISION >/dev/null 2>&1; then
  SOURCE_REVISION_WAS_EXPLICIT="1"
fi
READ_ONLY_CONFIG_PROCESS_SETTING_PRESENT=""
if printenv OPENCLAW_SETUP_READ_ONLY_CONFIG >/dev/null 2>&1; then
  READ_ONLY_CONFIG_PROCESS_SETTING_PRESENT="1"
fi
BIND_OVERRIDE_PROCESS_SETTING_PRESENT=""
if printenv OPENCLAW_SETUP_READ_ONLY_CONFIG_ALLOW_BIND_OVERRIDE >/dev/null 2>&1; then
  BIND_OVERRIDE_PROCESS_SETTING_PRESENT="1"
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
  allowed+="OPENCLAW_GATEWAY_BIND OPENCLAW_SETUP_READ_ONLY_CONFIG "
  allowed+="OPENCLAW_SETUP_READ_ONLY_CONFIG_ALLOW_BIND_OVERRIDE "
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
RAW_READ_ONLY_CONFIG_SETTING="${OPENCLAW_SETUP_READ_ONLY_CONFIG:-}"
READ_ONLY_CONFIG_ENABLED=""
READ_ONLY_CONFIG_SETTING_PRESENT=""
if printenv OPENCLAW_SETUP_READ_ONLY_CONFIG >/dev/null 2>&1; then
  READ_ONLY_CONFIG_SETTING_PRESENT="1"
fi
RAW_BIND_OVERRIDE_SETTING="${OPENCLAW_SETUP_READ_ONLY_CONFIG_ALLOW_BIND_OVERRIDE:-}"
BIND_OVERRIDE_ENABLED=""
BIND_OVERRIDE_SETTING_PRESENT=""
if printenv OPENCLAW_SETUP_READ_ONLY_CONFIG_ALLOW_BIND_OVERRIDE >/dev/null 2>&1; then
  BIND_OVERRIDE_SETTING_PRESENT="1"
fi
GATEWAY_BIND_SETTING_PRESENT=""
if printenv OPENCLAW_GATEWAY_BIND >/dev/null 2>&1; then
  GATEWAY_BIND_SETTING_PRESENT="1"
fi
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

detect_container_docker_socket_gid() {
  local image="$1"
  local socket_path="$2"
  local gid=""
  [[ "$socket_path" != *","* ]] ||
    fail "OPENCLAW_DOCKER_SOCKET cannot contain a comma during effective GID detection."
  gid="$(
    docker run --rm \
      --network none \
      --read-only \
      --cap-drop ALL \
      --security-opt no-new-privileges:true \
      --mount "type=bind,source=$socket_path,target=/var/run/docker.sock,readonly" \
      --entrypoint stat \
      "$image" -c '%g' /var/run/docker.sock
  )"
  [[ "$gid" =~ ^[0-9]+$ ]] ||
    fail "Docker socket did not expose one valid group ID inside the runtime image."
  printf '%s' "$gid"
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

capture_protected_config() {
  local config_path="$OPENCLAW_CONFIG_DIR/openclaw.json"
  local metadata=""
  if metadata="$(
    node - "$config_path" <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const [configPath] = process.argv.slice(2);
if (!path.isAbsolute(configPath) || path.basename(configPath) !== "openclaw.json") {
  throw new Error("Protected OpenClaw config path must be an absolute direct file.");
}
const directory = path.dirname(configPath);
const leaf = path.basename(configPath);
const parent = fs.lstatSync(directory, { bigint: true });
if (
  !parent.isDirectory() ||
  parent.isSymbolicLink() ||
  fs.realpathSync(directory) !== directory
) {
  throw new Error("Protected OpenClaw config parent must be a direct canonical directory.");
}
process.chdir(directory);
const pinnedParent = fs.lstatSync(".", { bigint: true });
if (pinnedParent.dev !== parent.dev || pinnedParent.ino !== parent.ino) {
  throw new Error("Protected OpenClaw config parent changed before capture.");
}
const before = fs.lstatSync(leaf, { bigint: true });
if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
  throw new Error("Protected OpenClaw config must be a direct single-link regular file.");
}
const fd = fs.openSync(leaf, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
try {
  const opened = fs.fstatSync(fd, { bigint: true });
  if (
    opened.dev !== before.dev ||
    opened.ino !== before.ino ||
    opened.mode !== before.mode ||
    opened.nlink !== 1n
  ) {
    throw new Error("Protected OpenClaw config changed before capture.");
  }
  const first = fs.readFileSync(fd);
  const middle = fs.fstatSync(fd, { bigint: true });
  const second = Buffer.alloc(Number(middle.size));
  let offset = 0;
  while (offset < second.length) {
    const count = fs.readSync(fd, second, offset, second.length - offset, offset);
    if (count === 0) {
      throw new Error("Protected OpenClaw config changed during capture.");
    }
    offset += count;
  }
  const after = fs.fstatSync(fd, { bigint: true });
  const finalPath = fs.lstatSync(leaf, { bigint: true });
  const finalParent = fs.lstatSync(".", { bigint: true });
  if (
    opened.dev !== after.dev ||
    opened.ino !== after.ino ||
    opened.mode !== after.mode ||
    opened.nlink !== after.nlink ||
    opened.size !== after.size ||
    opened.mtimeNs !== after.mtimeNs ||
    opened.ctimeNs !== after.ctimeNs ||
    middle.size !== opened.size ||
    finalPath.dev !== opened.dev ||
    finalPath.ino !== opened.ino ||
    finalPath.mode !== opened.mode ||
    finalPath.nlink !== 1n ||
    finalParent.dev !== parent.dev ||
    finalParent.ino !== parent.ino ||
    !first.equals(second)
  ) {
    throw new Error("Protected OpenClaw config changed during capture.");
  }
  process.stdout.write(
    [
      opened.dev,
      opened.ino,
      (opened.mode & 0o7777n).toString(8),
      crypto.createHash("sha256").update(first).digest("hex"),
      parent.dev,
      parent.ino,
    ].join("|"),
  );
} finally {
  fs.closeSync(fd);
}
NODE
  )"; then
    :
  else
    fail "Protected existing config capture failed."
  fi
  IFS='|' read -r \
    PROTECTED_CONFIG_DEV PROTECTED_CONFIG_INO PROTECTED_CONFIG_MODE \
    PROTECTED_CONFIG_DIGEST PROTECTED_CONFIG_PARENT_DEV \
    PROTECTED_CONFIG_PARENT_INO <<<"$metadata"
  [[ "$PROTECTED_CONFIG_DEV" =~ ^[0-9]+$ &&
    "$PROTECTED_CONFIG_INO" =~ ^[0-9]+$ &&
    "$PROTECTED_CONFIG_MODE" =~ ^[0-7]{3,4}$ &&
    "$PROTECTED_CONFIG_DIGEST" =~ ^[a-f0-9]{64}$ &&
    "$PROTECTED_CONFIG_PARENT_DEV" =~ ^[0-9]+$ &&
    "$PROTECTED_CONFIG_PARENT_INO" =~ ^[0-9]+$ ]] ||
    fail "Protected existing config capture returned malformed metadata."
}

assert_protected_config_unchanged() {
  local label="${1:-Protected OpenClaw config}"
  local config_dev="${2:-$PROTECTED_CONFIG_DEV}"
  local config_ino="${3:-$PROTECTED_CONFIG_INO}"
  local config_digest="${4:-$PROTECTED_CONFIG_DIGEST}"
  local config_mode="${5:-$PROTECTED_CONFIG_MODE}"
  local parent_dev="${6:-$PROTECTED_CONFIG_PARENT_DEV}"
  local parent_ino="${7:-$PROTECTED_CONFIG_PARENT_INO}"
  node - "$OPENCLAW_CONFIG_DIR/openclaw.json" \
    "$config_dev" "$config_ino" "$config_digest" "$config_mode" \
    "$parent_dev" "$parent_ino" "$label" <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const [
  target,
  expectedDev,
  expectedIno,
  expectedDigest,
  expectedMode,
  expectedParentDev,
  expectedParentIno,
  label,
] = process.argv.slice(2);
if (
  !path.isAbsolute(target) ||
  !/^[0-9]+$/.test(expectedDev) ||
  !/^[0-9]+$/.test(expectedIno) ||
  !/^[a-f0-9]{64}$/.test(expectedDigest) ||
  !/^[0-7]{3,4}$/.test(expectedMode) ||
  !/^[0-9]+$/.test(expectedParentDev) ||
  !/^[0-9]+$/.test(expectedParentIno)
) {
  throw new Error("Protected config assertion metadata is malformed.");
}
const directory = path.dirname(target);
const leaf = path.basename(target);
const parent = fs.lstatSync(directory, { bigint: true });
const sameParent = (value) =>
  value.isDirectory() &&
  !value.isSymbolicLink() &&
  String(value.dev) === expectedParentDev &&
  String(value.ino) === expectedParentIno;
if (!sameParent(parent) || fs.realpathSync(directory) !== directory) {
  throw new Error(`${label} parent identity changed.`);
}
process.chdir(directory);
if (!sameParent(fs.lstatSync(".", { bigint: true }))) {
  throw new Error(`${label} parent changed before inspection.`);
}
const before = fs.lstatSync(leaf, { bigint: true });
if (
  !before.isFile() ||
  before.isSymbolicLink() ||
  before.nlink !== 1n ||
  String(before.dev) !== expectedDev ||
  String(before.ino) !== expectedIno ||
  (before.mode & 0o7777n).toString(8) !== expectedMode
) {
  throw new Error(`${label} identity or mode changed.`);
}
const fd = fs.openSync(leaf, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
try {
  const opened = fs.fstatSync(fd, { bigint: true });
  if (
    opened.dev !== before.dev ||
    opened.ino !== before.ino ||
    opened.mode !== before.mode ||
    opened.nlink !== 1n
  ) {
    throw new Error(`${label} changed before read.`);
  }
  const bytes = fs.readFileSync(fd);
  const after = fs.fstatSync(fd, { bigint: true });
  const finalPath = fs.lstatSync(leaf, { bigint: true });
  if (
    after.dev !== opened.dev ||
    after.ino !== opened.ino ||
    after.mode !== opened.mode ||
    after.nlink !== 1n ||
    after.size !== opened.size ||
    after.mtimeNs !== opened.mtimeNs ||
    after.ctimeNs !== opened.ctimeNs ||
    finalPath.dev !== opened.dev ||
    finalPath.ino !== opened.ino ||
    finalPath.mode !== opened.mode ||
    finalPath.nlink !== 1n ||
    crypto.createHash("sha256").update(bytes).digest("hex") !== expectedDigest ||
    !sameParent(fs.lstatSync(".", { bigint: true }))
  ) {
    throw new Error(`${label} changed during verification.`);
  }
} finally {
  fs.closeSync(fd);
}
NODE
}

assert_protected_config_immutable() {
  local label="${1:-Protected OpenClaw config}"
  local config_dev="${2:-$PROTECTED_CONFIG_DEV}"
  local config_ino="${3:-$PROTECTED_CONFIG_INO}"
  local config_digest="${4:-$PROTECTED_CONFIG_DIGEST}"
  local config_mode="${5:-$PROTECTED_CONFIG_MODE}"
  local parent_dev="${6:-$PROTECTED_CONFIG_PARENT_DEV}"
  local parent_ino="${7:-$PROTECTED_CONFIG_PARENT_INO}"
  local host_platform=""
  local stat_command="/usr/bin/stat"
  local flag_record=""
  local flag_dev=""
  local flag_ino=""
  local flags=""

  if [[ "${OPENCLAW_DOCKER_SETUP_TEST:-}" == "1" ]]; then
    host_platform="${OPENCLAW_TEST_HOST_PLATFORM:-}"
    if [[ -n "${OPENCLAW_TEST_PROTECTED_CONFIG_STAT_COMMAND:-}" ]]; then
      stat_command="$OPENCLAW_TEST_PROTECTED_CONFIG_STAT_COMMAND"
    fi
  else
    [[ -x "/usr/bin/uname" && ! -L "/usr/bin/uname" ]] ||
      fail "Read-only existing-config setup requires the exact macOS uname command."
    host_platform="$(/usr/bin/uname -s)"
  fi
  [[ "$host_platform" == "Darwin" ]] ||
    fail "OPENCLAW_SETUP_READ_ONLY_CONFIG requires macOS user-immutable config protection."
  if [[ "${OPENCLAW_DOCKER_SETUP_TEST:-}" != "1" ]]; then
    [[ "$stat_command" == "/usr/bin/stat" ]] ||
      fail "Protected config flag inspection command is not the production contract."
  fi
  [[ "$stat_command" == /* && -x "$stat_command" && -f "$stat_command" &&
    ! -L "$stat_command" ]] ||
    fail "Protected config flag inspection command is unsafe."

  assert_protected_config_unchanged \
    "$label before immutable-flag inspection" \
    "$config_dev" "$config_ino" "$config_digest" "$config_mode" \
    "$parent_dev" "$parent_ino"
  if flag_record="$(
    OPENCLAW_PROTECTED_CONFIG_FLAG_CHECK_LABEL="$label" \
      "$stat_command" -f '%d|%i|%Sf' "$OPENCLAW_CONFIG_DIR/openclaw.json"
  )"; then
    :
  else
    fail "$label immutable-flag inspection failed."
  fi
  flag_record="${flag_record//$'\r'/}"
  [[ "$flag_record" != *$'\n'* ]] ||
    fail "$label immutable-flag inspection returned ambiguous output."
  IFS='|' read -r flag_dev flag_ino flags <<<"$flag_record"
  [[ "$flag_dev" == "$config_dev" && "$flag_ino" == "$config_ino" &&
    -n "$flags" ]] ||
    fail "$label immutable-flag identity changed."
  case ",$flags," in
    *,uchg,*) ;;
    *) fail "$label requires the macOS user-immutable uchg flag." ;;
  esac
  assert_protected_config_unchanged \
    "$label after immutable-flag inspection" \
    "$config_dev" "$config_ino" "$config_digest" "$config_mode" \
    "$parent_dev" "$parent_ino"
}

read_protected_config_gateway_token() {
  assert_protected_config_immutable "Protected OpenClaw config before token read"
  node - "$OPENCLAW_CONFIG_DIR/openclaw.json" \
    "$PROTECTED_CONFIG_DEV" "$PROTECTED_CONFIG_INO" \
    "$PROTECTED_CONFIG_DIGEST" "$PROTECTED_CONFIG_MODE" \
    "$PROTECTED_CONFIG_PARENT_DEV" "$PROTECTED_CONFIG_PARENT_INO" <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const [
  configPath,
  expectedDev,
  expectedIno,
  expectedDigest,
  expectedMode,
  expectedParentDev,
  expectedParentIno,
] = process.argv.slice(2);
const directory = path.dirname(configPath);
const leaf = path.basename(configPath);
const sameParent = (value) =>
  value.isDirectory() &&
  !value.isSymbolicLink() &&
  String(value.dev) === expectedParentDev &&
  String(value.ino) === expectedParentIno;
if (
  !path.isAbsolute(configPath) ||
  !/^[0-9]+$/.test(expectedDev) ||
  !/^[0-9]+$/.test(expectedIno) ||
  !/^[a-f0-9]{64}$/.test(expectedDigest) ||
  !/^[0-7]{3,4}$/.test(expectedMode) ||
  !/^[0-9]+$/.test(expectedParentDev) ||
  !/^[0-9]+$/.test(expectedParentIno) ||
  !sameParent(fs.lstatSync(directory, { bigint: true })) ||
  fs.realpathSync(directory) !== directory
) {
  throw new Error("Protected config token metadata changed before read.");
}
process.chdir(directory);
if (!sameParent(fs.lstatSync(".", { bigint: true }))) {
  throw new Error("Protected config parent changed before token read.");
}
const before = fs.lstatSync(leaf, { bigint: true });
if (
  !before.isFile() ||
  before.isSymbolicLink() ||
  before.nlink !== 1n ||
  String(before.dev) !== expectedDev ||
  String(before.ino) !== expectedIno ||
  (before.mode & 0o7777n).toString(8) !== expectedMode
) {
  throw new Error("Protected config identity changed before token read.");
}
const fd = fs.openSync(leaf, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
try {
  const opened = fs.fstatSync(fd, { bigint: true });
  if (
    opened.dev !== before.dev ||
    opened.ino !== before.ino ||
    opened.mode !== before.mode ||
    opened.nlink !== 1n
  ) {
    throw new Error("Protected config changed before token read.");
  }
  const bytes = fs.readFileSync(fd);
  const after = fs.fstatSync(fd, { bigint: true });
  const finalPath = fs.lstatSync(leaf, { bigint: true });
  if (
    after.dev !== opened.dev ||
    after.ino !== opened.ino ||
    after.mode !== opened.mode ||
    after.nlink !== 1n ||
    after.size !== opened.size ||
    after.mtimeNs !== opened.mtimeNs ||
    after.ctimeNs !== opened.ctimeNs ||
    finalPath.dev !== opened.dev ||
    finalPath.ino !== opened.ino ||
    finalPath.mode !== opened.mode ||
    finalPath.nlink !== 1n ||
    crypto.createHash("sha256").update(bytes).digest("hex") !== expectedDigest ||
    !sameParent(fs.lstatSync(".", { bigint: true }))
  ) {
    throw new Error("Protected config changed during token read.");
  }
  const parsed = JSON.parse(bytes.toString("utf8"));
  const token = parsed?.gateway?.auth?.token;
  if (typeof token === "string" && token.trim()) {
    process.stdout.write(token.trim());
  }
} finally {
  fs.closeSync(fd);
}
NODE
  assert_protected_config_immutable "Protected OpenClaw config after token read"
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

validate_read_only_existing_config() {
  local expected_configured_bind="${1:-}"
  local runtime_bind="${2:-$OPENCLAW_GATEWAY_BIND}"
  local override_authorized="${3:-${VERIFIER_BIND_OVERRIDE_AUTHORIZED:-0}}"
  local config_dev="${4:-$PROTECTED_CONFIG_DEV}"
  local config_ino="${5:-$PROTECTED_CONFIG_INO}"
  local config_digest="${6:-$PROTECTED_CONFIG_DIGEST}"
  local config_mode="${7:-$PROTECTED_CONFIG_MODE}"
  local config_parent_dev="${8:-$PROTECTED_CONFIG_PARENT_DEV}"
  local config_parent_ino="${9:-$PROTECTED_CONFIG_PARENT_INO}"
  local configured_bind=""
  case "$runtime_bind" in
    auto | custom | lan | loopback | tailnet) ;;
    *) fail "OPENCLAW_GATEWAY_BIND is not a supported Gateway bind mode." ;;
  esac
  [[ -z "$expected_configured_bind" ||
    "$expected_configured_bind" == "auto" ||
    "$expected_configured_bind" == "custom" ||
    "$expected_configured_bind" == "lan" ||
    "$expected_configured_bind" == "loopback" ||
    "$expected_configured_bind" == "tailnet" ]] ||
    fail "Expected protected Gateway bind is malformed."
  [[ "$override_authorized" == "0" || "$override_authorized" == "1" ]] ||
    fail "Protected-config Gateway bind override authorization is malformed."
  assert_protected_config_immutable \
    "Protected OpenClaw config before semantic validation" \
    "$config_dev" "$config_ino" "$config_digest" "$config_mode" \
    "$config_parent_dev" "$config_parent_ino"
  if configured_bind="$(
    node - "$OPENCLAW_CONFIG_DIR/openclaw.json" \
    "$config_dev" "$config_ino" "$config_digest" "$config_mode" \
    "$config_parent_dev" "$config_parent_ino" \
    <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const [
  configPath,
  expectedDev,
  expectedIno,
  expectedDigest,
  expectedMode,
  expectedParentDev,
  expectedParentIno,
] = process.argv.slice(2);
const directory = path.dirname(configPath);
const leaf = path.basename(configPath);
const sameParent = (value) =>
  value.isDirectory() &&
  !value.isSymbolicLink() &&
  String(value.dev) === expectedParentDev &&
  String(value.ino) === expectedParentIno;
if (
  !path.isAbsolute(configPath) ||
  !sameParent(fs.lstatSync(directory, { bigint: true })) ||
  fs.realpathSync(directory) !== directory
) {
  throw new Error("Protected config semantic parent changed.");
}
process.chdir(directory);
if (!sameParent(fs.lstatSync(".", { bigint: true }))) {
  throw new Error("Protected config semantic parent changed before read.");
}
const before = fs.lstatSync(leaf, { bigint: true });
if (
  !before.isFile() ||
  before.isSymbolicLink() ||
  before.nlink !== 1n ||
  String(before.dev) !== expectedDev ||
  String(before.ino) !== expectedIno ||
  (before.mode & 0o7777n).toString(8) !== expectedMode
) {
  throw new Error("Protected config semantic identity changed.");
}
const fd = fs.openSync(leaf, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
try {
  const opened = fs.fstatSync(fd, { bigint: true });
  if (
    opened.dev !== before.dev ||
    opened.ino !== before.ino ||
    opened.mode !== before.mode ||
    opened.nlink !== 1n
  ) {
    throw new Error("Protected config changed before semantic read.");
  }
  const bytes = fs.readFileSync(fd);
  const after = fs.fstatSync(fd, { bigint: true });
  const finalPath = fs.lstatSync(leaf, { bigint: true });
  if (
    after.dev !== opened.dev ||
    after.ino !== opened.ino ||
    after.mode !== opened.mode ||
    after.nlink !== 1n ||
    after.size !== opened.size ||
    after.mtimeNs !== opened.mtimeNs ||
    after.ctimeNs !== opened.ctimeNs ||
    finalPath.dev !== opened.dev ||
    finalPath.ino !== opened.ino ||
    finalPath.mode !== opened.mode ||
    finalPath.nlink !== 1n ||
    crypto.createHash("sha256").update(bytes).digest("hex") !== expectedDigest ||
    !sameParent(fs.lstatSync(".", { bigint: true }))
  ) {
    throw new Error("Protected config changed during semantic read.");
  }
  const parsed = JSON.parse(bytes.toString("utf8"));
  if (
    parsed?.gateway?.mode !== "local" ||
    !["auto", "custom", "lan", "loopback", "tailnet"].includes(parsed?.gateway?.bind) ||
    parsed?.agents?.defaults?.sandbox?.mode !== "non-main" ||
    parsed?.agents?.defaults?.sandbox?.scope !== "agent" ||
    parsed?.agents?.defaults?.sandbox?.workspaceAccess !== "none"
  ) {
    throw new Error("Protected config does not match the guarded verifier policy.");
  }
  process.stdout.write(parsed.gateway.bind);
} finally {
  fs.closeSync(fd);
}
NODE
  )"
  then
    :
  else
    fail "Protected existing config policy validation failed."
  fi
  [[ "$configured_bind" != *$'\n'* ]] ||
    fail "Protected existing config returned an ambiguous Gateway bind."
  [[ -z "$expected_configured_bind" || "$configured_bind" == "$expected_configured_bind" ]] ||
    fail "Protected existing config Gateway bind changed from its transaction."
  if [[ "$configured_bind" == "$runtime_bind" ]]; then
    [[ "$override_authorized" == "0" ]] ||
      fail "Protected-config Gateway bind override requires an actual bind mismatch."
  else
    [[ "$override_authorized" == "1" ]] ||
      fail "Protected existing config Gateway bind differs from the Docker runtime bind."
  fi
  PROTECTED_CONFIG_GATEWAY_BIND="$configured_bind"
  VERIFIER_CONFIGURED_GATEWAY_BIND="$configured_bind"
  VERIFIER_RUNTIME_GATEWAY_BIND="$runtime_bind"
  VERIFIER_BIND_OVERRIDE_AUTHORIZED="$override_authorized"
  assert_protected_config_immutable \
    "Protected OpenClaw config after semantic validation" \
    "$config_dev" "$config_ino" "$config_digest" "$config_mode" \
    "$config_parent_dev" "$config_parent_ino"
  echo "Validated existing read-only config and exact guarded verifier sandbox policy (config bind: $configured_bind; runtime bind: $runtime_bind)."
}

prepare_read_only_existing_config_contract() {
  capture_protected_config
  validate_read_only_existing_config
  assert_protected_config_immutable "Protected OpenClaw config before SSH path validation"
  [[ -d "$OPENCLAW_CONFIG_DIR/ssh" && ! -L "$OPENCLAW_CONFIG_DIR/ssh" ]] ||
    fail "OPENCLAW_SETUP_READ_ONLY_CONFIG requires an existing direct SSH directory."
  assert_protected_config_immutable "Protected OpenClaw config after SSH path validation"
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
READ_ONLY_CONFIG_NORMALIZED="$(
  printf '%s' "$RAW_READ_ONLY_CONFIG_SETTING" | tr '[:upper:]' '[:lower:]'
)"
case "$READ_ONLY_CONFIG_NORMALIZED" in
  1 | true | yes | on)
    READ_ONLY_CONFIG_ENABLED="1"
    OPENCLAW_SETUP_READ_ONLY_CONFIG="1"
    ;;
  "" | 0 | false | no | off)
    OPENCLAW_SETUP_READ_ONLY_CONFIG="0"
    ;;
  *)
    fail "OPENCLAW_SETUP_READ_ONLY_CONFIG must be a boolean value."
    ;;
esac
export OPENCLAW_SETUP_READ_ONLY_CONFIG
if [[ -n "$READ_ONLY_CONFIG_PROCESS_SETTING_PRESENT" &&
  -z "$READ_ONLY_CONFIG_ENABLED" &&
  -z "$BIND_OVERRIDE_PROCESS_SETTING_PRESENT" ]]; then
  # An explicit normal-mode invocation overrides a stale persisted authorization
  # without allowing an explicitly supplied contradictory override to disappear.
  RAW_BIND_OVERRIDE_SETTING="0"
  BIND_OVERRIDE_SETTING_PRESENT="1"
fi
BIND_OVERRIDE_NORMALIZED="$(
  printf '%s' "$RAW_BIND_OVERRIDE_SETTING" | tr '[:upper:]' '[:lower:]'
)"
case "$BIND_OVERRIDE_NORMALIZED" in
  1 | true | yes | on)
    BIND_OVERRIDE_ENABLED="1"
    OPENCLAW_SETUP_READ_ONLY_CONFIG_ALLOW_BIND_OVERRIDE="1"
    ;;
  "" | 0 | false | no | off)
    OPENCLAW_SETUP_READ_ONLY_CONFIG_ALLOW_BIND_OVERRIDE="0"
    ;;
  *)
    fail "OPENCLAW_SETUP_READ_ONLY_CONFIG_ALLOW_BIND_OVERRIDE must be a boolean value."
    ;;
esac
export OPENCLAW_SETUP_READ_ONLY_CONFIG_ALLOW_BIND_OVERRIDE

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
if [[ -n "$READ_ONLY_CONFIG_ENABLED" && -z "$VERIFIER_ENABLED" ]]; then
  fail "OPENCLAW_SETUP_READ_ONLY_CONFIG requires guarded verifier publication."
fi
if [[ -n "$BIND_OVERRIDE_ENABLED" && -z "$READ_ONLY_CONFIG_ENABLED" ]]; then
  [[ -n "$VERIFIER_ENABLED" &&
    ( -e "$VERIFIER_TRANSACTION_DIR" || -L "$VERIFIER_TRANSACTION_DIR" ) ]] ||
    fail "OPENCLAW_SETUP_READ_ONLY_CONFIG_ALLOW_BIND_OVERRIDE requires read-only guarded verifier publication."
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

if [[ -n "$READ_ONLY_CONFIG_ENABLED" ]]; then
  [[ -d "$OPENCLAW_WORKSPACE_DIR" ]] ||
    fail "OPENCLAW_SETUP_READ_ONLY_CONFIG requires an existing workspace."
else
  mkdir -p "$OPENCLAW_CONFIG_DIR"
  mkdir -p "$OPENCLAW_WORKSPACE_DIR"
  # Seed directory tree eagerly so bind mounts work even on Docker Desktop/Windows
  # where the container (even as root) cannot create new host subdirectories.
  mkdir -p "$OPENCLAW_CONFIG_DIR/identity"
  mkdir -p "$OPENCLAW_CONFIG_DIR/agents/main/agent"
  mkdir -p "$OPENCLAW_CONFIG_DIR/agents/main/sessions"
fi

export OPENCLAW_CONFIG_DIR
export OPENCLAW_WORKSPACE_DIR
export OPENCLAW_GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
export OPENCLAW_BRIDGE_PORT="${OPENCLAW_BRIDGE_PORT:-18790}"
export OPENCLAW_GATEWAY_BIND="${OPENCLAW_GATEWAY_BIND:-lan}"
if [[ -n "$BIND_OVERRIDE_ENABLED" && -z "$GATEWAY_BIND_SETTING_PRESENT" ]]; then
  [[ -n "$VERIFIER_ENABLED" &&
    ( -e "$VERIFIER_TRANSACTION_DIR" || -L "$VERIFIER_TRANSACTION_DIR" ) ]] ||
    fail "OPENCLAW_SETUP_READ_ONLY_CONFIG_ALLOW_BIND_OVERRIDE requires an explicit OPENCLAW_GATEWAY_BIND."
fi
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

VERIFIER_CONFIGURED_GATEWAY_BIND="$OPENCLAW_GATEWAY_BIND"
VERIFIER_RUNTIME_GATEWAY_BIND="$OPENCLAW_GATEWAY_BIND"
VERIFIER_BIND_OVERRIDE_AUTHORIZED="0"
if [[ -n "$READ_ONLY_CONFIG_ENABLED" ]]; then
  VERIFIER_CONFIG_POLICY="read-only"
  if [[ -n "$BIND_OVERRIDE_ENABLED" ]]; then
    VERIFIER_BIND_OVERRIDE_AUTHORIZED="1"
  fi
  if [[ -e "$VERIFIER_TRANSACTION_DIR" || -L "$VERIFIER_TRANSACTION_DIR" ]]; then
    # An interrupted Gateway recreate must be stopped from authenticated
    # journal state before a missing immutable flag can terminate recovery.
    DEFER_PROTECTED_CONFIG_VALIDATION="1"
  else
    prepare_read_only_existing_config_contract
  fi
fi
VERIFIER_OPERATION_CONFIG_POLICY="$VERIFIER_CONFIG_POLICY"

# The effective Docker socket GID is measured after the runtime image exists.
# Docker Desktop can present a different group inside Linux than on the host.
DOCKER_GID=""
export DOCKER_GID

if [[ -z "${OPENCLAW_GATEWAY_TOKEN:-}" ]]; then
  if [[ -n "$READ_ONLY_CONFIG_ENABLED" ]]; then
    if [[ -n "$DEFER_PROTECTED_CONFIG_VALIDATION" ]]; then
      EXISTING_CONFIG_TOKEN="$(read_env_gateway_token "$ROOT_DIR/.env" || true)"
      [[ -n "$EXISTING_CONFIG_TOKEN" ]] ||
        fail "Interrupted read-only verifier recovery requires its persisted Gateway token."
    else
      EXISTING_CONFIG_TOKEN="$(read_protected_config_gateway_token)"
    fi
  else
    EXISTING_CONFIG_TOKEN="$(read_config_gateway_token || true)"
  fi
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

oci_content_addressed_image_ref() {
  local kind="$1"
  local image_id="$2"
  local repository=""
  [[ "$image_id" =~ ^sha256:[a-f0-9]{64}$ ]] ||
    fail "Refusing to derive an image reference from a malformed image ID."
  case "$kind" in
    gateway-rollback) repository="openclaw-gateway-rollback-id" ;;
    verifier-candidate) repository="openclaw-verifier-candidate-id" ;;
    verifier-runtime) repository="openclaw-verifier-runtime-id" ;;
    *) fail "Refusing to derive an unrecognized content-addressed image reference." ;;
  esac
  printf '%s:%s' "$repository" "${image_id#sha256:}"
}

oci_pin_content_addressed_image_ref() {
  local kind="$1"
  local image_id="$2"
  local reference=""
  local actual=""
  reference="$(oci_content_addressed_image_ref "$kind" "$image_id")"
  actual="$(docker image inspect --format '{{.Id}}' "$reference" 2>/dev/null || true)"
  if [[ -n "$actual" ]]; then
    [[ "$actual" == "$image_id" ]] ||
      fail "Content-addressed Docker image reference no longer names its exact image."
  else
    docker image inspect "$image_id" >/dev/null 2>&1 ||
      fail "Exact Docker image is unavailable for content-addressed pinning."
    docker tag "$image_id" "$reference"
  fi
  [[ "$(docker image inspect --format '{{.Id}}' "$reference")" == "$image_id" ]] ||
    fail "Content-addressed Docker image reference did not retain its exact image."
  printf '%s' "$reference"
}

oci_require_content_addressed_image_ref() {
  local kind="$1"
  local image_id="$2"
  local reference=""
  reference="$(oci_content_addressed_image_ref "$kind" "$image_id")"
  [[ "$(docker image inspect --format '{{.Id}}' "$reference" 2>/dev/null || true)" == "$image_id" ]] ||
    fail "Required content-addressed Docker image reference is unavailable or changed."
  printf '%s' "$reference"
}

pin_current_gateway_image_for_verifier_update() {
  local gateway=""
  local image_id=""
  local reference=""
  [[ -n "$VERIFIER_ENABLED" ]] || return
  gateway="$(docker compose "${COMPOSE_ARGS[@]}" ps -a -q --no-trunc openclaw-gateway)"
  [[ "$gateway" != *$'\n'* &&
    ( -z "$gateway" || "$gateway" =~ ^[a-f0-9]{64}$ ) ]] ||
    fail "Existing Gateway resolved to an ambiguous container identity before build."
  [[ -n "$gateway" ]] || return 0
  image_id="$(docker inspect --format '{{.Image}}' "$gateway")"
  [[ "$image_id" =~ ^sha256:[a-f0-9]{64}$ ]] ||
    fail "Existing Gateway resolved to a malformed image ID before build."
  reference="$(oci_pin_content_addressed_image_ref gateway-rollback "$image_id")"
  echo "Pinned current Gateway rollback image as $reference."
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

oci_sync_normal_mode_env_handoff() {
  node - "$ENV_FILE" "$ROOT_DIR" "$(id -u)" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const [envPath, rootPath, expectedUid] = process.argv.slice(2);
if (
  !path.isAbsolute(envPath) ||
  !path.isAbsolute(rootPath) ||
  path.dirname(envPath) !== rootPath ||
  !/^[0-9]+$/.test(expectedUid)
) {
  throw new Error("Normal-mode environment durability target is malformed.");
}
const injectedFailure =
  process.env.OPENCLAW_DOCKER_SETUP_TEST === "1"
    ? (process.env.OPENCLAW_TEST_COMMITTED_ENV_FSYNC_FAILURE ?? "")
    : "";
if (!["", "file", "parent", "parent-unsupported"].includes(injectedFailure)) {
  throw new Error("Normal-mode environment fsync failure injection is malformed.");
}
const injectedReplacement =
  process.env.OPENCLAW_DOCKER_SETUP_TEST === "1"
    ? (process.env.OPENCLAW_TEST_COMMITTED_ENV_IDENTITY_REPLACEMENT ?? "")
    : "";
const argvAuditPath =
  process.env.OPENCLAW_DOCKER_SETUP_TEST === "1"
    ? (process.env.OPENCLAW_TEST_COMMITTED_ENV_ARGV_AUDIT ?? "")
    : "";
const readRoot = () => {
  const value = fs.lstatSync(rootPath, { bigint: true });
  if (
    !value.isDirectory() ||
    value.isSymbolicLink() ||
    fs.realpathSync(rootPath) !== rootPath
  ) {
    throw new Error("Normal-mode environment parent is unsafe.");
  }
  return value;
};
const readEnv = () => {
  const value = fs.lstatSync(envPath, { bigint: true });
  if (
    !value.isFile() ||
    value.isSymbolicLink() ||
    value.nlink !== 1n ||
    Number(value.mode & 0o7777n) !== 0o600 ||
    String(value.uid) !== expectedUid
  ) {
    throw new Error("Normal-mode environment file is unsafe.");
  }
  return value;
};
const sameIdentity = (left, right) =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.mode === right.mode &&
  left.nlink === right.nlink &&
  left.uid === right.uid;

const root = readRoot();
const env = readEnv();
let envFd;
try {
  envFd = fs.openSync(envPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const opened = fs.fstatSync(envFd, { bigint: true });
  if (!sameIdentity(opened, env)) {
    throw new Error("Normal-mode environment file changed before fsync.");
  }
  if (injectedFailure === "file") {
    throw new Error("Injected normal-mode environment file fsync failure.");
  }
  fs.fsyncSync(envFd);
} finally {
  if (envFd !== undefined) {
    fs.closeSync(envFd);
  }
}
if (injectedReplacement !== "") {
  if (!path.isAbsolute(injectedReplacement) || path.dirname(injectedReplacement) !== rootPath) {
    throw new Error("Normal-mode environment identity replacement is malformed.");
  }
  const replacement = fs.lstatSync(injectedReplacement, { bigint: true });
  if (
    !replacement.isFile() ||
    replacement.isSymbolicLink() ||
    replacement.nlink !== 1n ||
    Number(replacement.mode & 0o7777n) !== 0o600 ||
    String(replacement.uid) !== expectedUid
  ) {
    throw new Error("Normal-mode environment identity replacement is unsafe.");
  }
  fs.renameSync(injectedReplacement, envPath);
}
if (!sameIdentity(readEnv(), env) || !sameIdentity(readRoot(), root)) {
  throw new Error("Normal-mode environment identity changed after file fsync.");
}
let rootFd;
try {
  rootFd = fs.openSync(rootPath, fs.constants.O_RDONLY);
  const opened = fs.fstatSync(rootFd, { bigint: true });
  if (!sameIdentity(opened, root)) {
    throw new Error("Normal-mode environment parent changed before fsync.");
  }
  if (injectedFailure === "parent") {
    throw new Error("Injected normal-mode environment parent fsync failure.");
  }
  if (injectedFailure === "parent-unsupported") {
    throw new Error("Injected filesystem does not support directory fsync.");
  }
  // Directory fsync is supported by the declared macOS/Linux setup targets.
  // Any platform or filesystem rejection is intentionally fail-closed.
  fs.fsyncSync(rootFd);
} finally {
  if (rootFd !== undefined) {
    fs.closeSync(rootFd);
  }
}
if (!sameIdentity(readEnv(), env) || !sameIdentity(readRoot(), root)) {
  throw new Error("Normal-mode environment identity changed after parent fsync.");
}
if (argvAuditPath !== "") {
  if (!path.isAbsolute(argvAuditPath)) {
    throw new Error("Normal-mode environment argv audit path is malformed.");
  }
  const secretValues = Object.entries(process.env)
    .filter(
      ([key, value]) =>
        typeof value === "string" &&
        value.length > 0 &&
        /(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY)/u.test(key),
    )
    .map(([, value]) => value);
  const argumentsContainSecret = process.argv
    .slice(2)
    .some((argument) => secretValues.some((secret) => argument.includes(secret)));
  fs.writeFileSync(
    argvAuditPath,
    `${JSON.stringify({
      argumentCount: process.argv.slice(2).length,
      secretValueCount: secretValues.length,
      argumentsContainSecret,
    })}\n`,
    { flag: "wx", mode: 0o600 },
  );
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
  local default_value="${2:-}"
  local allow_default=""
  if [[ "$#" -eq 2 ]]; then
    allow_default="1"
  fi
  if node - "$VERIFIER_TRANSACTION_DIR" \
    "$VERIFIER_TRANSACTION_DIR_DEV" "$VERIFIER_TRANSACTION_DIR_INO" \
    "$(id -u)" "$key" "$allow_default" "$default_value" <<'NODE'
const fs = require("node:fs");

const [
  directory,
  expectedDev,
  expectedIno,
  expectedUid,
  wanted,
  allowDefault,
  defaultValue,
] = process.argv.slice(2);
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
  if (values.length === 0 && allowDefault === "1") {
    process.stdout.write(`${defaultValue}\n`);
  } else {
    if (values.length !== 1) {
      throw new Error("Verifier transaction journal key is ambiguous.");
    }
    process.stdout.write(`${values[0]}\n`);
  }
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
  "gateway-compose-project",
  "gateway-compose-service",
  "gateway-candidate-label",
  "gateway-create-binding",
  "old-image-id",
  "old-stable-image-id",
  "gateway-was-running",
  "env-backup-digest",
  "env-backup-mode",
  "env-backup-parent-dev",
  "env-backup-parent-ino",
  "transaction-format",
  "config-policy",
  "configured-gateway-bind",
  "runtime-gateway-bind",
  "bind-override-authorized",
  "config-backup-present",
  "config-backup-digest",
  "config-backup-mode",
  "config-backup-parent-dev",
  "config-backup-parent-ino",
  "config-dev",
  "config-ino",
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
const currentOnlyKeys = new Set([
  "transaction-format",
  "config-policy",
  "configured-gateway-bind",
  "runtime-gateway-bind",
  "bind-override-authorized",
  "config-dev",
  "config-ino",
  "gateway-compose-project",
  "gateway-compose-service",
  "gateway-candidate-label",
  "gateway-create-binding",
]);
const b48OnlyMissingKeys = new Set([
  "configured-gateway-bind",
  "runtime-gateway-bind",
  "bind-override-authorized",
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
  const missing = [...expectedKeys].filter((key) => !values.has(key));
  const exactlyMissing = (keys) =>
    missing.length === keys.size && missing.every((key) => keys.has(key));
  if (missing.length === 0) {
    return { kind: "complete", values, contractVersion: 4 };
  }
  if (exactlyMissing(b48OnlyMissingKeys)) {
    return { kind: "complete", values, contractVersion: 3 };
  }
  if (exactlyMissing(currentOnlyKeys)) {
    return { kind: "complete", values, contractVersion: 2 };
  }
  return { kind: "incomplete" };
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
  local contract_version=""
  if contract_version="$(
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
  "gateway-compose-project",
  "gateway-compose-service",
  "gateway-candidate-label",
  "gateway-create-binding",
  "old-image-id",
  "old-stable-image-id",
  "gateway-was-running",
  "env-backup-digest",
  "env-backup-mode",
  "env-backup-parent-dev",
  "env-backup-parent-ino",
  "transaction-format",
  "config-policy",
  "configured-gateway-bind",
  "runtime-gateway-bind",
  "bind-override-authorized",
  "config-backup-present",
  "config-backup-digest",
  "config-backup-mode",
  "config-backup-parent-dev",
  "config-backup-parent-ino",
  "config-dev",
  "config-ino",
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
const currentOnlyKeys = new Set([
  "transaction-format",
  "config-policy",
  "configured-gateway-bind",
  "runtime-gateway-bind",
  "bind-override-authorized",
  "config-dev",
  "config-ino",
  "gateway-compose-project",
  "gateway-compose-service",
  "gateway-candidate-label",
  "gateway-create-binding",
]);
const b48OnlyMissingKeys = new Set([
  "configured-gateway-bind",
  "runtime-gateway-bind",
  "bind-override-authorized",
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
const missing = [...expected].filter((key) => !seen.has(key));
const exactlyMissing = (keys) =>
  missing.length === keys.size && missing.every((key) => keys.has(key));
let contractVersion;
if (missing.length === 0) {
  contractVersion = 4;
} else if (exactlyMissing(b48OnlyMissingKeys)) {
  contractVersion = 3;
} else if (exactlyMissing(currentOnlyKeys)) {
  contractVersion = 2;
} else {
  throw new Error("Verifier transaction journal is incomplete.");
}
process.stdout.write(String(contractVersion));
NODE
  )"
  then
    :
  else
    fail "Verifier transaction journal shape validation failed."
  fi
  [[ "$contract_version" == "2" || "$contract_version" == "3" ||
    "$contract_version" == "4" ]] ||
    fail "Verifier transaction journal returned an unknown contract version."
  VERIFIER_JOURNAL_CONTRACT_VERSION="$contract_version"
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
    begun | candidate-built | candidate-verified | final-built | final-verified | tag-published | env-committed | socket-overlay-written | sandbox-configured | gateway-create-intent | gateway-started | gateway-ready | committed) ;;
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
  local transaction_format="${10}"
  local config_policy="${11}"
  local expected_operation_binding=""
  [[ "$transaction_id" =~ ^[a-f0-9]{32}$ ]] ||
    fail "Verifier journal contains a malformed transaction ID."
  [[ "$state_instance_digest" == "$VERIFIER_STATE_TOKEN_DIGEST" ]] ||
    fail "Verifier journal belongs to a different state instance."
  expected_operation_binding="$(
    oci_operation_binding "$transaction_id" "$transaction_format" "$config_policy"
  )"
  [[ "$operation_binding" == "$expected_operation_binding" ]] ||
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
  local transaction_format="${11}"
  local config_policy="${12}"
  local config_backup_present="${13}"
  local config_backup_digest="${14}"
  local config_backup_mode="${15}"
  local config_backup_parent_dev="${16}"
  local config_backup_parent_ino="${17}"
  local config_dev="${18}"
  local config_ino="${19}"
  local overlay_backup_present="${20}"
  local overlay_backup_digest="${21}"
  local overlay_backup_mode="${22}"
  local overlay_backup_parent_dev="${23}"
  local overlay_backup_parent_ino="${24}"
  local docker_socket_path="${25}"
  local gc_old_image="${26}"
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
  [[ "$transaction_format" == "legacy" || "$transaction_format" == "2" ]] ||
    fail "Verifier journal contains an unknown transaction format."
  [[ "$config_policy" == "write" || "$config_policy" == "read-only" ]] ||
    fail "Verifier journal contains an unknown config policy."
  [[ "$transaction_format" != "legacy" || "$config_policy" == "write" ]] ||
    fail "Legacy verifier journals cannot claim read-only config handling."
  [[ "$config_backup_present" == "0" || "$config_backup_present" == "1" ]] ||
    fail "Verifier journal contains a malformed config backup state."
  [[ "$config_policy" != "read-only" || "$config_backup_present" == "1" ]] ||
    fail "Read-only verifier recovery requires captured config metadata."
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
  if [[ "$config_policy" == "read-only" ]]; then
    [[ "$config_dev" =~ ^[0-9]+$ && "$config_ino" =~ ^[0-9]+$ ]] ||
      fail "Read-only verifier journal contains malformed config identity."
  else
    [[ -z "$config_dev" && -z "$config_ino" ]] ||
      fail "Config-writing verifier journal contains unexpected config identity."
  fi
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

oci_validate_config_transaction_artifact() {
  local config_policy="$1"
  local config_backup_present="$2"
  local config_backup_digest="$3"
  local backup_path="$VERIFIER_TRANSACTION_DIR/config.backup"
  [[ "$config_policy" == "write" || "$config_policy" == "read-only" ]] ||
    fail "Verifier config artifact policy is malformed."
  [[ "$config_backup_present" == "0" || "$config_backup_present" == "1" ]] ||
    fail "Verifier config artifact presence is malformed."
  if [[ "$config_policy" == "read-only" ]]; then
    [[ ! -e "$backup_path" && ! -L "$backup_path" ]] ||
      fail "Read-only verifier transaction contains a plaintext config backup."
    return
  fi
  if [[ "$config_backup_present" == "1" ]]; then
    [[ -f "$backup_path" && ! -L "$backup_path" ]] ||
      fail "Config-writing verifier recovery is missing its captured backup."
    oci_assert_owned_mode "$backup_path" 600
    [[ "$(oci_file_digest "$backup_path")" == "$config_backup_digest" ]] ||
      fail "Config-writing verifier recovery backup digest changed."
  else
    [[ ! -e "$backup_path" && ! -L "$backup_path" ]] ||
      fail "Config-writing verifier transaction has an unexpected config backup."
  fi
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
    gateway-create-intent)
      [[ -n "$candidate" && -n "$final" && -z "$new_gateway" ]] ||
        fail "Verifier Gateway-create intent has contradictory publication identity."
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
    printf 'gateway-compose-project=%s\n' "${VERIFIER_GATEWAY_COMPOSE_PROJECT:-}"
    printf 'gateway-compose-service=%s\n' "${VERIFIER_GATEWAY_COMPOSE_SERVICE:-}"
    printf 'gateway-candidate-label=%s\n' "${VERIFIER_GATEWAY_CANDIDATE_LABEL:-}"
    printf 'gateway-create-binding=%s\n' "${VERIFIER_GATEWAY_CREATE_BINDING:-}"
    printf 'old-image-id=%s\n' "${VERIFIER_OLD_IMAGE_ID:-}"
    printf 'old-stable-image-id=%s\n' "${VERIFIER_OLD_STABLE_IMAGE_ID:-}"
    printf 'gateway-was-running=%s\n' "${VERIFIER_GATEWAY_WAS_RUNNING:-}"
    printf 'env-backup-digest=%s\n' "${VERIFIER_ENV_BACKUP_DIGEST:-}"
    printf 'env-backup-mode=%s\n' "${VERIFIER_ENV_BACKUP_MODE:-}"
    printf 'env-backup-parent-dev=%s\n' "${VERIFIER_ENV_BACKUP_PARENT_DEV:-}"
    printf 'env-backup-parent-ino=%s\n' "${VERIFIER_ENV_BACKUP_PARENT_INO:-}"
    printf 'transaction-format=%s\n' "${VERIFIER_TRANSACTION_FORMAT:-}"
    printf 'config-policy=%s\n' "${VERIFIER_CONFIG_POLICY:-}"
    printf 'configured-gateway-bind=%s\n' "${VERIFIER_CONFIGURED_GATEWAY_BIND:-}"
    printf 'runtime-gateway-bind=%s\n' "${VERIFIER_RUNTIME_GATEWAY_BIND:-}"
    printf 'bind-override-authorized=%s\n' "${VERIFIER_BIND_OVERRIDE_AUTHORIZED:-}"
    printf 'config-backup-present=%s\n' "${VERIFIER_CONFIG_BACKUP_PRESENT:-0}"
    printf 'config-backup-digest=%s\n' "${VERIFIER_CONFIG_BACKUP_DIGEST:-}"
    printf 'config-backup-mode=%s\n' "${VERIFIER_CONFIG_BACKUP_MODE:-}"
    printf 'config-backup-parent-dev=%s\n' "${VERIFIER_CONFIG_BACKUP_PARENT_DEV:-}"
    printf 'config-backup-parent-ino=%s\n' "${VERIFIER_CONFIG_BACKUP_PARENT_INO:-}"
    printf 'config-dev=%s\n' "${VERIFIER_CONFIG_DEV:-}"
    printf 'config-ino=%s\n' "${VERIFIER_CONFIG_INO:-}"
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
  local transaction_format="${2:-${VERIFIER_OPERATION_FORMAT:-}}"
  local config_policy="${3:-${VERIFIER_OPERATION_CONFIG_POLICY:-}}"
  local configured_bind="${4:-${VERIFIER_OPERATION_CONFIGURED_GATEWAY_BIND:-}}"
  local runtime_bind="${5:-${VERIFIER_OPERATION_RUNTIME_GATEWAY_BIND:-}}"
  local override_authorized="${6:-${VERIFIER_OPERATION_BIND_OVERRIDE_AUTHORIZED:-}}"
  local contract_version="${7:-${VERIFIER_OPERATION_CONTRACT_VERSION:-}}"
  [[ "$VERIFIER_STATE_TOKEN_DIGEST" =~ ^[a-f0-9]{64}$ &&
    ( "$operation_id" == "recovery" || "$operation_id" == "cleanup" ||
      "$operation_id" =~ ^[a-f0-9]{32}$ ) ]] ||
    fail "Guarded verifier state operation binding input is malformed."
  if [[ "$contract_version" == "2" &&
    "$transaction_format" == "legacy" && "$config_policy" == "write" ]]; then
    node -e '
      const crypto = require("node:crypto");
      process.stdout.write(
        crypto.createHash("sha256").update(`${process.argv[1]}\0${process.argv[2]}`).digest("hex"),
      );
    ' "$VERIFIER_STATE_TOKEN_DIGEST" "$operation_id"
    return
  fi
  [[ "$transaction_format" == "2" &&
    ( "$config_policy" == "write" || "$config_policy" == "read-only" ) ]] ||
    fail "Guarded verifier transaction binding policy is malformed."
  if [[ "$contract_version" == "3" ]]; then
    node -e '
      const crypto = require("node:crypto");
      process.stdout.write(
        crypto
          .createHash("sha256")
          .update(process.argv.slice(1).join("\0"))
          .digest("hex"),
      );
    ' "$VERIFIER_STATE_TOKEN_DIGEST" "$operation_id" "$transaction_format" "$config_policy"
    return
  fi
  [[ "$contract_version" == "4" ]] ||
    fail "Guarded verifier state operation contract version is malformed."
  case "$configured_bind" in
    auto | custom | lan | loopback | tailnet) ;;
    *) fail "Guarded verifier configured Gateway bind is malformed." ;;
  esac
  case "$runtime_bind" in
    auto | custom | lan | loopback | tailnet) ;;
    *) fail "Guarded verifier runtime Gateway bind is malformed." ;;
  esac
  [[ "$override_authorized" == "0" || "$override_authorized" == "1" ]] ||
    fail "Guarded verifier bind override authorization is malformed."
  if [[ "$config_policy" == "write" || "$override_authorized" == "0" ]]; then
    [[ "$configured_bind" == "$runtime_bind" ]] ||
      fail "Guarded verifier non-override Gateway binds do not match."
  else
    [[ "$configured_bind" != "$runtime_bind" ]] ||
      fail "Guarded verifier bind override does not represent a mismatch."
  fi
  [[ "$config_policy" != "write" || "$override_authorized" == "0" ]] ||
    fail "Config-writing verifier transactions cannot authorize a bind override."
  node -e '
    const crypto = require("node:crypto");
    process.stdout.write(
      crypto
        .createHash("sha256")
        .update(
          process.argv.slice(1).join("\0"),
        )
        .digest("hex"),
    );
  ' \
    "$VERIFIER_STATE_TOKEN_DIGEST" "$operation_id" "$transaction_format" "$config_policy" \
    "$configured_bind" "$runtime_bind" "$override_authorized"
}

oci_gateway_create_binding() {
  local operation_binding="$1"
  local old_gateway="$2"
  local runtime_image="$3"
  local compose_project="$4"
  local compose_service="$5"
  local candidate_label="$6"
  local transaction_format="$7"
  local config_policy="$8"
  local configured_bind="$9"
  local runtime_bind="${10}"
  local override_authorized="${11}"
  local contract_version="${12}"
  [[ "$operation_binding" =~ ^[a-f0-9]{64}$ &&
    ( -z "$old_gateway" || "$old_gateway" =~ ^[a-f0-9]{64}$ ) &&
    "$runtime_image" =~ ^sha256:[a-f0-9]{64}$ &&
    "$compose_project" =~ ^[a-z0-9][a-z0-9_.-]*$ &&
    "$compose_service" == "openclaw-gateway" &&
    "$candidate_label" =~ ^[a-f0-9]{64}$ &&
    "$transaction_format" == "2" &&
    ( "$config_policy" == "write" || "$config_policy" == "read-only" ) &&
    ( "$contract_version" == "3" || "$contract_version" == "4" ) ]] ||
    fail "Guarded verifier Gateway-create binding input is malformed."
  if [[ "$contract_version" == "3" ]]; then
    node -e '
      const crypto = require("node:crypto");
      process.stdout.write(
        crypto
          .createHash("sha256")
          .update(process.argv.slice(1).join("\0"))
          .digest("hex"),
      );
    ' \
      "$operation_binding" "$old_gateway" "$runtime_image" \
      "$compose_project" "$compose_service" "$candidate_label" \
      "$transaction_format" "$config_policy"
    return
  fi
  [[
    ( "$configured_bind" == "auto" || "$configured_bind" == "custom" ||
      "$configured_bind" == "lan" || "$configured_bind" == "loopback" ||
      "$configured_bind" == "tailnet" ) &&
    ( "$runtime_bind" == "auto" || "$runtime_bind" == "custom" ||
      "$runtime_bind" == "lan" || "$runtime_bind" == "loopback" ||
      "$runtime_bind" == "tailnet" ) &&
    ( "$override_authorized" == "0" || "$override_authorized" == "1" ) ]] ||
    fail "Guarded verifier Gateway-create binding input is malformed."
  node -e '
    const crypto = require("node:crypto");
    process.stdout.write(
      crypto
        .createHash("sha256")
        .update(process.argv.slice(1).join("\0"))
        .digest("hex"),
    );
  ' \
    "$operation_binding" "$old_gateway" "$runtime_image" \
    "$compose_project" "$compose_service" "$candidate_label" \
    "$transaction_format" "$config_policy" "$configured_bind" "$runtime_bind" \
    "$override_authorized"
}

oci_gateway_candidate_label() {
  local transaction_id="$1"
  [[ "$transaction_id" =~ ^[a-f0-9]{32}$ ]] ||
    fail "Guarded verifier Gateway candidate transaction identity is malformed."
  # The active marker already binds this cryptographically random transaction ID.
  # Domain separation makes its derived Docker label transaction-specific.
  node -e '
    const crypto = require("node:crypto");
    process.stdout.write(
      crypto
        .createHash("sha256")
        .update(`openclaw-verifier-gateway-candidate\0${process.argv[1]}`)
        .digest("hex"),
    );
  ' "$transaction_id"
}

oci_compose_gateway_identity() {
  local candidate_label="$1"
  local config=""
  local identity=""
  shift
  [[ "$candidate_label" =~ ^[a-f0-9]{64}$ ]] ||
    fail "Guarded verifier Gateway candidate label is malformed."
  if config="$(docker compose "$@" config --format json)"; then
    :
  else
    fail "Guarded verifier could not resolve the Gateway Compose identity."
  fi
  identity="$(
    printf '%s' "$config" |
      node -e '
        const fs = require("node:fs");
        const expectedLabel = process.argv[1];
        const config = JSON.parse(fs.readFileSync(0, "utf8"));
        const project = config?.name;
        const service = config?.services?.["openclaw-gateway"];
        if (
          typeof project !== "string" ||
          !/^[a-z0-9][a-z0-9_.-]*$/.test(project) ||
          typeof service !== "object" ||
          service === null ||
          typeof service.labels !== "object" ||
          service.labels === null ||
          service.labels["ai.openclaw.verifier.gateway-candidate"] !== expectedLabel
        ) {
          throw new Error("Gateway Compose project, service, or candidate label is malformed.");
        }
        process.stdout.write(`${project}|openclaw-gateway`);
      ' "$candidate_label"
  )" || fail "Guarded verifier Gateway Compose identity is unsafe."
  [[ "$identity" != *$'\n'* ]] ||
    fail "Guarded verifier Gateway Compose identity is ambiguous."
  printf '%s' "$identity"
}

oci_phase_has_gateway_create_intent() {
  case "$1" in
    gateway-create-intent | gateway-started | gateway-ready | committed) return 0 ;;
    *) return 1 ;;
  esac
}

oci_validate_gateway_create_contract() {
  local phase="$1"
  local transaction_format="$2"
  local operation_binding="$3"
  local old_gateway="$4"
  local transaction_id="$5"
  local runtime_image="$6"
  local compose_project="$7"
  local compose_service="$8"
  local candidate_label="$9"
  local create_binding="${10}"
  local config_policy="${11}"
  local configured_bind="${12}"
  local runtime_bind="${13}"
  local override_authorized="${14}"
  local contract_version="${15}"
  local expected=""
  local expected_candidate_label=""
  if [[ "$contract_version" == "2" && "$transaction_format" == "legacy" ]]; then
    [[ -z "$compose_project" && -z "$compose_service" &&
      -z "$candidate_label" && -z "$create_binding" &&
      -z "$configured_bind" && -z "$runtime_bind" &&
      -z "$override_authorized" ]] ||
      fail "Legacy verifier journal contains unexpected Gateway-create identity."
    return
  fi
  expected_candidate_label="$(oci_gateway_candidate_label "$transaction_id")"
  [[ "$candidate_label" == "$expected_candidate_label" ]] ||
    fail "Verifier journal contains an invalid Gateway candidate label."
  if ! oci_phase_has_gateway_create_intent "$phase"; then
    [[ -z "$compose_project" && -z "$compose_service" && -z "$create_binding" ]] ||
      fail "Verifier journal contains premature Gateway-create identity."
    return
  fi
  expected="$(
    oci_gateway_create_binding \
      "$operation_binding" "$old_gateway" "$runtime_image" \
      "$compose_project" "$compose_service" "$candidate_label" \
      "$transaction_format" "$config_policy" "$configured_bind" "$runtime_bind" \
      "$override_authorized" "$contract_version"
  )"
  [[ "$create_binding" == "$expected" ]] ||
    fail "Verifier journal contains an invalid Gateway-create identity."
}

oci_resolve_gateway_service_container() {
  local compose_project="$1"
  local compose_service="$2"
  local resolved=""
  shift 2
  [[ "$compose_project" =~ ^[a-z0-9][a-z0-9_.-]*$ &&
    "$compose_service" == "openclaw-gateway" ]] ||
    fail "Verifier Gateway service lookup identity is malformed."
  if resolved="$(
    docker compose --project-name "$compose_project" \
      "$@" ps -a -q --no-trunc "$compose_service"
  )"; then
    :
  else
    fail "Verifier recovery could not resolve the exact Gateway service container."
  fi
  [[ "$resolved" != *$'\n'* &&
    ( -z "$resolved" || "$resolved" =~ ^[a-f0-9]{64}$ ) ]] ||
    {
      echo "ERROR: Verifier recovery found an ambiguous Gateway service container identity." >&2
      return 2
    }
  printf '%s' "$resolved"
}

oci_validate_gateway_container_identity() {
  local gateway_id="$1"
  local expected_image="$2"
  local compose_project="$3"
  local compose_service="$4"
  local expected_running="${5:-}"
  local expected_candidate_label="${6:-}"
  local labels_json=""
  local running=""
  [[ "$gateway_id" =~ ^[a-f0-9]{64}$ &&
    "$expected_image" =~ ^sha256:[a-f0-9]{64}$ &&
    "$compose_project" =~ ^[a-z0-9][a-z0-9_.-]*$ &&
    "$compose_service" == "openclaw-gateway" &&
    ( -z "$expected_running" || "$expected_running" == "true" ||
      "$expected_running" == "false" ) &&
    ( -z "$expected_candidate_label" ||
      "$expected_candidate_label" =~ ^[a-f0-9]{64}$ ) ]] ||
    fail "Verifier Gateway container validation input is malformed."
  if labels_json="$(
    docker inspect --format '{{json .Config.Labels}}' "$gateway_id"
  )"; then
    :
  else
    fail "Verifier Gateway container disappeared before identity validation."
  fi
  if node - \
    "$compose_project" "$compose_service" "$expected_candidate_label" "$labels_json" <<'NODE'
const [expectedProject, expectedService, expectedCandidate, raw] = process.argv.slice(2);
let cursor = 0;

function skipWhitespace() {
  while (cursor < raw.length && /[\t\n\r ]/.test(raw[cursor])) {
    cursor += 1;
  }
}

function readString() {
  if (raw[cursor] !== '"') {
    throw new Error("Expected a JSON string.");
  }
  const start = cursor;
  cursor += 1;
  let escaped = false;
  while (cursor < raw.length) {
    const value = raw[cursor];
    cursor += 1;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (value === "\\") {
      escaped = true;
      continue;
    }
    if (value === '"') {
      return JSON.parse(raw.slice(start, cursor));
    }
  }
  throw new Error("Unterminated JSON string.");
}

if (raw.length === 0 || raw !== raw.trim() || raw[cursor] !== "{") {
  throw new Error("Labels inspection must be one exact JSON object.");
}
cursor += 1;
skipWhitespace();
const labels = new Map();
if (raw[cursor] !== "}") {
  while (true) {
    const key = readString();
    if (labels.has(key)) {
      throw new Error("Labels inspection contains a duplicate key.");
    }
    skipWhitespace();
    if (raw[cursor] !== ":") {
      throw new Error("Labels inspection is missing a property separator.");
    }
    cursor += 1;
    skipWhitespace();
    const value = readString();
    labels.set(key, value);
    skipWhitespace();
    if (raw[cursor] === "}") {
      break;
    }
    if (raw[cursor] !== ",") {
      throw new Error("Labels inspection is not a flat string map.");
    }
    cursor += 1;
    skipWhitespace();
  }
}
cursor += 1;
if (cursor !== raw.length) {
  throw new Error("Labels inspection contains ambiguous trailing bytes.");
}
if (
  labels.get("com.docker.compose.project") !== expectedProject ||
  labels.get("com.docker.compose.service") !== expectedService ||
  labels.get("com.docker.compose.oneoff") !== "False" ||
  (expectedCandidate !== "" &&
    labels.get("ai.openclaw.verifier.gateway-candidate") !== expectedCandidate)
) {
  throw new Error("Labels inspection does not match the authenticated identity.");
}
NODE
  then
    :
  else
    fail "Verifier Gateway container does not match the exact Compose service identity."
  fi
  [[ "$(docker inspect --format '{{.Image}}' "$gateway_id")" == "$expected_image" ]] ||
    fail "Verifier Gateway container does not match the exact runtime image."
  running="$(docker inspect --format '{{.State.Running}}' "$gateway_id")"
  [[ "$running" == "true" || "$running" == "false" ]] ||
    fail "Verifier Gateway container returned malformed running state."
  [[ -z "$expected_running" || "$running" == "$expected_running" ]] ||
    fail "Verifier Gateway container running state is not the authenticated expectation."
  printf '%s' "$running"
}

oci_stop_authenticated_gateway_candidate() {
  local phase="$1"
  local transaction_format="$2"
  local old_gateway="$3"
  local old_gateway_image="$4"
  local runtime_image="$5"
  local new_gateway="$6"
  local compose_project="$7"
  local compose_service="$8"
  local candidate_label="$9"
  local resolved=""
  local running=""
  shift 9
  if [[ "$transaction_format" != "2" ]] ||
    ! oci_phase_has_gateway_create_intent "$phase"; then
    return
  fi
  if [[ -n "$new_gateway" ]]; then
    running="$(
      oci_validate_gateway_container_identity \
        "$new_gateway" "$runtime_image" "$compose_project" "$compose_service" \
        "" "$candidate_label"
    )"
    if [[ "$running" == "true" ]]; then
      docker stop "$new_gateway" >/dev/null
    fi
    oci_validate_gateway_container_identity \
      "$new_gateway" "$runtime_image" "$compose_project" "$compose_service" \
      "false" "$candidate_label" >/dev/null
    if resolved="$(
      oci_resolve_gateway_service_container "$compose_project" "$compose_service" "$@"
    )"; then
      :
    else
      return $?
    fi
    [[ "$resolved" == "$new_gateway" ]] ||
      fail "Verifier recovery found a different container under the Gateway service identity."
    printf '%s' "$new_gateway"
    return
  fi
  if resolved="$(
    oci_resolve_gateway_service_container "$compose_project" "$compose_service" "$@"
  )"; then
    :
  else
    return $?
  fi
  if [[ -z "$resolved" ]]; then
    [[ "$phase" == "gateway-create-intent" && -z "$new_gateway" ]] ||
      fail "Verifier recovery cannot resolve its journaled Gateway container."
    return
  fi
  if [[ "$resolved" == "$old_gateway" ]]; then
    [[ -z "$new_gateway" && "$old_gateway_image" =~ ^sha256:[a-f0-9]{64}$ ]] ||
      fail "Verifier recovery found contradictory prior Gateway identity."
    oci_validate_gateway_container_identity \
      "$resolved" "$old_gateway_image" "$compose_project" "$compose_service" >/dev/null
    printf '%s' "$resolved"
    return
  fi
  running="$(
    oci_validate_gateway_container_identity \
      "$resolved" "$runtime_image" "$compose_project" "$compose_service" \
      "" "$candidate_label"
  )"
  if [[ "$running" == "true" ]]; then
    docker stop "$resolved" >/dev/null
  fi
  oci_validate_gateway_container_identity \
    "$resolved" "$runtime_image" "$compose_project" "$compose_service" \
    "false" "$candidate_label" >/dev/null
  printf '%s' "$resolved"
}

oci_load_transaction_contract() {
  local contract_version="$VERIFIER_JOURNAL_CONTRACT_VERSION"
  local transaction_format=""
  local config_policy=""
  local configured_bind=""
  local runtime_bind=""
  local override_authorized=""
  local transaction_id=""
  local operation_binding=""
  local expected_operation_binding=""
  transaction_format="$(oci_read_journal transaction-format legacy)"
  config_policy="$(oci_read_journal config-policy write)"
  transaction_id="$(oci_read_journal transaction-id)"
  operation_binding="$(oci_read_journal operation-binding)"
  configured_bind="$(oci_read_journal configured-gateway-bind '')"
  runtime_bind="$(oci_read_journal runtime-gateway-bind '')"
  override_authorized="$(oci_read_journal bind-override-authorized '')"
  [[ "$contract_version" == "2" || "$contract_version" == "3" ||
    "$contract_version" == "4" ]] ||
    fail "Verifier journal contract version is unavailable."
  [[ "$transaction_format" == "legacy" || "$transaction_format" == "2" ]] ||
    fail "Verifier journal contains an unknown transaction format."
  [[ "$config_policy" == "write" || "$config_policy" == "read-only" ]] ||
    fail "Verifier journal contains an unknown config policy."
  [[ "$transaction_format" != "legacy" || "$config_policy" == "write" ]] ||
    fail "Legacy verifier journals cannot claim read-only config handling."
  if [[ "$contract_version" == "2" ]]; then
    [[ "$transaction_format" == "legacy" && "$config_policy" == "write" ]] ||
      fail "Legacy verifier journal has current transaction policy fields."
    [[ -z "$configured_bind" && -z "$runtime_bind" && -z "$override_authorized" ]] ||
      fail "Legacy verifier journal contains unexpected Gateway bind authorization."
  elif [[ "$contract_version" == "3" ]]; then
    [[ "$transaction_format" == "2" &&
      -z "$configured_bind" && -z "$runtime_bind" && -z "$override_authorized" ]] ||
      fail "b48 verifier journal does not match its exact no-override shape."
    [[ "$VERIFIER_OPERATION_CONTRACT_VERSION" == "3" ]] ||
      fail "b48 verifier journal requires its authenticated version 3 active marker."
    configured_bind="$OPENCLAW_GATEWAY_BIND"
    runtime_bind="$OPENCLAW_GATEWAY_BIND"
    override_authorized="0"
  else
    [[ "$transaction_format" == "2" ]] ||
      fail "Current verifier journal must use transaction format 2."
  fi
  if [[ -n "$VERIFIER_OPERATION_CONTRACT_VERSION" &&
    "$VERIFIER_OPERATION_CONTRACT_VERSION" != "$contract_version" ]]; then
    fail "Verifier journal version conflicts with its active-state marker."
  fi
  if [[ -n "$VERIFIER_OPERATION_FORMAT" &&
    ( "$VERIFIER_OPERATION_FORMAT" != "$transaction_format" ||
      "$VERIFIER_OPERATION_CONFIG_POLICY" != "$config_policy" ||
      ( "$contract_version" == "4" &&
        ( "$VERIFIER_OPERATION_CONFIGURED_GATEWAY_BIND" != "$configured_bind" ||
          "$VERIFIER_OPERATION_RUNTIME_GATEWAY_BIND" != "$runtime_bind" ||
          "$VERIFIER_OPERATION_BIND_OVERRIDE_AUTHORIZED" != "$override_authorized" ) ) ) ]]; then
    fail "Verifier journal policy conflicts with its active-state marker."
  fi
  expected_operation_binding="$(
    oci_operation_binding \
      "$transaction_id" "$transaction_format" "$config_policy" \
      "$configured_bind" "$runtime_bind" "$override_authorized" "$contract_version"
  )"
  [[ "$transaction_id" =~ ^[a-f0-9]{32}$ &&
    "$operation_binding" == "$expected_operation_binding" ]] ||
    fail "Verifier journal policy is not bound to its state operation."
  VERIFIER_OPERATION_CONTRACT_VERSION="$contract_version"
  VERIFIER_OPERATION_FORMAT="$transaction_format"
  VERIFIER_OPERATION_CONFIG_POLICY="$config_policy"
  VERIFIER_OPERATION_CONFIGURED_GATEWAY_BIND="$configured_bind"
  VERIFIER_OPERATION_RUNTIME_GATEWAY_BIND="$runtime_bind"
  VERIFIER_OPERATION_BIND_OVERRIDE_AUTHORIZED="$override_authorized"
  printf '%s|%s|%s|%s|%s|%s' \
    "$contract_version" "$transaction_format" "$config_policy" \
    "$configured_bind" "$runtime_bind" "$override_authorized"
}

oci_validate_transaction_live_policy() {
  local contract_version="${1:-$VERIFIER_OPERATION_CONTRACT_VERSION}"
  local runtime_bind="${2:-$VERIFIER_OPERATION_RUNTIME_GATEWAY_BIND}"
  local override_authorized="${3:-$VERIFIER_OPERATION_BIND_OVERRIDE_AUTHORIZED}"
  if [[ "$contract_version" == "2" ]]; then
    return
  fi
  if [[ "$contract_version" == "3" ]]; then
    case "$OPENCLAW_GATEWAY_BIND" in
      auto | custom | lan | loopback | tailnet) ;;
      *) fail "Current Docker setup Gateway bind is not supported for b48 recovery." ;;
    esac
    [[ -z "$BIND_OVERRIDE_ENABLED" ]] ||
      fail "b48 verifier recovery cannot adopt a bind-override authorization."
    return
  fi
  [[ "$contract_version" == "4" ]] ||
    fail "Verifier transaction live-policy contract version is unavailable."
  [[ "$runtime_bind" == "$OPENCLAW_GATEWAY_BIND" ]] ||
    fail "Verifier journal runtime bind conflicts with the current Docker setup bind."
  if [[ "$override_authorized" == "1" ]]; then
    [[ -n "$READ_ONLY_CONFIG_ENABLED" &&
      -n "$BIND_OVERRIDE_ENABLED" &&
      -n "$BIND_OVERRIDE_SETTING_PRESENT" &&
      -n "$GATEWAY_BIND_SETTING_PRESENT" ]] ||
      fail "Verifier journal bind override is no longer authorized by current setup policy."
  else
    [[ -z "$BIND_OVERRIDE_ENABLED" ]] ||
      fail "Verifier journal bind override conflicts with current operator authorization."
  fi
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
  VERIFIER_OPERATION_CONTRACT_VERSION=""
  VERIFIER_OPERATION_FORMAT=""
  VERIFIER_OPERATION_CONFIG_POLICY=""
  VERIFIER_OPERATION_CONFIGURED_GATEWAY_BIND=""
  VERIFIER_OPERATION_RUNTIME_GATEWAY_BIND=""
  VERIFIER_OPERATION_BIND_OVERRIDE_AUTHORIZED=""
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
let markerContractVersion = "";
let markerOperationFormat = "";
let markerConfigPolicy = "";
let markerConfiguredGatewayBind = "";
let markerRuntimeGatewayBind = "";
let markerBindOverrideAuthorized = "";
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
  const legacyBinding =
    marker?.contractVersion === 2 &&
    marker.operationBinding ===
      crypto
        .createHash("sha256")
        .update(`${marker.stateTokenDigest}\0${marker.operationId}`)
        .digest("hex") &&
    Object.keys(marker).join(",") ===
      "contractVersion,markerState,statePath,stateDev,stateIno,parentDev,parentIno,stateTokenDigest,operationId,operationBinding";
  const supportedBinds = new Set(["auto", "custom", "lan", "loopback", "tailnet"]);
  const b48Binding =
    marker?.contractVersion === 3 &&
    marker.transactionFormat === "2" &&
    (marker.configPolicy === "write" || marker.configPolicy === "read-only") &&
    marker.operationBinding ===
      crypto
        .createHash("sha256")
        .update(
          [
            marker.stateTokenDigest,
            marker.operationId,
            marker.transactionFormat,
            marker.configPolicy,
          ].join("\0"),
        )
        .digest("hex") &&
    Object.keys(marker).join(",") ===
      "contractVersion,markerState,statePath,stateDev,stateIno,parentDev,parentIno,stateTokenDigest,transactionFormat,configPolicy,operationId,operationBinding";
  const currentBinding =
    marker?.contractVersion === 4 &&
    marker.transactionFormat === "2" &&
    (marker.configPolicy === "write" || marker.configPolicy === "read-only") &&
    supportedBinds.has(marker.configuredGatewayBind) &&
    supportedBinds.has(marker.runtimeGatewayBind) &&
    (marker.bindOverrideAuthorized === "0" || marker.bindOverrideAuthorized === "1") &&
    (marker.bindOverrideAuthorized === "1"
      ? marker.configPolicy === "read-only" &&
        marker.configuredGatewayBind !== marker.runtimeGatewayBind
      : marker.configuredGatewayBind === marker.runtimeGatewayBind) &&
    marker.operationBinding ===
      crypto
        .createHash("sha256")
        .update(
          [
            marker.stateTokenDigest,
            marker.operationId,
            marker.transactionFormat,
            marker.configPolicy,
            marker.configuredGatewayBind,
            marker.runtimeGatewayBind,
            marker.bindOverrideAuthorized,
          ].join("\0"),
        )
        .digest("hex") &&
    Object.keys(marker).join(",") ===
      "contractVersion,markerState,statePath,stateDev,stateIno,parentDev,parentIno,stateTokenDigest,transactionFormat,configPolicy,configuredGatewayBind,runtimeGatewayBind,bindOverrideAuthorized,operationId,operationBinding";
  if (
    (!legacyBinding && !b48Binding && !currentBinding) ||
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
    markerRaw !== `${JSON.stringify(marker)}\n` ||
    (marker.contractVersion !== 2 &&
      marker.contractVersion !== 3 &&
      marker.contractVersion !== 4)
  ) {
    throw new Error("Guarded verifier active-state marker is malformed.");
  }
  markerTokenDigest = marker.stateTokenDigest;
  markerPhase = marker.markerState;
  markerContractVersion = String(marker.contractVersion);
  markerOperationFormat = marker.contractVersion === 2 ? "legacy" : marker.transactionFormat;
  markerConfigPolicy = marker.contractVersion === 2 ? "write" : marker.configPolicy;
  markerConfiguredGatewayBind =
    marker.contractVersion === 4 ? marker.configuredGatewayBind : "";
  markerRuntimeGatewayBind = marker.contractVersion === 4 ? marker.runtimeGatewayBind : "";
  markerBindOverrideAuthorized =
    marker.contractVersion === 4 ? marker.bindOverrideAuthorized : "";
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
  [
    parent.dev,
    parent.ino,
    markerName,
    markerTokenDigest,
    markerPhase,
    markerContractVersion,
    markerOperationFormat,
    markerConfigPolicy,
    markerConfiguredGatewayBind,
    markerRuntimeGatewayBind,
    markerBindOverrideAuthorized,
  ].join("|"),
);
NODE
  )" || fail "Guarded verifier active-state marker contract is unsafe."
  IFS='|' read -r \
    VERIFIER_STATE_PARENT_DEV VERIFIER_STATE_PARENT_INO \
    VERIFIER_STATE_MARKER_NAME VERIFIER_STATE_TOKEN_DIGEST \
    VERIFIER_STATE_MARKER_PHASE VERIFIER_OPERATION_CONTRACT_VERSION \
    VERIFIER_OPERATION_FORMAT \
    VERIFIER_OPERATION_CONFIG_POLICY \
    VERIFIER_OPERATION_CONFIGURED_GATEWAY_BIND \
    VERIFIER_OPERATION_RUNTIME_GATEWAY_BIND \
    VERIFIER_OPERATION_BIND_OVERRIDE_AUTHORIZED <<<"$identity"
  [[ "$VERIFIER_STATE_PARENT_DEV" =~ ^[0-9]+$ &&
    "$VERIFIER_STATE_PARENT_INO" =~ ^[0-9]+$ &&
    "$VERIFIER_STATE_MARKER_NAME" =~ ^\.openclaw-verifier-active-[a-f0-9]{64}$ &&
    ( -z "$VERIFIER_STATE_TOKEN_DIGEST" ||
      "$VERIFIER_STATE_TOKEN_DIGEST" =~ ^[a-f0-9]{64}$ ) &&
    ( -z "$VERIFIER_STATE_MARKER_PHASE" ||
      "$VERIFIER_STATE_MARKER_PHASE" == "active" ||
      "$VERIFIER_STATE_MARKER_PHASE" == "cleanup" ) &&
    ( -z "$VERIFIER_OPERATION_CONTRACT_VERSION" ||
      "$VERIFIER_OPERATION_CONTRACT_VERSION" == "2" ||
      "$VERIFIER_OPERATION_CONTRACT_VERSION" == "3" ||
      "$VERIFIER_OPERATION_CONTRACT_VERSION" == "4" ) &&
    ( -z "$VERIFIER_OPERATION_FORMAT" ||
      "$VERIFIER_OPERATION_FORMAT" == "legacy" ||
      "$VERIFIER_OPERATION_FORMAT" == "2" ) &&
    ( -z "$VERIFIER_OPERATION_CONFIG_POLICY" ||
      "$VERIFIER_OPERATION_CONFIG_POLICY" == "write" ||
      "$VERIFIER_OPERATION_CONFIG_POLICY" == "read-only" ) &&
    ( -z "$VERIFIER_OPERATION_CONFIGURED_GATEWAY_BIND" ||
      "$VERIFIER_OPERATION_CONFIGURED_GATEWAY_BIND" == "auto" ||
      "$VERIFIER_OPERATION_CONFIGURED_GATEWAY_BIND" == "custom" ||
      "$VERIFIER_OPERATION_CONFIGURED_GATEWAY_BIND" == "lan" ||
      "$VERIFIER_OPERATION_CONFIGURED_GATEWAY_BIND" == "loopback" ||
      "$VERIFIER_OPERATION_CONFIGURED_GATEWAY_BIND" == "tailnet" ) &&
    ( -z "$VERIFIER_OPERATION_RUNTIME_GATEWAY_BIND" ||
      "$VERIFIER_OPERATION_RUNTIME_GATEWAY_BIND" == "auto" ||
      "$VERIFIER_OPERATION_RUNTIME_GATEWAY_BIND" == "custom" ||
      "$VERIFIER_OPERATION_RUNTIME_GATEWAY_BIND" == "lan" ||
      "$VERIFIER_OPERATION_RUNTIME_GATEWAY_BIND" == "loopback" ||
      "$VERIFIER_OPERATION_RUNTIME_GATEWAY_BIND" == "tailnet" ) &&
    ( -z "$VERIFIER_OPERATION_BIND_OVERRIDE_AUTHORIZED" ||
      "$VERIFIER_OPERATION_BIND_OVERRIDE_AUTHORIZED" == "0" ||
      "$VERIFIER_OPERATION_BIND_OVERRIDE_AUTHORIZED" == "1" ) ]] ||
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
    "$VERIFIER_STATE_TOKEN_DIGEST" "$operation_id" "$operation_binding" \
    "$VERIFIER_OPERATION_CONTRACT_VERSION" \
    "$VERIFIER_OPERATION_FORMAT" "$VERIFIER_OPERATION_CONFIG_POLICY" \
    "$VERIFIER_OPERATION_CONFIGURED_GATEWAY_BIND" \
    "$VERIFIER_OPERATION_RUNTIME_GATEWAY_BIND" \
    "$VERIFIER_OPERATION_BIND_OVERRIDE_AUTHORIZED" <<'NODE'
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
  contractVersion,
  transactionFormat,
  configPolicy,
  configuredGatewayBind,
  runtimeGatewayBind,
  bindOverrideAuthorized,
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
const supportedBinds = new Set(["auto", "custom", "lan", "loopback", "tailnet"]);
if (
  !(
    (contractVersion === "2" &&
      transactionFormat === "legacy" &&
      configPolicy === "write") ||
    (contractVersion === "3" &&
      transactionFormat === "2" &&
      (configPolicy === "write" || configPolicy === "read-only")) ||
    (contractVersion === "4" &&
      transactionFormat === "2" &&
      (configPolicy === "write" || configPolicy === "read-only") &&
      supportedBinds.has(configuredGatewayBind) &&
      supportedBinds.has(runtimeGatewayBind) &&
      (bindOverrideAuthorized === "0" || bindOverrideAuthorized === "1") &&
      (bindOverrideAuthorized === "1"
        ? configPolicy === "read-only" && configuredGatewayBind !== runtimeGatewayBind
        : configuredGatewayBind === runtimeGatewayBind))
  )
) {
  throw new Error("Guarded verifier active-state marker policy is malformed.");
}
const expected = {
  contractVersion: Number(contractVersion),
  markerState: "active",
  statePath,
  stateDev,
  stateIno,
  parentDev: expectedParentDev,
  parentIno: expectedParentIno,
  stateTokenDigest,
  ...(contractVersion === "2"
    ? {}
    : {
        transactionFormat,
        configPolicy,
        ...(contractVersion === "3"
          ? {}
          : {
              configuredGatewayBind,
              runtimeGatewayBind,
              bindOverrideAuthorized,
            }),
      }),
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
  const existingFormat =
    existing.contractVersion === 2 ? "legacy" : existing.transactionFormat;
  const existingPolicy = existing.contractVersion === 2 ? "write" : existing.configPolicy;
  const existingConfiguredBind =
    existing.contractVersion === 4 ? existing.configuredGatewayBind : "";
  const existingRuntimeBind =
    existing.contractVersion === 4 ? existing.runtimeGatewayBind : "";
  const existingOverride =
    existing.contractVersion === 4 ? existing.bindOverrideAuthorized : "";
  const existingBinding =
    existing.contractVersion === 2
      ? crypto
          .createHash("sha256")
          .update(`${stateTokenDigest}\0${existing.operationId}`)
          .digest("hex")
      : existing.contractVersion === 3
        ? crypto
            .createHash("sha256")
            .update(
              [
                stateTokenDigest,
                existing.operationId,
                existingFormat,
                existingPolicy,
              ].join("\0"),
            )
            .digest("hex")
        : crypto
          .createHash("sha256")
          .update(
            [
              stateTokenDigest,
              existing.operationId,
              existingFormat,
              existingPolicy,
              existingConfiguredBind,
              existingRuntimeBind,
              existingOverride,
            ].join("\0"),
          )
          .digest("hex");
  const expectedKeys =
    existing.contractVersion === 2
      ? "contractVersion,markerState,operationBinding,operationId,parentDev,parentIno,stateDev,stateIno,statePath,stateTokenDigest"
      : existing.contractVersion === 3
        ? "configPolicy,contractVersion,markerState,operationBinding,operationId,parentDev,parentIno,stateDev,stateIno,statePath,stateTokenDigest,transactionFormat"
        : "bindOverrideAuthorized,configPolicy,configuredGatewayBind,contractVersion,markerState,operationBinding,operationId,parentDev,parentIno,runtimeGatewayBind,stateDev,stateIno,statePath,stateTokenDigest,transactionFormat";
  if (
    (existing.contractVersion !== 2 &&
      existing.contractVersion !== 3 &&
      existing.contractVersion !== 4) ||
    String(existing.contractVersion) !== contractVersion ||
    existingFormat !== transactionFormat ||
    existingPolicy !== configPolicy ||
    (existing.contractVersion === 4 &&
      (existingConfiguredBind !== configuredGatewayBind ||
        existingRuntimeBind !== runtimeGatewayBind ||
        existingOverride !== bindOverrideAuthorized)) ||
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
    existing.operationBinding !== existingBinding ||
    Object.keys(existing).sort().join(",") !== expectedKeys
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
const markerFormat = marker?.contractVersion === 2 ? "legacy" : marker?.transactionFormat;
const markerPolicy = marker?.contractVersion === 2 ? "write" : marker?.configPolicy;
const markerConfiguredBind =
  marker?.contractVersion === 4 ? marker?.configuredGatewayBind : "";
const markerRuntimeBind = marker?.contractVersion === 4 ? marker?.runtimeGatewayBind : "";
const markerOverride = marker?.contractVersion === 4 ? marker?.bindOverrideAuthorized : "";
const markerBinding =
  marker?.contractVersion === 2
    ? crypto
        .createHash("sha256")
        .update(`${stateTokenDigest}\0${marker.operationId}`)
        .digest("hex")
    : marker?.contractVersion === 3
      ? crypto
          .createHash("sha256")
          .update(
            [stateTokenDigest, marker.operationId, markerFormat, markerPolicy].join("\0"),
          )
          .digest("hex")
      : crypto
        .createHash("sha256")
        .update(
          [
            stateTokenDigest,
            marker.operationId,
            markerFormat,
            markerPolicy,
            markerConfiguredBind,
            markerRuntimeBind,
            markerOverride,
          ].join("\0"),
        )
        .digest("hex");
const expectedKeys =
  marker?.contractVersion === 2
    ? "contractVersion,markerState,statePath,stateDev,stateIno,parentDev,parentIno,stateTokenDigest,operationId,operationBinding"
    : marker?.contractVersion === 3
      ? "contractVersion,markerState,statePath,stateDev,stateIno,parentDev,parentIno,stateTokenDigest,transactionFormat,configPolicy,operationId,operationBinding"
      : "contractVersion,markerState,statePath,stateDev,stateIno,parentDev,parentIno,stateTokenDigest,transactionFormat,configPolicy,configuredGatewayBind,runtimeGatewayBind,bindOverrideAuthorized,operationId,operationBinding";
const supportedBinds = new Set(["auto", "custom", "lan", "loopback", "tailnet"]);
if (
  (marker?.contractVersion !== 2 &&
    marker?.contractVersion !== 3 &&
    marker?.contractVersion !== 4) ||
  (marker?.contractVersion === 3 &&
    (markerFormat !== "2" ||
      (markerPolicy !== "write" && markerPolicy !== "read-only"))) ||
  (marker?.contractVersion === 4 &&
    (!supportedBinds.has(markerConfiguredBind) ||
      !supportedBinds.has(markerRuntimeBind) ||
      (markerOverride !== "0" && markerOverride !== "1") ||
      (markerOverride === "1"
        ? markerPolicy !== "read-only" || markerConfiguredBind === markerRuntimeBind
        : markerConfiguredBind !== markerRuntimeBind))) ||
  (marker.markerState !== "active" && marker.markerState !== "cleanup") ||
  marker.statePath !== statePath ||
  marker.stateDev !== stateDev ||
  marker.stateIno !== stateIno ||
  marker.parentDev !== expectedParentDev ||
  marker.parentIno !== expectedParentIno ||
  marker.stateTokenDigest !== stateTokenDigest ||
  typeof marker.operationId !== "string" ||
  !/^(?:recovery|cleanup|[a-f0-9]{32})$/.test(marker.operationId) ||
  marker.operationBinding !== markerBinding ||
  raw !== `${JSON.stringify(marker)}\n` ||
  Object.keys(marker).join(",") !== expectedKeys
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
const markerFormat = marker?.contractVersion === 2 ? "legacy" : marker?.transactionFormat;
const markerPolicy = marker?.contractVersion === 2 ? "write" : marker?.configPolicy;
const markerConfiguredBind =
  marker?.contractVersion === 4 ? marker?.configuredGatewayBind : "";
const markerRuntimeBind = marker?.contractVersion === 4 ? marker?.runtimeGatewayBind : "";
const markerOverride = marker?.contractVersion === 4 ? marker?.bindOverrideAuthorized : "";
const expectedBinding =
  marker?.contractVersion === 2
    ? crypto
        .createHash("sha256")
        .update(`${stateTokenDigest}\0${marker.operationId}`)
        .digest("hex")
    : marker?.contractVersion === 3
      ? crypto
          .createHash("sha256")
          .update(
            [stateTokenDigest, marker.operationId, markerFormat, markerPolicy].join("\0"),
          )
          .digest("hex")
      : crypto
        .createHash("sha256")
        .update(
          [
            stateTokenDigest,
            marker.operationId,
            markerFormat,
            markerPolicy,
            markerConfiguredBind,
            markerRuntimeBind,
            markerOverride,
          ].join("\0"),
        )
        .digest("hex");
const expectedKeys =
  marker?.contractVersion === 2
    ? "contractVersion,markerState,statePath,stateDev,stateIno,parentDev,parentIno,stateTokenDigest,operationId,operationBinding"
    : marker?.contractVersion === 3
      ? "contractVersion,markerState,statePath,stateDev,stateIno,parentDev,parentIno,stateTokenDigest,transactionFormat,configPolicy,operationId,operationBinding"
      : "contractVersion,markerState,statePath,stateDev,stateIno,parentDev,parentIno,stateTokenDigest,transactionFormat,configPolicy,configuredGatewayBind,runtimeGatewayBind,bindOverrideAuthorized,operationId,operationBinding";
const supportedBinds = new Set(["auto", "custom", "lan", "loopback", "tailnet"]);
if (
  (marker?.contractVersion !== 2 &&
    marker?.contractVersion !== 3 &&
    marker?.contractVersion !== 4) ||
  (marker?.contractVersion === 3 &&
    (markerFormat !== "2" ||
      (markerPolicy !== "write" && markerPolicy !== "read-only"))) ||
  (marker?.contractVersion === 4 &&
    (!supportedBinds.has(markerConfiguredBind) ||
      !supportedBinds.has(markerRuntimeBind) ||
      (markerOverride !== "0" && markerOverride !== "1") ||
      (markerOverride === "1"
        ? markerPolicy !== "read-only" || markerConfiguredBind === markerRuntimeBind
        : markerConfiguredBind !== markerRuntimeBind))) ||
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
  marker.operationBinding !== expectedBinding ||
  markerRaw !== `${JSON.stringify(marker)}\n` ||
  Object.keys(marker).join(",") !== expectedKeys
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

oci_assert_transaction_file_unchanged() {
  local target="$1"
  local present="$2"
  local digest="$3"
  local mode="$4"
  local parent_dev="$5"
  local parent_ino="$6"
  local config_dev="$7"
  local config_ino="$8"
  local label="$9"
  [[ "$present" == "1" &&
    "$digest" =~ ^[a-f0-9]{64}$ &&
    "$mode" =~ ^[0-7]{3,4}$ &&
    "$parent_dev" =~ ^[0-9]+$ &&
    "$parent_ino" =~ ^[0-9]+$ &&
    "$config_dev" =~ ^[0-9]+$ &&
    "$config_ino" =~ ^[0-9]+$ ]] ||
    fail "Read-only verifier transaction metadata is malformed."
  oci_assert_pinned_state_dir
  node - "$target" "$digest" "$mode" "$parent_dev" "$parent_ino" \
    "$config_dev" "$config_ino" "$label" <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const [
  target,
  expectedDigest,
  expectedMode,
  expectedParentDev,
  expectedParentIno,
  expectedDev,
  expectedIno,
  label,
] = process.argv.slice(2);
if (!path.isAbsolute(target) || !label) {
  throw new Error("Read-only verifier target metadata is malformed.");
}
const directory = path.dirname(target);
const leaf = path.basename(target);
const sameParent = (value) =>
  value.isDirectory() &&
  !value.isSymbolicLink() &&
  String(value.dev) === expectedParentDev &&
  String(value.ino) === expectedParentIno;
const requestedParent = fs.lstatSync(directory, { bigint: true });
if (!sameParent(requestedParent)) {
  throw new Error(`${label} parent identity changed.`);
}
process.chdir(directory);
if (!sameParent(fs.lstatSync(".", { bigint: true }))) {
  throw new Error(`${label} parent changed before inspection.`);
}
const before = fs.lstatSync(leaf);
if (
  !before.isFile() ||
  before.isSymbolicLink() ||
  before.nlink !== 1 ||
  String(before.dev) !== expectedDev ||
  String(before.ino) !== expectedIno ||
  (before.mode & 0o7777).toString(8) !== expectedMode
) {
  throw new Error(`${label} metadata changed.`);
}
const fd = fs.openSync(leaf, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
try {
  const opened = fs.fstatSync(fd);
  if (
    opened.dev !== before.dev ||
    opened.ino !== before.ino ||
    opened.mode !== before.mode ||
    opened.nlink !== 1
  ) {
    throw new Error(`${label} identity changed before read.`);
  }
  const readSnapshot = (size) => {
    const value = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const count = fs.readSync(fd, value, offset, size - offset, offset);
      if (count === 0) {
        throw new Error(`${label} changed while being read.`);
      }
      offset += count;
    }
    return value;
  };
  const first = readSnapshot(opened.size);
  const middle = fs.fstatSync(fd);
  const second = readSnapshot(middle.size);
  const after = fs.fstatSync(fd);
  const finalPath = fs.lstatSync(leaf);
  if (
    opened.dev !== after.dev ||
    opened.ino !== after.ino ||
    opened.mode !== after.mode ||
    opened.nlink !== after.nlink ||
    opened.size !== after.size ||
    opened.mtimeMs !== after.mtimeMs ||
    opened.ctimeMs !== after.ctimeMs ||
    middle.size !== opened.size ||
    finalPath.dev !== opened.dev ||
    finalPath.ino !== opened.ino ||
    finalPath.mode !== opened.mode ||
    finalPath.nlink !== 1 ||
    !first.equals(second) ||
    crypto.createHash("sha256").update(first).digest("hex") !== expectedDigest
  ) {
    throw new Error(`${label} changed during read-only verification.`);
  }
  if (!sameParent(fs.lstatSync(".", { bigint: true }))) {
    throw new Error(`${label} parent changed after inspection.`);
  }
} finally {
  fs.closeSync(fd);
}
NODE
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
  local overlay_gid="${DOCKER_GID:-}"
  local existing_group_state=""
  [[ "$VERIFIER_GATEWAY_CANDIDATE_LABEL" =~ ^[a-f0-9]{64}$ ]] ||
    fail "Guarded verifier Gateway candidate label is unavailable."
  [[ -S "$DOCKER_SOCKET_PATH" ]] ||
    fail "Guarded verifier setup requires the configured Docker socket."
  if [[ -n "$overlay_gid" ]]; then
    if ! existing_group_state="$(
      docker compose "${BASE_COMPOSE_ARGS[@]}" config --format json |
        node -e '
          let input = "";
          process.stdin.setEncoding("utf8");
          process.stdin.on("data", (chunk) => {
            input += chunk;
          });
          process.stdin.on("end", () => {
            const gid = process.argv[1];
            const config = JSON.parse(input);
            const service = config.services?.["openclaw-gateway"];
            if (!service || typeof service !== "object" || Array.isArray(service)) {
              throw new Error("Gateway service is missing from the base Compose config.");
            }
            const groups = service.group_add ?? [];
            if (!Array.isArray(groups)) {
              throw new Error("Gateway group_add must be an array.");
            }
            process.stdout.write(
              groups.some((group) => String(group) === gid) ? "present" : "absent",
            );
          });
        ' "$overlay_gid"
    )"; then
      fail "Guarded verifier could not inspect the base Gateway supplemental groups."
    fi
    case "$existing_group_state" in
      present) overlay_gid="" ;;
      absent) ;;
      *) fail "Guarded verifier received an invalid supplemental-group inspection result." ;;
    esac
  fi
  tmp="$(mktemp "$ROOT_DIR/.docker-compose.sandbox.XXXXXX")"
  node - "$tmp" "$DOCKER_SOCKET_PATH" "$overlay_gid" \
    "$VERIFIER_GATEWAY_CANDIDATE_LABEL" <<'NODE'
const fs = require("node:fs");
const [outputPath, socketPath, dockerGid, candidateLabel] = process.argv.slice(2);
if (!/^[a-f0-9]{64}$/.test(candidateLabel)) {
  throw new Error("Gateway candidate label is malformed.");
}
const lines = [
  "services:",
  "  openclaw-gateway:",
  "    labels:",
  `      ai.openclaw.verifier.gateway-candidate: ${JSON.stringify(candidateLabel)}`,
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
  local phase=""
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
  local compose_project=""
  local compose_service=""
  local candidate_label=""
  local create_binding=""
  local old_image=""
  local old_stable=""
  local gateway_was_running=""
  local env_backup_digest=""
  local env_backup_mode=""
  local env_backup_parent_dev=""
  local env_backup_parent_ino=""
  local transaction_format=""
  local config_policy=""
  local configured_bind=""
  local runtime_bind=""
  local override_authorized=""
  local config_backup_present=""
  local config_backup_digest=""
  local config_backup_mode=""
  local config_backup_parent_dev=""
  local config_backup_parent_ino=""
  local config_dev=""
  local config_ino=""
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
  oci_load_transaction_contract >/dev/null
  transaction_format="$VERIFIER_OPERATION_FORMAT"
  config_policy="$VERIFIER_OPERATION_CONFIG_POLICY"
  configured_bind="$VERIFIER_OPERATION_CONFIGURED_GATEWAY_BIND"
  runtime_bind="$VERIFIER_OPERATION_RUNTIME_GATEWAY_BIND"
  override_authorized="$VERIFIER_OPERATION_BIND_OVERRIDE_AUTHORIZED"
  phase="$(oci_read_journal phase)"
  oci_assert_known_phase "$phase"
  [[ "$phase" == "committed" ]] ||
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
  compose_project="$(oci_read_journal gateway-compose-project '')"
  compose_service="$(oci_read_journal gateway-compose-service '')"
  candidate_label="$(oci_read_journal gateway-candidate-label '')"
  create_binding="$(oci_read_journal gateway-create-binding '')"
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
  config_dev="$(oci_read_journal config-dev '')"
  config_ino="$(oci_read_journal config-ino '')"
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
    "$old_image" "$old_stable" "$gateway_was_running" \
    "$transaction_format" "$config_policy"
  oci_validate_transaction_metadata \
    "$transaction_id" "$candidate_tag" "$final_tag" "$runtime_image" \
    "$old_gateway" "$old_gateway_image" "$env_backup_digest" "$env_backup_mode" \
    "$env_backup_parent_dev" "$env_backup_parent_ino" \
    "$transaction_format" "$config_policy" "$config_backup_present" \
    "$config_backup_digest" "$config_backup_mode" \
    "$config_backup_parent_dev" "$config_backup_parent_ino" \
    "$config_dev" "$config_ino" \
    "$overlay_backup_present" "$overlay_backup_digest" "$overlay_backup_mode" \
    "$overlay_backup_parent_dev" "$overlay_backup_parent_ino" \
    "$docker_socket_path" "$gc_old_image"
  oci_validate_gateway_create_contract \
    "$phase" "$transaction_format" "$operation_binding" "$old_gateway" \
    "$transaction_id" "$runtime_image" "$compose_project" "$compose_service" \
    "$candidate_label" "$create_binding" "$config_policy" \
    "$configured_bind" "$runtime_bind" "$override_authorized" \
    "$VERIFIER_OPERATION_CONTRACT_VERSION"
  oci_validate_config_transaction_artifact \
    "$config_policy" "$config_backup_present" "$config_backup_digest"
  oci_validate_restore_state
  [[ -z "$(oci_read_journal restore-state)" ]] ||
    fail "Committed verifier transaction retains incomplete restore state."
  if [[ "$config_policy" == "read-only" ]]; then
    validate_read_only_existing_config \
      "$configured_bind" "$runtime_bind" "$override_authorized" \
      "$config_dev" "$config_ino" "$config_backup_digest" "$config_backup_mode" \
      "$config_backup_parent_dev" "$config_backup_parent_ino"
    [[ ! -e "$VERIFIER_TRANSACTION_DIR/config.backup" &&
      ! -L "$VERIFIER_TRANSACTION_DIR/config.backup" ]] ||
      fail "Read-only verifier transaction contains a plaintext config backup."
    oci_assert_transaction_file_unchanged \
      "$OPENCLAW_CONFIG_DIR/openclaw.json" \
      "$config_backup_present" "$config_backup_digest" "$config_backup_mode" \
      "$config_backup_parent_dev" "$config_backup_parent_ino" \
      "$config_dev" "$config_ino" \
      "Protected OpenClaw config"
    assert_protected_config_immutable \
      "Protected OpenClaw config at committed recovery" \
      "$config_dev" "$config_ino" "$config_backup_digest" "$config_backup_mode" \
      "$config_backup_parent_dev" "$config_backup_parent_ino"
  fi
  oci_validate_phase_state "committed" "$candidate" "$final" "$new_gateway"
  if [[ "$transaction_format" == "2" ]]; then
    oci_validate_gateway_container_identity \
      "$new_gateway" "$runtime_image" "$compose_project" "$compose_service" \
      "true" "$candidate_label" >/dev/null
  fi
  oci_assert_exact_gateway_ready "$new_gateway" "$runtime_image" "$docker_socket_path"
  if [[ -n "$READ_ONLY_CONFIG_PROCESS_SETTING_PRESENT" &&
    -z "$READ_ONLY_CONFIG_ENABLED" &&
    -n "$BIND_OVERRIDE_PROCESS_SETTING_PRESENT" &&
    -n "$BIND_OVERRIDE_ENABLED" ]]; then
    fail "OPENCLAW_SETUP_READ_ONLY_CONFIG_ALLOW_BIND_OVERRIDE requires read-only guarded verifier publication."
  fi
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
  if [[ -z "$READ_ONLY_CONFIG_ENABLED" &&
    ( -n "$READ_ONLY_CONFIG_PROCESS_SETTING_PRESENT" ||
      ( "$config_policy" == "read-only" &&
        -n "$READ_ONLY_CONFIG_SETTING_PRESENT" ) ) ]]; then
    [[ -z "$BIND_OVERRIDE_ENABLED" ]] ||
      fail "OPENCLAW_SETUP_READ_ONLY_CONFIG_ALLOW_BIND_OVERRIDE requires read-only guarded verifier publication."
    OPENCLAW_SETUP_READ_ONLY_CONFIG="0"
    OPENCLAW_SETUP_READ_ONLY_CONFIG_ALLOW_BIND_OVERRIDE="0"
    export \
      OPENCLAW_SETUP_READ_ONLY_CONFIG \
      OPENCLAW_SETUP_READ_ONLY_CONFIG_ALLOW_BIND_OVERRIDE
    oci_wait_transaction_state_test_barrier committed-env-persist
    upsert_env "$ENV_FILE" \
      OPENCLAW_SETUP_READ_ONLY_CONFIG \
      OPENCLAW_SETUP_READ_ONLY_CONFIG_ALLOW_BIND_OVERRIDE
    oci_sync_normal_mode_env_handoff
    oci_wait_transaction_state_test_barrier committed-env-durable
    [[ ! -d "$VERIFIER_LOCK_DIR" ]] || oci_assert_lock_tree
  fi
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
  local compose_project=""
  local compose_service=""
  local candidate_label=""
  local create_binding=""
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
  local transaction_format=""
  local config_policy=""
  local configured_bind=""
  local runtime_bind=""
  local override_authorized=""
  local config_backup_present=""
  local config_backup_digest=""
  local config_backup_mode=""
  local config_backup_parent_dev=""
  local config_backup_parent_ino=""
  local config_dev=""
  local config_ino=""
  local overlay_backup_present=""
  local overlay_backup_digest=""
  local overlay_backup_mode=""
  local overlay_backup_parent_dev=""
  local overlay_backup_parent_ino=""
  local docker_socket_path=""
  local gc_old_image=""
  local current_gateway=""
  local candidate_status=""
  local restored_gateway=""
  local old_gateway_ref=""
  local -a rollback_args=()
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
    oci_load_transaction_contract >/dev/null
    transaction_format="$VERIFIER_OPERATION_FORMAT"
    config_policy="$VERIFIER_OPERATION_CONFIG_POLICY"
    configured_bind="$VERIFIER_OPERATION_CONFIGURED_GATEWAY_BIND"
    runtime_bind="$VERIFIER_OPERATION_RUNTIME_GATEWAY_BIND"
    override_authorized="$VERIFIER_OPERATION_BIND_OVERRIDE_AUTHORIZED"
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
    compose_project="$(oci_read_journal gateway-compose-project '')"
    compose_service="$(oci_read_journal gateway-compose-service '')"
    candidate_label="$(oci_read_journal gateway-candidate-label '')"
    create_binding="$(oci_read_journal gateway-create-binding '')"
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
    config_dev="$(oci_read_journal config-dev '')"
    config_ino="$(oci_read_journal config-ino '')"
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
      "$old_image" "$old_stable" "$gateway_was_running" \
      "$transaction_format" "$config_policy"
    oci_validate_transaction_metadata \
      "$transaction_id" "$candidate_tag" "$final_tag" "$runtime_image" \
      "$old_gateway" "$old_gateway_image" "$env_backup_digest" "$env_backup_mode" \
      "$env_backup_parent_dev" "$env_backup_parent_ino" \
      "$transaction_format" "$config_policy" "$config_backup_present" \
      "$config_backup_digest" "$config_backup_mode" \
      "$config_backup_parent_dev" "$config_backup_parent_ino" \
      "$config_dev" "$config_ino" \
      "$overlay_backup_present" "$overlay_backup_digest" "$overlay_backup_mode" \
      "$overlay_backup_parent_dev" "$overlay_backup_parent_ino" \
      "$docker_socket_path" "$gc_old_image"
    oci_validate_gateway_create_contract \
      "$phase" "$transaction_format" "$operation_binding" "$old_gateway" \
      "$transaction_id" "$runtime_image" "$compose_project" "$compose_service" \
      "$candidate_label" "$create_binding" "$config_policy" \
      "$configured_bind" "$runtime_bind" "$override_authorized" \
      "$VERIFIER_OPERATION_CONTRACT_VERSION"
    oci_validate_config_transaction_artifact \
      "$config_policy" "$config_backup_present" "$config_backup_digest"
    oci_validate_restore_state
    oci_validate_phase_state "$phase" "$candidate" "$final" "$new_gateway"
    rollback_args=(-f "$COMPOSE_FILE")
    [[ ! -f "$EXTRA_COMPOSE_FILE" ]] ||
      rollback_args+=("-f" "$EXTRA_COMPOSE_FILE")
    [[ ! "$old_image" =~ ^sha256:[a-f0-9]{64}$ ]] ||
      rollback_args+=("-f" "$VERIFIER_COMPOSE_FILE")
    [[ ! -f "$SANDBOX_COMPOSE_FILE" ]] ||
      rollback_args+=("-f" "$SANDBOX_COMPOSE_FILE")
    if current_gateway="$(
      oci_stop_authenticated_gateway_candidate \
        "$phase" "$transaction_format" "$old_gateway" "$old_gateway_image" \
        "$runtime_image" "$new_gateway" "$compose_project" "$compose_service" \
        "$candidate_label" "${rollback_args[@]}"
    )"; then
      :
    else
      candidate_status="$?"
      if [[ "$candidate_status" == "2" ]]; then
        echo "ERROR: Retaining verifier journal, lock, and active-state marker after ambiguous Gateway service recovery." >&2
        exit "$status"
      fi
      fail "Verifier recovery could not authenticate its exact Gateway candidate."
    fi
    oci_validate_transaction_live_policy \
      "$VERIFIER_OPERATION_CONTRACT_VERSION" "$runtime_bind" "$override_authorized"
    if [[ "$config_policy" == "read-only" ]]; then
      assert_protected_config_immutable \
        "Protected OpenClaw config before verifier recovery" \
        "$config_dev" "$config_ino" "$config_backup_digest" "$config_backup_mode" \
        "$config_backup_parent_dev" "$config_backup_parent_ino"
      validate_read_only_existing_config \
        "$configured_bind" "$runtime_bind" "$override_authorized" \
        "$config_dev" "$config_ino" "$config_backup_digest" "$config_backup_mode" \
        "$config_backup_parent_dev" "$config_backup_parent_ino"
      [[ ! -e "$VERIFIER_TRANSACTION_DIR/config.backup" &&
        ! -L "$VERIFIER_TRANSACTION_DIR/config.backup" ]] ||
        fail "Read-only verifier transaction contains a plaintext config backup."
      oci_assert_transaction_file_unchanged \
        "$OPENCLAW_CONFIG_DIR/openclaw.json" \
        "$config_backup_present" "$config_backup_digest" "$config_backup_mode" \
        "$config_backup_parent_dev" "$config_backup_parent_ino" \
        "$config_dev" "$config_ino" \
        "Protected OpenClaw config before verifier recovery"
    fi
    oci_assert_owned_mode "$VERIFIER_TRANSACTION_DIR/env.backup" 600
    oci_restore_transaction_file \
      "$ENV_FILE" \
      "$VERIFIER_TRANSACTION_DIR/env.backup" \
      "1" "$env_backup_digest" "$env_backup_mode" \
      "$env_backup_parent_dev" "$env_backup_parent_ino" "env"
    reload_verifier_shell_from_env
    oci_restore_stable_tag "$old_stable"
    if [[ "$config_policy" == "write" ]]; then
      oci_restore_transaction_file \
        "$OPENCLAW_CONFIG_DIR/openclaw.json" \
        "$VERIFIER_TRANSACTION_DIR/config.backup" \
        "$config_backup_present" "$config_backup_digest" "$config_backup_mode" \
        "$config_backup_parent_dev" "$config_backup_parent_ino" "config"
    fi
    oci_restore_transaction_file \
      "$SANDBOX_COMPOSE_FILE" \
      "$VERIFIER_TRANSACTION_DIR/sandbox-overlay.backup" \
      "$overlay_backup_present" "$overlay_backup_digest" "$overlay_backup_mode" \
      "$overlay_backup_parent_dev" "$overlay_backup_parent_ino" "overlay"

    rollback_args=(-f "$COMPOSE_FILE")
    [[ ! -f "$EXTRA_COMPOSE_FILE" ]] ||
      rollback_args+=("-f" "$EXTRA_COMPOSE_FILE")
    [[ ! "$old_image" =~ ^sha256:[a-f0-9]{64}$ ]] ||
      rollback_args+=("-f" "$VERIFIER_COMPOSE_FILE")
    [[ ! -f "$SANDBOX_COMPOSE_FILE" ]] ||
      rollback_args+=("-f" "$SANDBOX_COMPOSE_FILE")
    if [[ -z "$current_gateway" ]] &&
      { [[ "$transaction_format" == "legacy" ]] ||
        ! oci_phase_has_gateway_create_intent "$phase"; }; then
      current_gateway="$(
        docker compose "${rollback_args[@]}" ps -a -q --no-trunc openclaw-gateway
      )"
      [[ "$current_gateway" != *$'\n'* &&
        ( -z "$current_gateway" || "$current_gateway" =~ ^[a-f0-9]{64}$ ) ]] ||
        fail "Verifier recovery found an ambiguous current Gateway identity."
    fi
    if [[ -n "$current_gateway" && "$current_gateway" != "$old_gateway" ]]; then
      if [[ "$transaction_format" == "2" ]] &&
        oci_phase_has_gateway_create_intent "$phase"; then
        [[ "$current_gateway" == "${new_gateway:-$current_gateway}" ]] ||
          fail "Verifier recovery candidate changed before exact removal."
        oci_validate_gateway_container_identity \
          "$current_gateway" "$runtime_image" \
          "$compose_project" "$compose_service" "false" "$candidate_label" >/dev/null
      elif [[ "$transaction_format" == "2" ]]; then
        fail "Verifier recovery found an unjournaled Gateway before create intent."
      fi
      docker rm -f "$current_gateway" >/dev/null
      current_gateway=""
    fi
    if [[ "$gateway_was_running" == "1" ]]; then
      [[ "$old_gateway_image" =~ ^sha256:[a-f0-9]{64}$ ]] ||
        fail "Verifier recovery lacks the prior running Gateway image."
      if [[ "$current_gateway" == "$old_gateway" &&
        "$(docker inspect --format '{{.Image}}' "$current_gateway")" == "$old_gateway_image" &&
        "$(docker inspect --format '{{.State.Running}}' "$current_gateway")" == "true" ]]; then
        restored_gateway="$current_gateway"
      else
        old_gateway_ref="$(
          oci_require_content_addressed_image_ref gateway-rollback "$old_gateway_image"
        )"
        OPENCLAW_IMAGE="$old_gateway_ref" \
          docker compose "${rollback_args[@]}" up -d --no-deps --force-recreate openclaw-gateway
        restored_gateway="$(docker compose "${rollback_args[@]}" ps -q openclaw-gateway)"
      fi
      [[ "$restored_gateway" =~ ^[a-f0-9]{64}$ &&
        "$(docker inspect --format '{{.Image}}' "$restored_gateway")" == "$old_gateway_image" &&
        "$(docker inspect --format '{{.State.Running}}' "$restored_gateway")" == "true" ]] ||
        fail "Verifier recovery did not restore the exact prior Gateway image."
    elif [[ -n "$old_gateway_image" ]]; then
      if [[ -n "$current_gateway" ]]; then
        docker stop "$current_gateway" >/dev/null
        restored_gateway="$current_gateway"
      else
        old_gateway_ref="$(
          oci_require_content_addressed_image_ref gateway-rollback "$old_gateway_image"
        )"
        OPENCLAW_IMAGE="$old_gateway_ref" \
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
  if [[ -z "$VERIFIER_OPERATION_FORMAT" &&
    ( -e "$VERIFIER_TRANSACTION_DIR" || -L "$VERIFIER_TRANSACTION_DIR" ) ]]; then
    [[ ! -L "$VERIFIER_TRANSACTION_DIR" && -d "$VERIFIER_TRANSACTION_DIR" ]] ||
      fail "Existing verifier transaction state is unsafe."
    oci_pin_transaction_dir
    oci_reconcile_journal_temps
    oci_assert_transaction_tree
    oci_validate_journal_shape
    oci_load_transaction_contract >/dev/null
  fi
  if [[ -z "$VERIFIER_OPERATION_FORMAT" ]]; then
    VERIFIER_OPERATION_CONTRACT_VERSION="2"
    VERIFIER_OPERATION_FORMAT="legacy"
    VERIFIER_OPERATION_CONFIG_POLICY="write"
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
        VERIFIER_COMMITTED_RECOVERY_COMPLETED="1"
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
  if [[ "$VERIFIER_CONFIG_POLICY" == "read-only" ]]; then
    assert_protected_config_unchanged \
      "Protected OpenClaw config before verifier transaction"
    VERIFIER_CONFIG_BACKUP_PRESENT="1"
    VERIFIER_CONFIG_BACKUP_DIGEST="$PROTECTED_CONFIG_DIGEST"
    VERIFIER_CONFIG_BACKUP_MODE="$PROTECTED_CONFIG_MODE"
    VERIFIER_CONFIG_BACKUP_PARENT_DEV="$PROTECTED_CONFIG_PARENT_DEV"
    VERIFIER_CONFIG_BACKUP_PARENT_INO="$PROTECTED_CONFIG_PARENT_INO"
    VERIFIER_CONFIG_DEV="$PROTECTED_CONFIG_DEV"
    VERIFIER_CONFIG_INO="$PROTECTED_CONFIG_INO"
    [[ ! -e "$VERIFIER_TRANSACTION_DIR/config.backup" &&
      ! -L "$VERIFIER_TRANSACTION_DIR/config.backup" ]] ||
      fail "Read-only verifier transaction must not contain a plaintext config backup."
  else
    oci_backup_transaction_file \
      "$OPENCLAW_CONFIG_DIR/openclaw.json" \
      "$VERIFIER_TRANSACTION_DIR/config.backup" \
      "0" VERIFIER_CONFIG_BACKUP_PRESENT VERIFIER_CONFIG_BACKUP_DIGEST \
      VERIFIER_CONFIG_BACKUP_MODE VERIFIER_CONFIG_BACKUP_PARENT_DEV \
      VERIFIER_CONFIG_BACKUP_PARENT_INO
  fi
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
    --tmpfs /tmp:rw,nosuid,nodev,noexec,size=64m \
    --env OPENCLAW_VERIFIER_VERIFY=1 --entrypoint node "$image_id" \
    /opt/openclaw/openclaw.mjs sandbox verifier-verify \
    --workspace "$OPENCLAW_VERIFIER_GATEWAY_WORKSPACE" \
    --browser-root /opt/openclaw-verifier/browsers \
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
  local compose_identity=""
  local candidate_image_ref=""
  local digest=""
  local candidate_layers=""
  local final_layers=""
  local yarnrc_path="$OPENCLAW_VERIFIER_WORKSPACE_DIR/.yarnrc.yml"
  local yarnrc_sha256="absent"
  oci_assert_pinned_state_dir
  OPENCLAW_VERIFIER_TRANSACTION_ID="$(
    node -e 'process.stdout.write(require("node:crypto").randomBytes(16).toString("hex"))'
  )"
  VERIFIER_OPERATION_CONTRACT_VERSION="4"
  VERIFIER_OPERATION_FORMAT="$VERIFIER_TRANSACTION_FORMAT"
  VERIFIER_OPERATION_CONFIG_POLICY="$VERIFIER_CONFIG_POLICY"
  VERIFIER_OPERATION_CONFIGURED_GATEWAY_BIND="$VERIFIER_CONFIGURED_GATEWAY_BIND"
  VERIFIER_OPERATION_RUNTIME_GATEWAY_BIND="$VERIFIER_RUNTIME_GATEWAY_BIND"
  VERIFIER_OPERATION_BIND_OVERRIDE_AUTHORIZED="$VERIFIER_BIND_OVERRIDE_AUTHORIZED"
  VERIFIER_OPERATION_BINDING="$(
    oci_operation_binding "$OPENCLAW_VERIFIER_TRANSACTION_ID"
  )"
  VERIFIER_CANDIDATE_TAG="openclaw-sandbox-verifier:candidate-$OPENCLAW_VERIFIER_TRANSACTION_ID"
  VERIFIER_FINAL_TAG="openclaw-sandbox-verifier:published-$OPENCLAW_VERIFIER_TRANSACTION_ID"
  VERIFIER_CANDIDATE_IMAGE_ID=""
  VERIFIER_FINAL_IMAGE_ID=""
  VERIFIER_NEW_GATEWAY_ID=""
  VERIFIER_RUNTIME_IMAGE_ID=""
  VERIFIER_RUNTIME_IMAGE_REF=""
  VERIFIER_OLD_GATEWAY_ID=""
  VERIFIER_OLD_GATEWAY_IMAGE_ID=""
  VERIFIER_GATEWAY_COMPOSE_PROJECT=""
  VERIFIER_GATEWAY_COMPOSE_SERVICE=""
  VERIFIER_GATEWAY_CANDIDATE_LABEL="$(
    oci_gateway_candidate_label "$OPENCLAW_VERIFIER_TRANSACTION_ID"
  )"
  VERIFIER_GATEWAY_CREATE_BINDING=""
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
  VERIFIER_CONFIG_DEV=""
  VERIFIER_CONFIG_INO=""
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
  VERIFIER_RUNTIME_IMAGE_REF="$(
    oci_pin_content_addressed_image_ref verifier-runtime "$VERIFIER_RUNTIME_IMAGE_ID"
  )"
  [[ -S "$DOCKER_SOCKET_PATH" ]] ||
    fail "Guarded verifier setup requires the configured Docker socket before publication."
  OPENCLAW_IMAGE="$VERIFIER_RUNTIME_IMAGE_REF" \
    docker compose "${COMPOSE_ARGS[@]}" run --rm --no-deps \
    --entrypoint docker openclaw-gateway --version >/dev/null

  begin_verifier_transaction
  if [[ -e "$yarnrc_path" || -L "$yarnrc_path" ]]; then
    [[ -f "$yarnrc_path" && ! -L "$yarnrc_path" ]] ||
      fail "Guarded verifier Yarn configuration must be a regular non-symlink file."
    yarnrc_sha256="$(oci_file_digest "$yarnrc_path")"
    [[ "$yarnrc_sha256" =~ ^[a-f0-9]{64}$ ]] ||
      fail "Guarded verifier Yarn configuration returned a malformed digest."
    set -- --secret "id=openclaw-verifier-yarnrc,src=$yarnrc_path"
  else
    set --
  fi
  run_docker_build \
    "$@" \
    --build-arg "OPENCLAW_RUNTIME_IMAGE=$VERIFIER_RUNTIME_IMAGE_REF" \
    --build-arg "OPENCLAW_RUNTIME_IMAGE_ID=$VERIFIER_RUNTIME_IMAGE_ID" \
    --build-arg "OPENCLAW_SOURCE_REVISION=$OPENCLAW_SOURCE_REVISION" \
    --build-arg "OPENCLAW_VERIFIER_PACKAGE_MANAGER=$OPENCLAW_VERIFIER_PACKAGE_MANAGER" \
    --build-arg "OPENCLAW_VERIFIER_REPOSITORY_HEAD=$VERIFIER_REPOSITORY_HEAD" \
    --build-arg "OPENCLAW_VERIFIER_YARNRC_SHA256=$yarnrc_sha256" \
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
  candidate_image_ref="$(
    oci_pin_content_addressed_image_ref verifier-candidate "$VERIFIER_CANDIDATE_IMAGE_ID"
  )"

  run_docker_build \
    --build-arg "OPENCLAW_VERIFIER_CANDIDATE_IMAGE=$candidate_image_ref" \
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
  if [[ "$VERIFIER_CONFIG_POLICY" == "read-only" ]]; then
    validate_read_only_existing_config
    oci_assert_transaction_file_unchanged \
      "$OPENCLAW_CONFIG_DIR/openclaw.json" \
      "$VERIFIER_CONFIG_BACKUP_PRESENT" "$VERIFIER_CONFIG_BACKUP_DIGEST" \
      "$VERIFIER_CONFIG_BACKUP_MODE" \
      "$VERIFIER_CONFIG_BACKUP_PARENT_DEV" "$VERIFIER_CONFIG_BACKUP_PARENT_INO" \
      "$VERIFIER_CONFIG_DEV" "$VERIFIER_CONFIG_INO" \
      "Protected OpenClaw config before socket publication"
  fi
  write_sandbox_compose_overlay
  if [[ -z "$VERIFIER_SOCKET_OVERLAY_READY" ]]; then
    COMPOSE_ARGS+=("-f" "$SANDBOX_COMPOSE_FILE")
    COMPOSE_HINT+=" -f ${SANDBOX_COMPOSE_FILE}"
    VERIFIER_SOCKET_OVERLAY_READY="1"
  fi
  oci_write_journal socket-overlay-written
  if [[ "$VERIFIER_CONFIG_POLICY" == "write" ]]; then
    VERIFIER_RUNTIME_IMAGE_REF="$(
      oci_require_content_addressed_image_ref verifier-runtime "$VERIFIER_RUNTIME_IMAGE_ID"
    )"
    OPENCLAW_IMAGE="$VERIFIER_RUNTIME_IMAGE_REF" \
      run_prestart_cli config set --batch-json \
      '[{"path":"agents.defaults.sandbox.mode","value":"non-main"},{"path":"agents.defaults.sandbox.scope","value":"agent"},{"path":"agents.defaults.sandbox.workspaceAccess","value":"none"}]' >/dev/null
  fi
  oci_write_journal sandbox-configured

  if [[ "$VERIFIER_CONFIG_POLICY" == "read-only" ]]; then
    oci_assert_transaction_file_unchanged \
      "$OPENCLAW_CONFIG_DIR/openclaw.json" \
      "$VERIFIER_CONFIG_BACKUP_PRESENT" "$VERIFIER_CONFIG_BACKUP_DIGEST" \
      "$VERIFIER_CONFIG_BACKUP_MODE" \
      "$VERIFIER_CONFIG_BACKUP_PARENT_DEV" "$VERIFIER_CONFIG_BACKUP_PARENT_INO" \
      "$VERIFIER_CONFIG_DEV" "$VERIFIER_CONFIG_INO" \
      "Protected OpenClaw config before Gateway recreation"
    assert_protected_config_immutable \
      "Protected OpenClaw config at final pre-exec boundary"
  fi
  compose_identity="$(
    oci_compose_gateway_identity \
      "$VERIFIER_GATEWAY_CANDIDATE_LABEL" "${COMPOSE_ARGS[@]}"
  )"
  IFS='|' read -r \
    VERIFIER_GATEWAY_COMPOSE_PROJECT VERIFIER_GATEWAY_COMPOSE_SERVICE \
    <<<"$compose_identity"
  VERIFIER_GATEWAY_CREATE_BINDING="$(
    oci_gateway_create_binding \
      "$VERIFIER_OPERATION_BINDING" "$VERIFIER_OLD_GATEWAY_ID" \
      "$VERIFIER_RUNTIME_IMAGE_ID" "$VERIFIER_GATEWAY_COMPOSE_PROJECT" \
      "$VERIFIER_GATEWAY_COMPOSE_SERVICE" "$VERIFIER_GATEWAY_CANDIDATE_LABEL" \
      "$VERIFIER_TRANSACTION_FORMAT" "$VERIFIER_CONFIG_POLICY" \
      "$VERIFIER_CONFIGURED_GATEWAY_BIND" "$VERIFIER_RUNTIME_GATEWAY_BIND" \
      "$VERIFIER_BIND_OVERRIDE_AUTHORIZED" "$VERIFIER_OPERATION_CONTRACT_VERSION"
  )"
  oci_write_journal gateway-create-intent
  VERIFIER_RUNTIME_IMAGE_REF="$(
    oci_require_content_addressed_image_ref verifier-runtime "$VERIFIER_RUNTIME_IMAGE_ID"
  )"
  OPENCLAW_IMAGE="$VERIFIER_RUNTIME_IMAGE_REF" \
    docker compose "${COMPOSE_ARGS[@]}" up -d --no-deps --force-recreate openclaw-gateway
  gateway="$(
    oci_resolve_gateway_service_container \
      "$VERIFIER_GATEWAY_COMPOSE_PROJECT" "$VERIFIER_GATEWAY_COMPOSE_SERVICE" \
      "${COMPOSE_ARGS[@]}"
  )"
  [[ -n "$gateway" ]] ||
    fail "Guarded verifier publication did not resolve its Gateway service container."
  oci_validate_gateway_container_identity \
    "$gateway" "$VERIFIER_RUNTIME_IMAGE_ID" \
    "$VERIFIER_GATEWAY_COMPOSE_PROJECT" "$VERIFIER_GATEWAY_COMPOSE_SERVICE" \
    "true" "$VERIFIER_GATEWAY_CANDIDATE_LABEL" >/dev/null
  VERIFIER_NEW_GATEWAY_ID="$gateway"
  oci_write_journal gateway-started
  if [[ "$VERIFIER_CONFIG_POLICY" == "read-only" ]]; then
    assert_protected_config_immutable \
      "Protected OpenClaw config at post-create boundary"
  fi
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
  if [[ "$VERIFIER_CONFIG_POLICY" == "read-only" ]]; then
    [[ ! -e "$VERIFIER_TRANSACTION_DIR/config.backup" &&
      ! -L "$VERIFIER_TRANSACTION_DIR/config.backup" ]] ||
      fail "Read-only verifier transaction contains a plaintext config backup."
    oci_assert_transaction_file_unchanged \
      "$OPENCLAW_CONFIG_DIR/openclaw.json" \
      "$VERIFIER_CONFIG_BACKUP_PRESENT" "$VERIFIER_CONFIG_BACKUP_DIGEST" \
      "$VERIFIER_CONFIG_BACKUP_MODE" \
      "$VERIFIER_CONFIG_BACKUP_PARENT_DEV" "$VERIFIER_CONFIG_BACKUP_PARENT_INO" \
      "$VERIFIER_CONFIG_DEV" "$VERIFIER_CONFIG_INO" \
      "Protected OpenClaw config"
    assert_protected_config_immutable \
      "Protected OpenClaw config at transaction commit"
  fi
  oci_validate_config_transaction_artifact \
    "$VERIFIER_CONFIG_POLICY" "$VERIFIER_CONFIG_BACKUP_PRESENT" \
    "$VERIFIER_CONFIG_BACKUP_DIGEST"
  oci_write_journal committed
  finish_committed_verifier_transaction
  trap - EXIT INT TERM
}

if [[ -n "$VERIFIER_ENABLED" ]]; then
  # Reject unsafe persistent state placement before mutating .env, building
  # images, or changing the running Gateway.
  oci_assert_state_dir
  recover_existing_verifier_transaction_before_mutation
  if [[ -n "$VERIFIER_COMMITTED_RECOVERY_COMPLETED" ]]; then
    echo "Completed authenticated cleanup for the already-committed guarded verifier publication."
    exit 0
  fi
  oci_assert_pinned_state_dir
fi
if [[ -n "$READ_ONLY_CONFIG_ENABLED" ]]; then
  if [[ -n "$DEFER_PROTECTED_CONFIG_VALIDATION" ]]; then
    prepare_read_only_existing_config_contract
    DEFER_PROTECTED_CONFIG_VALIDATION=""
  fi
  validate_read_only_existing_config
fi
if [[ -n "$VERIFIER_ENABLED" ]]; then
  # Preserve a runnable, content-addressed reference before a local build or
  # registry pull advances the ordinary Gateway image tag.
  pin_current_gateway_image_for_verifier_update
fi

if [[ -n "$READ_ONLY_CONFIG_SETTING_PRESENT" ]]; then
  # Persist an explicit choice so interrupted verifier recovery cannot silently
  # fall back to the config-mutating default on retry.
  upsert_env "$ENV_FILE" OPENCLAW_SETUP_READ_ONLY_CONFIG
fi
if [[ -n "$BIND_OVERRIDE_SETTING_PRESENT" ]]; then
  # The override is an explicit operator authorization and must survive a
  # verifier crash without being inferred from the normal Docker bind default.
  upsert_env "$ENV_FILE" OPENCLAW_SETUP_READ_ONLY_CONFIG_ALLOW_BIND_OVERRIDE
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
if [[ -n "$SANDBOX_ENABLED" && -S "$DOCKER_SOCKET_PATH" ]]; then
  DOCKER_GID="$(detect_container_docker_socket_gid "$IMAGE_NAME" "$DOCKER_SOCKET_PATH")"
  export DOCKER_GID
  upsert_env "$ENV_FILE" DOCKER_GID
fi

if [[ -n "$READ_ONLY_CONFIG_ENABLED" ]]; then
  echo ""
  echo "==> Validating protected existing config (read-only)"
  validate_read_only_existing_config
  echo "Skipping config ownership normalization, onboarding, and setup config writes."
else
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
fi

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
if [[ -z "$READ_ONLY_CONFIG_ENABLED" ]]; then
  echo "Token: $OPENCLAW_GATEWAY_TOKEN"
fi
echo ""
echo "Commands:"
echo "  ${COMPOSE_HINT} logs -f openclaw-gateway"
if [[ -n "$READ_ONLY_CONFIG_ENABLED" ]]; then
  echo "  ${COMPOSE_HINT} exec openclaw-gateway node dist/index.js health --token \"\$OPENCLAW_GATEWAY_TOKEN\""
else
  echo "  ${COMPOSE_HINT} exec openclaw-gateway node dist/index.js health --token \"$OPENCLAW_GATEWAY_TOKEN\""
fi
