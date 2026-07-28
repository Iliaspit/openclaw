import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

type DockerSetupSandbox = {
  rootDir: string;
  stateRoot: string;
  scriptPath: string;
  logPath: string;
  binDir: string;
};

async function writeDockerStub(binDir: string, logPath: string) {
  const stub = `#!/usr/bin/env bash
set -euo pipefail
log="$DOCKER_STUB_LOG"
fail_match="\${DOCKER_STUB_FAIL_MATCH:-}"
fail_after_match="\${DOCKER_STUB_FAIL_AFTER_MATCH:-}"
fail_count_match="\${DOCKER_STUB_FAIL_COUNT_MATCH:-}"
fail_count_limit="\${DOCKER_STUB_FAIL_COUNT_LIMIT:-0}"
kill_parent_match="\${DOCKER_STUB_KILL_PARENT_MATCH:-}"
image_dir="$DOCKER_STUB_IMAGE_DIR"
failure_dir="$DOCKER_STUB_FAILURE_DIR"
mkdir -p "$image_dir"
mkdir -p "$failure_dir"
image_registry="$image_dir/registry"
gateway_id_file="$image_dir/gateway-id"
gateway_running_file="$image_dir/gateway-running"
gateway_absent_file="$image_dir/gateway-absent"
container_dir="$image_dir/containers"
mkdir -p "$container_dir"
touch "$image_registry"
current_gateway_id() {
  if [[ -f "$gateway_id_file" ]]; then
    cat "$gateway_id_file"
  elif [[ ! -f "$gateway_absent_file" && -n "\${DOCKER_STUB_OLD_GATEWAY_ID:-}" ]]; then
    printf '%s' "$DOCKER_STUB_OLD_GATEWAY_ID"
  fi
  return 0
}
container_field() {
  container_id="$1"
  field="$2"
  if [[ -f "$container_dir/$container_id/$field" ]]; then
    cat "$container_dir/$container_id/$field"
    return 0
  fi
  if [[ "$container_id" == "\${DOCKER_STUB_OLD_GATEWAY_ID:-}" ]]; then
    case "$field" in
      image) printf '%s' "\${DOCKER_STUB_OLD_GATEWAY_IMAGE:-}" ;;
      running) printf '%s' "\${DOCKER_STUB_OLD_GATEWAY_RUNNING:-false}" ;;
      project) printf '%s' "\${DOCKER_STUB_COMPOSE_PROJECT:-openclaw}" ;;
      service) printf '%s' openclaw-gateway ;;
      oneoff) printf '%s' False ;;
      candidate-label) printf '%s' "\${DOCKER_STUB_OLD_GATEWAY_CANDIDATE_LABEL:-}" ;;
    esac
  fi
  return 0
}
record_gateway_container() {
  container_id="$1"
  container_image="$2"
  container_running="$3"
  container_project="$4"
  container_service="$5"
  container_candidate_label="$6"
  rm -rf "$container_dir/$container_id"
  mkdir -p "$container_dir/$container_id"
  printf '%s\n' "$container_image" >"$container_dir/$container_id/image"
  printf '%s\n' "$container_running" >"$container_dir/$container_id/running"
  printf '%s\n' "$container_project" >"$container_dir/$container_id/project"
  printf '%s\n' "$container_service" >"$container_dir/$container_id/service"
  printf '%s\n' False >"$container_dir/$container_id/oneoff"
  node - \
    "$container_dir/$container_id/labels.json" \
    "$container_project" "$container_service" "$container_candidate_label" <<'NODE'
const fs = require("node:fs");
const [outputPath, project, service, candidate] = process.argv.slice(2);
const labels = {
  "com.docker.compose.project": project,
  "com.docker.compose.service": service,
  "com.docker.compose.oneoff": "False",
};
if (candidate !== "") {
  labels["ai.openclaw.verifier.gateway-candidate"] = candidate;
}
fs.writeFileSync(outputPath, JSON.stringify(labels));
NODE
}
record_image() {
  image_reference="$1"
  image_id="$2"
  image_registry_tmp="$image_registry.tmp.$$"
  awk -F '\t' -v reference="$image_reference" '$1 != reference { print }' \
    "$image_registry" >"$image_registry_tmp"
  printf '%s\t%s\n' "$image_reference" "$image_id" >>"$image_registry_tmp"
  mv "$image_registry_tmp" "$image_registry"
}
lookup_image() {
  image_reference="$1"
  if [[ "$image_reference" == sha256:* ]]; then
    printf '%s' "$image_reference"
    return
  fi
  awk -F '\t' -v reference="$image_reference" \
    '$1 == reference { value=$2 } END { if (value != "") print value }' "$image_registry"
}
remove_image() {
  image_reference="$1"
  image_registry_tmp="$image_registry.tmp.$$"
  if [[ "$image_reference" == sha256:* ]]; then
    awk -F '\t' -v image_id="$image_reference" '$2 != image_id { print }' \
      "$image_registry" >"$image_registry_tmp"
  else
    awk -F '\t' -v reference="$image_reference" '$1 != reference { print }' \
      "$image_registry" >"$image_registry_tmp"
  fi
  mv "$image_registry_tmp" "$image_registry"
}
substitute_verifier_path() {
  substitute_kind="\${DOCKER_STUB_SUBSTITUTE_KIND:-}"
  if [[ "$substitute_kind" == "parent" ]]; then
    substitute_parent="$(dirname "$DOCKER_STUB_SUBSTITUTE_PATH")"
    mv "$substitute_parent" "$DOCKER_STUB_SUBSTITUTE_DISPLACED_PARENT"
    mkdir -p "$substitute_parent"
    ln "$DOCKER_STUB_SUBSTITUTE_VICTIM" "$DOCKER_STUB_SUBSTITUTE_PATH"
  else
    rm -f "$DOCKER_STUB_SUBSTITUTE_PATH"
  fi
  if [[ "$substitute_kind" == "symlink" ]]; then
    ln -s "$DOCKER_STUB_SUBSTITUTE_VICTIM" "$DOCKER_STUB_SUBSTITUTE_PATH"
  elif [[ "$substitute_kind" == "dangling-symlink" ]]; then
    ln -s "$DOCKER_STUB_SUBSTITUTE_VICTIM.missing" "$DOCKER_STUB_SUBSTITUTE_PATH"
  elif [[ "$substitute_kind" == "hardlink" ]]; then
    ln "$DOCKER_STUB_SUBSTITUTE_VICTIM" "$DOCKER_STUB_SUBSTITUTE_PATH"
  elif [[ "$substitute_kind" == "fifo" ]]; then
    mkfifo "$DOCKER_STUB_SUBSTITUTE_PATH"
  elif [[ "$substitute_kind" == "parent" ]]; then
    :
  else
    exit 1
  fi
}
if [[ "\${1:-}" == "compose" && "\${2:-}" == "version" ]]; then
  exit 0
fi
if [[ "\${1:-}" == "build" ]]; then
  if [[ "$*" == *":candidate-"* && -n "\${DOCKER_STUB_SUBSTITUTE_PATH:-}" ]]; then
    substitute_verifier_path
  fi
  if [[ "$*" == *":candidate-"* && -n "\${DOCKER_STUB_MUTATE_CONFIG_PATH:-}" ]]; then
    if [[ "\${DOCKER_STUB_MUTATE_CONFIG_KIND:-}" == "bytes" ]]; then
      printf '%s\n' '{"changed":true}' >"$DOCKER_STUB_MUTATE_CONFIG_PATH"
    elif [[ "\${DOCKER_STUB_MUTATE_CONFIG_KIND:-}" == "mode" ]]; then
      chmod 600 "$DOCKER_STUB_MUTATE_CONFIG_PATH"
    else
      exit 1
    fi
  fi
  if [[ -n "$fail_match" && "$*" == *"$fail_match"* ]]; then
    echo "build-fail $*" >>"$log"
    exit 1
  fi
  echo "build DOCKER_BUILDKIT=\${DOCKER_BUILDKIT:-} $*" >>"$log"
  if [[ -n "$kill_parent_match" && "$*" == *"$kill_parent_match"* ]]; then
    echo "build-kill-parent $*" >>"$log"
    kill -KILL "$PPID"
    exit 137
  fi
  pending_tag=""
  for argument in "$@"; do
    if [[ -n "$pending_tag" ]]; then
      build_tag="$argument"
      pending_tag=""
    elif [[ "$argument" == "-t" || "$argument" == "--tag" ]]; then
      pending_tag="1"
      continue
    elif [[ "$argument" == --tag=* ]]; then
      build_tag="\${argument#--tag=}"
    else
      continue
    fi
    if [[ "$build_tag" == *":candidate-"* ]]; then
      record_image "$build_tag" "sha256:${"c".repeat(64)}"
    elif [[ "$build_tag" == *":published-"* ]]; then
      record_image "$build_tag" "sha256:${"e".repeat(64)}"
    else
      record_image "$build_tag" "sha256:${"a".repeat(64)}"
    fi
  done
  [[ -z "$pending_tag" ]] || exit 1
  if [[ -n "$fail_after_match" && "$*" == *"$fail_after_match"* ]]; then
    echo "build-fail-after $*" >>"$log"
    exit 1
  fi
  exit 0
fi
if [[ "\${1:-}" == "run" ]]; then
  echo "run $*" >>"$log"
  printf '%s\n' '{"status":"verified","dependencyManifestDigest":"${"1".repeat(64)}","browserManifestDigest":"${"2".repeat(64)}","toolchainDigest":"${"3".repeat(64)}","repositoryIdentityDigest":"${"4".repeat(64)}","browserIdentityDigest":"${"5".repeat(64)}","effectiveYarnVersion":"4.9.2"}'
  exit 0
fi
if [[ "\${1:-}" == "exec" && -n "$fail_match" && "$*" == *"$fail_match"* ]]; then
  echo "exec-fail $*" >>"$log"
  exit 1
fi
if [[ "\${1:-}" == "ps" ]]; then
  if [[ "$*" == *"-a -q --no-trunc"* && -n "\${DOCKER_STUB_CONSUMER_ID:-}" ]]; then
    printf '%s\n' "$DOCKER_STUB_CONSUMER_ID"
  fi
  exit 0
fi
if [[ "\${1:-}" == "stop" ]]; then
  gateway_id="\${!#}"
  echo "stop $gateway_id" >>"$log"
  if [[ -f "$container_dir/$gateway_id/running" ]]; then
    printf '%s\n' false >"$container_dir/$gateway_id/running"
  fi
  if [[ "$gateway_id" == "$(current_gateway_id)" ]]; then
    printf '%s\n' false >"$gateway_running_file"
  fi
  exit 0
fi
if [[ "\${1:-}" == "rm" ]]; then
  gateway_id="\${!#}"
  echo "rm $gateway_id" >>"$log"
  rm -rf "$container_dir/$gateway_id"
  if [[ "$gateway_id" == "$(current_gateway_id)" ]]; then
    rm -f "$gateway_id_file" "$gateway_running_file"
    touch "$gateway_absent_file"
  fi
  exit 0
fi
if [[ "\${1:-}" == "inspect" ]]; then
  inspected_id="\${!#}"
  if [[ "$*" == *"{{json .Mounts}}"* ]]; then
    if [[ -f "$image_dir/gateway-socket-source" ]]; then
      printf '[{"Type":"bind","Source":"%s","Destination":"/var/run/docker.sock","RW":true}]\n' \
        "$(cat "$image_dir/gateway-socket-source")"
    else
      printf '%s\n' '[]'
    fi
  elif [[ "$*" == *"State.Health"* ]]; then
    printf '%s\n' healthy
  elif [[ "$*" == *"{{.State.Running}}"* ]]; then
    running="$(container_field "$inspected_id" running)"
    if [[ -n "$running" ]]; then
      printf '%s\n' "$running"
    elif [[ "$inspected_id" == "$(current_gateway_id)" && -f "$gateway_running_file" ]]; then
      cat "$gateway_running_file"
    else
      printf '%s\n' true
    fi
  elif [[ "$*" == *"{{.Image}}"* ]]; then
    if [[ "$inspected_id" == "\${DOCKER_STUB_CONSUMER_ID:-}" &&
      -n "\${DOCKER_STUB_CONSUMER_IMAGE:-}" ]]; then
      printf '%s\n' "$DOCKER_STUB_CONSUMER_IMAGE"
    elif container_image="$(container_field "$inspected_id" image)" &&
      [[ -n "$container_image" ]]; then
      printf '%s\n' "$container_image"
    elif [[ -f "$image_dir/gateway-image" ]]; then
      cat "$image_dir/gateway-image"
    else
      printf '%s\n' "sha256:${"e".repeat(64)}"
    fi
  elif [[ "$*" == *"{{json .Config.Labels}}"* ]]; then
    if [[ -f "$container_dir/$inspected_id/labels-inspect-json" ]]; then
      cat "$container_dir/$inspected_id/labels-inspect-json"
    elif [[ -f "$container_dir/$inspected_id/labels.json" ]]; then
      cat "$container_dir/$inspected_id/labels.json"
    else
      node - \
        "\${DOCKER_STUB_COMPOSE_PROJECT:-openclaw}" \
        openclaw-gateway \
        "\${DOCKER_STUB_OLD_GATEWAY_CANDIDATE_LABEL:-}" <<'NODE'
const [project, service, candidate] = process.argv.slice(2);
const labels = {
  "com.docker.compose.project": project,
  "com.docker.compose.service": service,
  "com.docker.compose.oneoff": "False",
};
if (candidate !== "") {
  labels["ai.openclaw.verifier.gateway-candidate"] = candidate;
}
process.stdout.write(JSON.stringify(labels));
NODE
    fi
  fi
  exit 0
fi
if [[ "\${1:-}" == "exec" && "$*" == *"config get agents.defaults.sandbox.mode"* ]]; then
  printf '%s\n' non-main
  exit 0
fi
if [[ "\${1:-}" == "exec" && "$*" == *"config get agents.defaults.sandbox.scope"* ]]; then
  printf '%s\n' agent
  exit 0
fi
if [[ "\${1:-}" == "exec" && "$*" == *"config get agents.defaults.sandbox.workspaceAccess"* ]]; then
  printf '%s\n' none
  exit 0
fi
if [[ "\${1:-}" == "tag" ]]; then
  tag_source="$(lookup_image "$2")"
  [[ -n "$tag_source" ]] || exit 1
  record_image "$3" "$tag_source"
  if [[ -n "$fail_after_match" && "$*" == *"$fail_after_match"* ]]; then
    echo "tag-fail-after $*" >>"$log"
    exit 1
  fi
  exit 0
fi
if [[ "\${1:-}" == "image" ]]; then
  action="\${2:-}"
  reference="\${!#}"
  case "$action" in
    inspect)
      echo "image-inspect $*" >>"$log"
      value="$(lookup_image "$reference")"
      [[ -n "$value" ]] || exit 1
      if [[ "$*" == *"{{.Id}}"* ]]; then
        printf '%s\n' "$value"
      elif [[ "$*" == *"{{json .RootFS.Layers}}"* ]]; then
        printf '%s\n' '["sha256:${"f".repeat(64)}"]'
      fi
      exit 0
      ;;
    rm)
      if [[ -n "$fail_count_match" && "$*" == *"$fail_count_match"* ]]; then
        count_file="$failure_dir/count"
        count=0
        [[ ! -f "$count_file" ]] || count="$(cat "$count_file")"
        if [[ "$count" -lt "$fail_count_limit" ]]; then
          count=$((count + 1))
          printf '%s\n' "$count" >"$count_file"
          echo "image-rm-fail-count-$count $*" >>"$log"
          exit 1
        fi
      fi
      remove_image "$reference"
      exit 0
      ;;
  esac
fi
if [[ "\${1:-}" == "volume" ]]; then
  action="\${2:-}"
  volume_name="\${!#}"
  volume_dir="$DOCKER_STUB_VOLUME_DIR"
  mkdir -p "$volume_dir"
  case "$action" in
    create)
      printf '%s\n' "\${OPENCLAW_VERIFIER_TRANSACTION_ID:-}" >"$volume_dir/$volume_name"
      printf '%s\n' "$volume_name"
      exit 0
      ;;
    inspect)
      if [[ ! -f "$volume_dir/$volume_name" ]]; then
        exit 1
      fi
      if [[ "$*" == *"ai.openclaw.verifier.transaction"* ]]; then
        cat "$volume_dir/$volume_name"
      fi
      exit 0
      ;;
    rm)
      rm -f "$volume_dir/$volume_name"
      exit 0
      ;;
  esac
fi
if [[ "\${1:-}" == "compose" ]]; then
  if [[ -n "$fail_match" && "$*" == *"$fail_match"* ]]; then
    echo "compose-fail $*" >>"$log"
    exit 1
  fi
  echo "compose $*" >>"$log"
  compose_socket_source=""
  compose_candidate_label=""
  expect_compose_file=""
  for argument in "$@"; do
    if [[ -n "$expect_compose_file" ]]; then
      [[ -f "$argument" ]] || {
        echo "compose-missing-file $argument" >>"$log"
        exit 1
      }
      if grep -Fq "target: /var/run/docker.sock" "$argument" &&
        grep -Fq "$OPENCLAW_DOCKER_SOCKET" "$argument"; then
        compose_socket_source="$OPENCLAW_DOCKER_SOCKET"
      fi
      candidate_label="$(
        sed -n \
          's/^[[:space:]]*ai\\.openclaw\\.verifier\\.gateway-candidate:[[:space:]]*"\\([a-f0-9]\\{64\\}\\)"[[:space:]]*$/\\1/p' \
          "$argument"
      )"
      if [[ -n "$candidate_label" ]]; then
        if [[ -n "$compose_candidate_label" ]]; then
          compose_candidate_label="$compose_candidate_label|$candidate_label"
        else
          compose_candidate_label="$candidate_label"
        fi
      fi
      expect_compose_file=""
    elif [[ "$argument" == "-f" ]]; then
      expect_compose_file="1"
    fi
  done
  [[ -z "$expect_compose_file" ]] || exit 1
  if [[ -n "\${DOCKER_STUB_SUBSTITUTE_BEFORE_BACKUP:-}" &&
    "$*" == *"--entrypoint docker openclaw-gateway --version"* ]]; then
    substitute_verifier_path
  fi
  if [[ "$*" == *" config --format json"* ]]; then
    read_only="\${DOCKER_STUB_CONFIG_READ_ONLY:-false}"
    printf '{"name":"%s","services":{"openclaw-gateway":{"labels":{"ai.openclaw.verifier.gateway-candidate":"%s"},"volumes":[{"type":"bind","source":"%s","read_only":%s},{"type":"bind","source":"%s","read_only":%s}]}}}\n' \
      "\${DOCKER_STUB_COMPOSE_PROJECT:-openclaw}" \
      "$compose_candidate_label" \
      "$OPENCLAW_CONFIG_DIR" "$read_only" "$OPENCLAW_WORKSPACE_DIR" "$read_only"
    exit 0
  fi
  if [[ "$*" == *"dist/index.js config get gateway.mode"* ]]; then
    printf '%s\n' "\${DOCKER_STUB_CONFIG_MODE:-local}"
    exit 0
  fi
  if [[ "$*" == *"dist/index.js config get gateway.bind"* ]]; then
    printf '%s\n' "\${DOCKER_STUB_CONFIG_BIND:-\${OPENCLAW_GATEWAY_BIND:-lan}}"
    exit 0
  fi
  if [[ "$*" == *"dist/index.js config get agents.defaults.sandbox.mode"* ]]; then
    printf '%s\n' "\${DOCKER_STUB_SANDBOX_MODE:-non-main}"
    exit 0
  fi
  if [[ "$*" == *"dist/index.js config get agents.defaults.sandbox.scope"* ]]; then
    printf '%s\n' "\${DOCKER_STUB_SANDBOX_SCOPE:-agent}"
    exit 0
  fi
  if [[ "$*" == *"dist/index.js config get agents.defaults.sandbox.workspaceAccess"* ]]; then
    printf '%s\n' "\${DOCKER_STUB_SANDBOX_WORKSPACE_ACCESS:-none}"
    exit 0
  fi
  if [[ "$*" == *"config set --batch-json"* && "$*" == *"agents.defaults.sandbox.mode"* ]]; then
    mkdir -p "$OPENCLAW_CONFIG_DIR"
    printf '%s\n' '{"agents":{"defaults":{"sandbox":{"mode":"non-main","scope":"agent","workspaceAccess":"none"}}}}' \
      >"$OPENCLAW_CONFIG_DIR/openclaw.json"
  fi
  if [[ "$*" == *" up -d "* && "$*" == *"openclaw-gateway"* && -n "\${OPENCLAW_IMAGE:-}" ]]; then
    gateway_image="$(lookup_image "$OPENCLAW_IMAGE")"
    gateway_image="\${gateway_image:-$OPENCLAW_IMAGE}"
    gateway_id="${"d".repeat(64)}"
    record_gateway_container \
      "$gateway_id" "$gateway_image" true \
      "\${DOCKER_STUB_COMPOSE_PROJECT:-openclaw}" openclaw-gateway \
      "$compose_candidate_label"
    printf '%s\n' "$gateway_image" >"$image_dir/gateway-image"
    printf '%s\n' "$gateway_id" >"$gateway_id_file"
    printf '%s\n' true >"$gateway_running_file"
    rm -f "$gateway_absent_file"
  fi
  if [[ "$*" == *" create "* && "$*" == *"openclaw-gateway"* && -n "\${OPENCLAW_IMAGE:-}" ]]; then
    gateway_image="$(lookup_image "$OPENCLAW_IMAGE")"
    gateway_image="\${gateway_image:-$OPENCLAW_IMAGE}"
    gateway_id="${"d".repeat(64)}"
    record_gateway_container \
      "$gateway_id" "$gateway_image" false \
      "\${DOCKER_STUB_COMPOSE_PROJECT:-openclaw}" openclaw-gateway \
      "$compose_candidate_label"
    printf '%s\n' "$gateway_image" >"$image_dir/gateway-image"
    printf '%s\n' "$gateway_id" >"$gateway_id_file"
    printf '%s\n' false >"$gateway_running_file"
    rm -f "$gateway_absent_file"
  fi
  if [[ "$*" == *" up -d --no-deps --force-recreate openclaw-gateway"* ]]; then
    if [[ -n "$compose_socket_source" &&
      -z "\${DOCKER_STUB_IGNORE_SOCKET_OVERLAY:-}" ]]; then
      printf '%s\n' "$compose_socket_source" >"$image_dir/gateway-socket-source"
    else
      rm -f "$image_dir/gateway-socket-source"
    fi
  fi
  if [[ "$*" == *" ps -a -q --no-trunc openclaw-gateway"* ||
    "$*" == *" ps -a -q openclaw-gateway"* ]]; then
    if [[ -n "\${DOCKER_STUB_GATEWAY_SERVICE_IDS:-}" ]]; then
      printf '%b\n' "$DOCKER_STUB_GATEWAY_SERVICE_IDS"
    else
      current_gateway_id
      [[ -z "$(current_gateway_id)" ]] || printf '\n'
    fi
  elif [[ "$*" == *" ps -q openclaw-gateway"* ]]; then
    current_id="$(current_gateway_id)"
    running="\${DOCKER_STUB_OLD_GATEWAY_RUNNING:-false}"
    [[ ! -f "$gateway_running_file" ]] || running="$(cat "$gateway_running_file")"
    if [[ -n "$current_id" && "$running" == "true" ]]; then
      printf '%s\n' "$current_id"
    fi
  fi
  if [[ "$*" == *"run --rm --no-deps openclaw-verifier-bootstrap"* ]]; then
    printf '%s\n' '{"status":"prepared","dependencyManifestDigest":"${"1".repeat(64)}","browserManifestDigest":"${"2".repeat(64)}","toolchainDigest":"${"3".repeat(64)}"}'
  fi
  if [[ -n "$fail_after_match" && "$*" == *"$fail_after_match"* ]]; then
    echo "compose-fail-after $*" >>"$log"
    exit 1
  fi
  if [[ -n "$kill_parent_match" && "$*" == *"$kill_parent_match"* ]]; then
    echo "compose-kill-parent $*" >>"$log"
    kill -KILL "$PPID"
    exit 137
  fi
  exit 0
fi
echo "unknown $*" >>"$log"
exit 0
`;

  await mkdir(binDir, { recursive: true });
  await writeFile(join(binDir, "docker"), stub, { mode: 0o755 });
  await writeFile(
    join(binDir, "git"),
    `#!/usr/bin/env sh
if [ "$1" = "-C" ] && [ "$3" = "rev-parse" ]; then
  printf '%s\n' "\${GIT_STUB_REVISION:-${"a".repeat(40)}}"
  exit 0
fi
if [ "$1" = "-C" ] && [ "$3" = "status" ]; then
  if [ -n "\${GIT_STUB_DIRTY:-}" ]; then
    printf '%s\n' " M guarded-verifier-draft"
  fi
  exit 0
fi
exit 1
`,
    { mode: 0o755 },
  );
  await writeFile(logPath, "");
}

async function createDockerSetupSandbox(): Promise<DockerSetupSandbox> {
  const tracker = requireSandboxRootTracker();
  const rootDir = await tracker.make("suite");
  const stateRoot = await tracker.make("state");
  const scriptPath = join(rootDir, "scripts", "docker", "setup.sh");
  const dockerfilePath = join(rootDir, "Dockerfile");
  const composePath = join(rootDir, "docker-compose.yml");
  const verifierComposePath = join(rootDir, "docker-compose.verifier.yml");
  const binDir = join(rootDir, "bin");
  const logPath = join(rootDir, "docker-stub.log");

  await mkdir(join(rootDir, "scripts", "docker"), { recursive: true });
  await copyFile(join(repoRoot, "scripts", "docker", "setup.sh"), scriptPath);
  await chmod(scriptPath, 0o755);
  await writeFile(dockerfilePath, "FROM scratch\n");
  await writeFile(join(rootDir, "package.json"), JSON.stringify({ packageManager: "yarn@4.9.2" }));
  await writeFile(
    composePath,
    "services:\n  openclaw-gateway:\n    image: noop\n  openclaw-cli:\n    image: noop\n",
  );
  await copyFile(join(repoRoot, "docker-compose.verifier.yml"), verifierComposePath);
  await copyFile(
    join(repoRoot, "Dockerfile.sandbox-verifier"),
    join(rootDir, "Dockerfile.sandbox-verifier"),
  );
  await copyFile(
    join(repoRoot, "Dockerfile.sandbox-verifier-publish"),
    join(rootDir, "Dockerfile.sandbox-verifier-publish"),
  );
  await writeDockerStub(binDir, logPath);

  return { rootDir, stateRoot, scriptPath, logPath, binDir };
}

type SandboxRootTracker = ReturnType<
  typeof import("./test-helpers/temp-dir.js").createSuiteTempRootTracker
>;
let sandboxRootTracker: SandboxRootTracker | null = null;
let verifierSocketSequence = 0;
const verifierSocketPaths = new Map<string, string>();

function requireSandboxRootTracker(): SandboxRootTracker {
  if (!sandboxRootTracker) {
    throw new Error("sandbox root tracker missing");
  }
  return sandboxRootTracker;
}

function createEnv(
  sandbox: DockerSetupSandbox,
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: `${sandbox.binDir}:${process.env.PATH ?? ""}`,
    HOME: process.env.HOME ?? sandbox.rootDir,
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    TMPDIR: process.env.TMPDIR,
    XDG_STATE_HOME: join(sandbox.stateRoot, "operator-state"),
    DOCKER_STUB_LOG: sandbox.logPath,
    DOCKER_STUB_VOLUME_DIR: join(sandbox.rootDir, "docker-volumes"),
    DOCKER_STUB_IMAGE_DIR: join(sandbox.rootDir, "docker-images"),
    DOCKER_STUB_FAILURE_DIR: join(sandbox.rootDir, "docker-failures"),
    OPENCLAW_GATEWAY_TOKEN: "test-token",
    OPENCLAW_SOURCE_REVISION: "a".repeat(40),
    OPENCLAW_CONFIG_DIR: join(sandbox.rootDir, "config"),
    OPENCLAW_WORKSPACE_DIR: join(sandbox.rootDir, "openclaw"),
    OPENCLAW_SANDBOX: "",
    OPENCLAW_VERIFIER_WORKSPACE_DIR: "",
    OPENCLAW_VERIFIER_GATEWAY_WORKSPACE: "",
    OPENCLAW_VERIFIER_PACKAGE_MANAGER: "",
    OPENCLAW_VERIFIER_IMAGE_ID: "",
    OPENCLAW_VERIFIER_ARTIFACT_DIGEST: "",
    OPENCLAW_VERIFIER_DEPENDENCY_MANIFEST: "",
    OPENCLAW_VERIFIER_BROWSER_MANIFEST: "",
    OPENCLAW_VERIFIER_REPOSITORY_IDENTITY: "",
    OPENCLAW_VERIFIER_BROWSER_IDENTITY: "",
    OPENCLAW_VERIFIER_EFFECTIVE_YARN_VERSION: "",
  };

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
  return env;
}

function requireSandbox(sandbox: DockerSetupSandbox | null): DockerSetupSandbox {
  if (!sandbox) {
    throw new Error("sandbox missing");
  }
  return sandbox;
}

function runDockerSetup(
  sandbox: DockerSetupSandbox,
  overrides: Record<string, string | undefined> = {},
) {
  return spawnSync("bash", [sandbox.scriptPath], {
    cwd: sandbox.rootDir,
    env: createEnv(sandbox, overrides),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

type DockerSetupRunResult = {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: Error;
};

function runDockerSetupAsync(
  sandbox: DockerSetupSandbox,
  overrides: Record<string, string | undefined> = {},
): Promise<DockerSetupRunResult> {
  const child = spawn("bash", [sandbox.scriptPath], {
    cwd: sandbox.rootDir,
    detached: process.platform !== "win32",
    env: createEnv(sandbox, overrides),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });

  return new Promise((resolve) => {
    let spawnError: Error | undefined;
    let settled = false;
    const deadline = setTimeout(() => {
      stderr += "\nDocker setup test exceeded its 30-second hard deadline.\n";
      if (process.platform !== "win32" && child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      } else {
        child.kill("SIGKILL");
      }
    }, 30_000);
    const finish = (status: number | null, signal: NodeJS.Signals | null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(deadline);
      resolve({ status, signal, stdout, stderr, error: spawnError });
    };
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", finish);
  });
}

async function runVerifierDockerSetup(
  sandbox: DockerSetupSandbox,
  overrides: Record<string, string | undefined>,
) {
  let socketPath = verifierSocketPaths.get(sandbox.stateRoot);
  if (!socketPath) {
    verifierSocketSequence += 1;
    socketPath = `/tmp/openclaw-verifier-${process.pid}-${verifierSocketSequence}.sock`;
    verifierSocketPaths.set(sandbox.stateRoot, socketPath);
  }
  return withUnixSocket(socketPath, async () =>
    runDockerSetupAsync(sandbox, {
      ...overrides,
      OPENCLAW_DOCKER_SOCKET: socketPath,
    }),
  );
}

async function prepareReadOnlyVerifierFixture(
  sandbox: DockerSetupSandbox,
  configOverrides: {
    mode?: string;
    bind?: string;
    sandboxMode?: string;
    sandboxScope?: string;
    workspaceAccess?: string;
    token?: string;
  } = {},
) {
  const configDir = join(sandbox.rootDir, "protected-config");
  const workspaceDir = join(sandbox.rootDir, "protected-workspace");
  const configPath = join(configDir, "openclaw.json");
  const flagStatPath = join(sandbox.binDir, "protected-config-stat");
  await mkdir(join(configDir, "ssh"), { recursive: true });
  await mkdir(workspaceDir, { recursive: true });
  await writeFile(
    flagStatPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.length !== 3 || args[0] !== "-f" || args[1] !== "%d|%i|%Sf") {
  process.exit(2);
}
const value = fs.lstatSync(args[2], { bigint: true });
const missing =
  process.env.OPENCLAW_TEST_PROTECTED_CONFIG_FLAGS === "none" ||
  process.env.OPENCLAW_PROTECTED_CONFIG_FLAG_CHECK_LABEL ===
    process.env.OPENCLAW_TEST_REMOVE_UCHG_AT;
if (process.env.DOCKER_STUB_LOG) {
  fs.appendFileSync(
    process.env.DOCKER_STUB_LOG,
    \`flag-stat \${process.env.OPENCLAW_PROTECTED_CONFIG_FLAG_CHECK_LABEL ?? ""} \${missing ? "-" : "uchg"}\\n\`,
  );
}
process.stdout.write(\`\${value.dev}|\${value.ino}|\${missing ? "-" : "uchg"}\`);
`,
    { mode: 0o755 },
  );
  await writeFile(
    configPath,
    `${JSON.stringify({
      gateway: {
        mode: configOverrides.mode ?? "local",
        bind: configOverrides.bind ?? "lan",
        auth: { token: configOverrides.token ?? "protected-config-token" },
      },
      agents: {
        defaults: {
          sandbox: {
            mode: configOverrides.sandboxMode ?? "non-main",
            scope: configOverrides.sandboxScope ?? "agent",
            workspaceAccess: configOverrides.workspaceAccess ?? "none",
          },
        },
      },
    })}\n`,
    { mode: 0o640 },
  );
  return {
    configDir,
    configPath,
    workspaceDir,
    env: {
      OPENCLAW_SETUP_READ_ONLY_CONFIG: "1",
      OPENCLAW_CONFIG_DIR: configDir,
      OPENCLAW_WORKSPACE_DIR: workspaceDir,
      OPENCLAW_SANDBOX: "1",
      OPENCLAW_VERIFIER_WORKSPACE_DIR: sandbox.rootDir,
      OPENCLAW_VERIFIER_GATEWAY_WORKSPACE: "/workspace/project",
      OPENCLAW_VERIFIER_PACKAGE_MANAGER: "yarn@4.9.2",
      OPENCLAW_DOCKER_SETUP_TEST: "1",
      OPENCLAW_TEST_HOST_PLATFORM: "Darwin",
      OPENCLAW_TEST_PROTECTED_CONFIG_STAT_COMMAND: flagStatPath,
    },
  };
}

async function beginInterruptedReadOnlyVerifier(sandbox: DockerSetupSandbox) {
  const fixture = await prepareReadOnlyVerifierFixture(sandbox);
  const result = await runVerifierDockerSetup(sandbox, {
    ...fixture.env,
    DOCKER_STUB_KILL_PARENT_MATCH: ":candidate-",
  });
  const stateRoot = join(sandbox.stateRoot, "operator-state", "openclaw", "verifier");
  const markerName = `.openclaw-verifier-active-${createHash("sha256")
    .update(stateRoot)
    .digest("hex")}`;
  return {
    ...fixture,
    result,
    stateRoot,
    transactionRoot: join(stateRoot, "transaction"),
    journalPath: join(stateRoot, "transaction", "journal"),
    markerPath: join(dirname(stateRoot), markerName),
  };
}

async function beginInterruptedGatewayCreateIntent(sandbox: DockerSetupSandbox) {
  const fixture = await prepareReadOnlyVerifierFixture(sandbox);
  const priorGateway = "9".repeat(64);
  const priorImage = `sha256:${"8".repeat(64)}`;
  const candidateGateway = "d".repeat(64);
  const env = {
    ...fixture.env,
    OPENCLAW_GATEWAY_TOKEN: undefined,
    DOCKER_STUB_OLD_GATEWAY_ID: priorGateway,
    DOCKER_STUB_OLD_GATEWAY_IMAGE: priorImage,
    DOCKER_STUB_OLD_GATEWAY_RUNNING: "true",
  };
  const result = await runVerifierDockerSetup(sandbox, {
    ...env,
    DOCKER_STUB_KILL_PARENT_MATCH: "up -d --no-deps --force-recreate openclaw-gateway",
  });
  const stateRoot = join(sandbox.stateRoot, "operator-state", "openclaw", "verifier");
  return {
    ...fixture,
    result,
    env,
    priorGateway,
    priorImage,
    candidateGateway,
    transactionRoot: join(stateRoot, "transaction"),
    journalPath: join(stateRoot, "transaction", "journal"),
  };
}

async function replaceParentAtBackupBarrier(params: {
  readyPath: string;
  continuePath: string;
  displacedParent: string;
  target: string;
  victim: string;
}): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const barrierTarget = (await readFile(params.readyPath, "utf8")).trim();
      if (barrierTarget !== params.target) {
        throw new Error("Verifier backup barrier targeted an unexpected file.");
      }
      const parent = resolve(params.target, "..");
      await rename(parent, params.displacedParent);
      await mkdir(parent, { recursive: true });
      await link(params.victim, params.target);
      await writeFile(params.continuePath, "continue\n", { mode: 0o600 });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 2));
  }
  throw new Error("Timed out waiting for the verifier backup barrier.");
}

async function mutateAtRestoreJournalBarrier<T>(params: {
  readyPath: string;
  continuePath: string;
  mutate: (temporaryName: string) => Promise<T>;
}): Promise<{ temporaryName: string; value: T }> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    let temporaryName: string;
    try {
      temporaryName = (await readFile(params.readyPath, "utf8")).trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 2));
      continue;
    }
    if (!/^\.journal\.restore-[a-f0-9]{32}$/u.test(temporaryName)) {
      throw new Error("Verifier restore journal barrier returned an unsafe temporary name.");
    }
    try {
      return { temporaryName, value: await params.mutate(temporaryName) };
    } finally {
      await writeFile(params.continuePath, "continue\n", { mode: 0o600 });
    }
  }
  throw new Error("Timed out waiting for the verifier restore journal barrier.");
}

async function mutateAtStateRootBarrier<T>(params: {
  readyPath: string;
  continuePath: string;
  stateRoot: string;
  mutate: () => Promise<T>;
}): Promise<T> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    let barrierTarget: string;
    try {
      barrierTarget = (await readFile(params.readyPath, "utf8")).trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 2));
      continue;
    }
    if (barrierTarget !== params.stateRoot) {
      throw new Error("Verifier state-root barrier targeted an unexpected directory.");
    }
    try {
      return await params.mutate();
    } finally {
      await writeFile(params.continuePath, "continue\n", { mode: 0o600 });
    }
  }
  throw new Error("Timed out waiting for the verifier state-root barrier.");
}

async function mutateAtTransactionStateBarrier<T>(params: {
  readyPath: string;
  continuePath: string;
  phase: string;
  stateRoot: string;
  mutate: () => Promise<T>;
}): Promise<T> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    let barrierRecord: string;
    try {
      barrierRecord = (await readFile(params.readyPath, "utf8")).trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 2));
      continue;
    }
    if (barrierRecord !== `${params.phase}\t${params.stateRoot}`) {
      throw new Error("Verifier transaction-state barrier targeted unexpected state.");
    }
    try {
      return await params.mutate();
    } finally {
      await writeFile(params.continuePath, "continue\n", { mode: 0o600 });
    }
  }
  throw new Error("Timed out waiting for the verifier transaction-state barrier.");
}

async function resetDockerLog(sandbox: DockerSetupSandbox) {
  await writeFile(sandbox.logPath, "");
}

async function resetSharedDockerSetupFixture(sandbox: DockerSetupSandbox) {
  await Promise.all(
    [
      ".env",
      "docker-compose.extra.yml",
      "docker-compose.sandbox.yml",
      "docker-images",
      "docker-failures",
      "docker-volumes",
      "config",
      "openclaw",
    ].map((entry) => rm(join(sandbox.rootDir, entry), { recursive: true, force: true })),
  );
  await writeDockerStub(sandbox.binDir, sandbox.logPath);
}

function dockerStubContainerPath(sandbox: DockerSetupSandbox, containerId: string) {
  return join(sandbox.rootDir, "docker-images", "containers", containerId);
}

async function writeDockerStubContainer(
  sandbox: DockerSetupSandbox,
  containerId: string,
  fields: {
    image: string;
    running: boolean;
    project: string;
    service: string;
    candidateLabel?: string;
  },
) {
  const containerPath = dockerStubContainerPath(sandbox, containerId);
  await rm(containerPath, { recursive: true, force: true });
  await mkdir(containerPath, { recursive: true });
  await Promise.all([
    writeFile(join(containerPath, "image"), `${fields.image}\n`),
    writeFile(join(containerPath, "running"), `${fields.running}\n`),
    writeFile(join(containerPath, "project"), `${fields.project}\n`),
    writeFile(join(containerPath, "service"), `${fields.service}\n`),
    writeFile(join(containerPath, "oneoff"), "False\n"),
    writeFile(
      join(containerPath, "labels.json"),
      JSON.stringify({
        "com.docker.compose.project": fields.project,
        "com.docker.compose.service": fields.service,
        "com.docker.compose.oneoff": "False",
        ...(fields.candidateLabel === undefined
          ? {}
          : { "ai.openclaw.verifier.gateway-candidate": fields.candidateLabel }),
      }),
    ),
  ]);
}

async function setDockerStubCurrentGateway(
  sandbox: DockerSetupSandbox,
  containerId: string,
  image: string,
  running: boolean,
) {
  const imageDir = join(sandbox.rootDir, "docker-images");
  await Promise.all([
    writeFile(join(imageDir, "gateway-id"), `${containerId}\n`),
    writeFile(join(imageDir, "gateway-image"), `${image}\n`),
    writeFile(join(imageDir, "gateway-running"), `${running}\n`),
    rm(join(imageDir, "gateway-absent"), { force: true }),
  ]);
}

async function readDockerLog(sandbox: DockerSetupSandbox) {
  return readFile(sandbox.logPath, "utf8");
}

async function readDockerLogLines(sandbox: DockerSetupSandbox) {
  return (await readDockerLog(sandbox)).split("\n").filter(Boolean);
}

async function rewriteJournalValues(
  journalPath: string,
  replacements: Record<string, string>,
): Promise<void> {
  const lines = (await readFile(journalPath, "utf8")).split("\n");
  if (lines.at(-1) !== "") {
    throw new Error("test journal is not newline terminated");
  }
  lines.pop();
  const remaining = new Set(Object.keys(replacements));
  const rewritten = lines.map((line) => {
    const separator = line.indexOf("=");
    const key = separator < 0 ? "" : line.slice(0, separator);
    if (!remaining.delete(key)) {
      return line;
    }
    return `${key}=${replacements[key]}`;
  });
  if (remaining.size > 0) {
    throw new Error(`test journal lacks keys: ${[...remaining].join(", ")}`);
  }
  await writeFile(journalPath, `${rewritten.join("\n")}\n`);
}

async function removeJournalKeys(journalPath: string, keys: string[]): Promise<void> {
  const removeKeys = new Set(keys);
  const lines = (await readFile(journalPath, "utf8")).split("\n");
  if (lines.at(-1) !== "") {
    throw new Error("test journal is not newline terminated");
  }
  lines.pop();
  await writeFile(
    journalPath,
    `${lines.filter((line) => !removeKeys.has(line.slice(0, line.indexOf("=")))).join("\n")}\n`,
  );
}

function readJournalValue(journal: string, key: string): string {
  const matches = journal
    .split("\n")
    .filter((line) => line.startsWith(`${key}=`))
    .map((line) => line.slice(key.length + 1));
  if (matches.length !== 1) {
    throw new Error(`test journal has an ambiguous ${key} value`);
  }
  return matches[0];
}

async function beginInterruptedVerifierTransaction(
  sandbox: DockerSetupSandbox,
  restoreKind: "env" | "config" = "env",
  verifierStateRootOverride?: string,
) {
  await writeFile(join(sandbox.rootDir, "Dockerfile.sandbox-verifier"), "FROM scratch\n");
  const configDir = join(sandbox.rootDir, "config");
  if (restoreKind === "config") {
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, "openclaw.json"), '{"before":true}\n', {
      mode: 0o640,
    });
  }
  const verifierEnv = {
    OPENCLAW_SANDBOX: "1",
    OPENCLAW_CONFIG_DIR: configDir,
    OPENCLAW_VERIFIER_WORKSPACE_DIR: sandbox.rootDir,
    OPENCLAW_VERIFIER_GATEWAY_WORKSPACE: "/workspace/project",
    OPENCLAW_VERIFIER_PACKAGE_MANAGER: "yarn@4.9.2",
    OPENCLAW_VERIFIER_STATE_ROOT: verifierStateRootOverride,
  };
  const interrupted = await runVerifierDockerSetup(sandbox, {
    ...verifierEnv,
    DOCKER_STUB_KILL_PARENT_MATCH: ":candidate-",
  });
  const verifierStateRoot =
    verifierStateRootOverride ?? join(sandbox.stateRoot, "operator-state", "openclaw", "verifier");
  return {
    interrupted,
    verifierEnv,
    verifierStateRoot,
    transactionRoot: join(verifierStateRoot, "transaction"),
    journalPath: join(verifierStateRoot, "transaction", "journal"),
    restoreKind,
    targetPath:
      restoreKind === "env" ? join(sandbox.rootDir, ".env") : join(configDir, "openclaw.json"),
    backupPath: join(
      verifierStateRoot,
      "transaction",
      restoreKind === "env" ? "env.backup" : "config.backup",
    ),
  };
}

async function createShortVerifierStateRoot(): Promise<string> {
  const requestedParent = await mkdtemp("/tmp/oc-");
  const stateParent = await realpath(requestedParent);
  await chmod(stateParent, 0o700);
  const stateRoot = join(stateParent, "v");
  await mkdir(stateRoot, { mode: 0o700 });
  onTestFinished(async () => {
    await rm(stateParent, { recursive: true, force: true });
  });
  return stateRoot;
}

type ActiveStateMarker = {
  contractVersion: 2;
  markerState: "active" | "cleanup";
  statePath: string;
  stateDev: string;
  stateIno: string;
  parentDev: string;
  parentIno: string;
  stateTokenDigest: string;
  operationId: string;
  operationBinding: string;
};

function stateOperationBinding(stateTokenDigest: string, operationId: string): string {
  return createHash("sha256").update(`${stateTokenDigest}\0${operationId}`).digest("hex");
}

async function createActiveStateMarkerFixture() {
  const sandbox = await createDockerSetupSandbox();
  await writeFile(join(sandbox.rootDir, "Dockerfile.sandbox-verifier"), "FROM scratch\n");
  const envPath = join(sandbox.rootDir, ".env");
  const envBefore = "PRESERVED_ACTIVE_MARKER_STATE=1\n";
  await writeFile(envPath, envBefore, { mode: 0o600 });
  const stateRoot = await createShortVerifierStateRoot();
  const stateParent = dirname(stateRoot);
  const token = "1".repeat(64);
  const tokenPath = join(stateRoot, ".state-instance");
  await writeFile(tokenPath, `${token}\n`, { mode: 0o600 });
  const stateIdentity = await stat(stateRoot);
  const parentIdentity = await stat(stateParent);
  const stateTokenDigest = createHash("sha256").update(token).digest("hex");
  const operationId = "2".repeat(32);
  const marker: ActiveStateMarker = {
    contractVersion: 2,
    markerState: "active",
    statePath: stateRoot,
    stateDev: String(stateIdentity.dev),
    stateIno: String(stateIdentity.ino),
    parentDev: String(parentIdentity.dev),
    parentIno: String(parentIdentity.ino),
    stateTokenDigest,
    operationId,
    operationBinding: stateOperationBinding(stateTokenDigest, operationId),
  };
  const markerName = `.openclaw-verifier-active-${createHash("sha256")
    .update(stateRoot)
    .digest("hex")}`;
  const markerPath = join(stateParent, markerName);
  await writeFile(markerPath, `${JSON.stringify(marker)}\n`, { mode: 0o600 });
  const verifierEnv = {
    OPENCLAW_SANDBOX: "1",
    OPENCLAW_CONFIG_DIR: join(sandbox.rootDir, "config"),
    OPENCLAW_VERIFIER_WORKSPACE_DIR: sandbox.rootDir,
    OPENCLAW_VERIFIER_GATEWAY_WORKSPACE: "/workspace/project",
    OPENCLAW_VERIFIER_PACKAGE_MANAGER: "yarn@4.9.2",
    OPENCLAW_VERIFIER_STATE_ROOT: stateRoot,
  };
  return {
    envBefore,
    envPath,
    marker,
    markerPath,
    sandbox,
    stateParent,
    stateRoot,
    token,
    tokenPath,
    verifierEnv,
  };
}

async function expectActiveStateMarkerRejection(
  fixture: Awaited<ReturnType<typeof createActiveStateMarkerFixture>>,
  overrides: Record<string, string | undefined> = {},
) {
  await resetDockerLog(fixture.sandbox);
  const result = await runVerifierDockerSetup(fixture.sandbox, {
    ...fixture.verifierEnv,
    ...overrides,
  });
  expect(result.status).not.toBe(0);
  expect(await readFile(fixture.envPath, "utf8")).toBe(fixture.envBefore);
  const log = await readDockerLog(fixture.sandbox);
  expect(log).not.toContain("build ");
  expect(log).not.toContain(" config set ");
  expect(log).not.toContain(" up -d");
  return result;
}

function isGatewayStartLine(line: string) {
  return line.includes("compose") && line.includes(" up -d") && line.includes("openclaw-gateway");
}

function findGatewayStartLineIndex(lines: string[]) {
  return lines.findIndex((line) => isGatewayStartLine(line));
}

async function runDockerSetupWithUnsetGatewayToken(
  sandbox: DockerSetupSandbox,
  suffix: string,
  prepare?: (configDir: string) => Promise<void>,
) {
  const configDir = join(sandbox.rootDir, `config-${suffix}`);
  const workspaceDir = join(sandbox.rootDir, `workspace-${suffix}`);
  await mkdir(configDir, { recursive: true });
  await prepare?.(configDir);

  const result = runDockerSetup(sandbox, {
    OPENCLAW_GATEWAY_TOKEN: undefined,
    OPENCLAW_CONFIG_DIR: configDir,
    OPENCLAW_WORKSPACE_DIR: workspaceDir,
  });
  const envFile = await readFile(join(sandbox.rootDir, ".env"), "utf8");

  return { result, envFile };
}

async function withUnixSocket<T>(socketPath: string, run: () => Promise<T>): Promise<T> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  });

  try {
    return await run();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(socketPath, { force: true });
  }
}

function resolveBashForCompatCheck(): string | null {
  for (const candidate of ["/bin/bash", "bash"]) {
    const probe = spawnSync(candidate, ["-c", "exit 0"], { encoding: "utf8" });
    if (!probe.error && probe.status === 0) {
      return candidate;
    }
  }

  return null;
}

describe("scripts/docker/setup.sh", () => {
  let sandbox: DockerSetupSandbox | null = null;

  beforeAll(async () => {
    const { createSuiteTempRootTracker } = await import("./test-helpers/temp-dir.js");
    const tracker = createSuiteTempRootTracker({ prefix: "openclaw-docker-setup-" });
    sandboxRootTracker = tracker;
    await tracker.setup();
    sandbox = await createDockerSetupSandbox();
  });

  afterAll(async () => {
    const tracker = sandboxRootTracker;
    sandboxRootTracker = null;
    if (!tracker) {
      return;
    }
    if (!sandbox) {
      await tracker.cleanup();
      return;
    }
    await rm(sandbox.rootDir, { recursive: true, force: true });
    await tracker.cleanup();
    sandbox = null;
  });

  it("handles env defaults, home-volume mounts, and Docker build args", async () => {
    const activeSandbox = requireSandbox(sandbox);

    const result = runDockerSetup(activeSandbox, {
      OPENCLAW_DOCKER_APT_PACKAGES: "ffmpeg build-essential",
      OPENCLAW_EXTRA_MOUNTS: undefined,
      OPENCLAW_HOME_VOLUME: "openclaw-home",
    });
    expect(result.status).toBe(0);
    const envFile = await readFile(join(activeSandbox.rootDir, ".env"), "utf8");
    expect(envFile).toContain("OPENCLAW_DOCKER_APT_PACKAGES=ffmpeg build-essential");
    expect(envFile).toContain("OPENCLAW_INSTALL_BROWSER=1");
    expect(envFile).toContain("OPENCLAW_EXTRA_MOUNTS=");
    expect(envFile).toContain("OPENCLAW_HOME_VOLUME=openclaw-home"); // pragma: allowlist secret
    const extraCompose = await readFile(
      join(activeSandbox.rootDir, "docker-compose.extra.yml"),
      "utf8",
    );
    expect(extraCompose).toContain("openclaw-home:/home/node");
    expect(extraCompose).toContain("volumes:");
    expect(extraCompose).toContain("openclaw-home:");
    const log = await readDockerLog(activeSandbox);
    expect(log).toContain("--build-arg OPENCLAW_DOCKER_APT_PACKAGES=ffmpeg build-essential");
    expect(log).toContain("--build-arg OPENCLAW_INSTALL_BROWSER=1");
    expect(log).toContain(
      "run --rm --no-deps --entrypoint node openclaw-gateway dist/index.js onboard --mode local --no-install-daemon",
    );
    expect(log).toContain(
      'run --rm --no-deps --entrypoint node openclaw-gateway dist/index.js config set --batch-json [{"path":"gateway.mode","value":"local"},{"path":"gateway.bind","value":"lan"},{"path":"gateway.controlUi.allowedOrigins","value":["http://localhost:18789","http://127.0.0.1:18789"]}]',
    );
    expect(log).not.toContain("run --rm openclaw-cli onboard --mode local --no-install-daemon");
  });

  it("allows local Docker setup to opt out of the browser install layer", async () => {
    const activeSandbox = requireSandbox(sandbox);
    await resetDockerLog(activeSandbox);

    const result = runDockerSetup(activeSandbox, {
      OPENCLAW_INSTALL_BROWSER: "0",
    });

    expect(result.status).toBe(0);
    const envFile = await readFile(join(activeSandbox.rootDir, ".env"), "utf8");
    expect(envFile).toContain("OPENCLAW_INSTALL_BROWSER=");

    const log = await readDockerLog(activeSandbox);
    expect(log).toContain("--build-arg OPENCLAW_INSTALL_BROWSER=");
    expect(log).not.toContain("--build-arg OPENCLAW_INSTALL_BROWSER=1");
  });

  it("avoids shared-network openclaw-cli before the gateway is started", async () => {
    const activeSandbox = requireSandbox(sandbox);

    await resetDockerLog(activeSandbox);
    const result = runDockerSetup(activeSandbox);
    expect(result.status).toBe(0);

    const lines = await readDockerLogLines(activeSandbox);
    const gatewayStartIdx = findGatewayStartLineIndex(lines);
    expect(gatewayStartIdx).toBeGreaterThanOrEqual(0);

    const prestartLines = lines.slice(0, gatewayStartIdx);
    expect(prestartLines.some((line) => /\bcompose\b.*\brun\b.*\bopenclaw-cli\b/.test(line))).toBe(
      false,
    );
  });

  it("forces BuildKit for local and sandbox docker builds", async () => {
    const activeSandbox = requireSandbox(sandbox);
    await resetSharedDockerSetupFixture(activeSandbox);
    await writeFile(join(activeSandbox.rootDir, "Dockerfile.sandbox"), "FROM scratch\n");
    await writeFile(join(activeSandbox.rootDir, "Dockerfile.sandbox-verifier"), "FROM scratch\n");

    const result = await runVerifierDockerSetup(activeSandbox, {
      OPENCLAW_SANDBOX: "1",
      OPENCLAW_VERIFIER_WORKSPACE_DIR: activeSandbox.rootDir,
      OPENCLAW_VERIFIER_GATEWAY_WORKSPACE: "/workspace/project",
      OPENCLAW_VERIFIER_PACKAGE_MANAGER: "yarn@4.9.2",
    });

    const setupLog = await readDockerLog(activeSandbox);
    expect(result.status, `setup stderr:\n${result.stderr}\nDocker stub log:\n${setupLog}`).toBe(0);
    const buildLines = setupLog.split("\n").filter((line) => line.startsWith("build "));
    expect(buildLines.length).toBeGreaterThanOrEqual(2);
    expect(buildLines.every((line) => line.includes("DOCKER_BUILDKIT=1"))).toBe(true);
    expect(buildLines.some((line) => line.includes("openclaw-sandbox-verifier:candidate-"))).toBe(
      true,
    );
    expect(
      buildLines.some((line) => line.includes(`OPENCLAW_RUNTIME_IMAGE=sha256:${"a".repeat(64)}`)),
    ).toBe(true);
    const lines = setupLog.split("\n").filter(Boolean);
    expect(
      lines.some((line) => line.includes("type=image") && line.includes("verifier-verify")),
    ).toBe(true);
    expect(
      lines.some((line) => line.includes("up -d --no-deps --force-recreate openclaw-gateway")),
    ).toBe(true);
    const recreateLine = lines.find((line) =>
      line.includes("up -d --no-deps --force-recreate openclaw-gateway"),
    );
    expect(recreateLine).toContain(
      `-f ${join(activeSandbox.rootDir, "docker-compose.sandbox.yml")}`,
    );
    expect(
      await readFile(join(activeSandbox.rootDir, "docker-images", "gateway-image"), "utf8"),
    ).toBe(`sha256:${"a".repeat(64)}\n`);
    await expect(
      stat(join(activeSandbox.stateRoot, "operator-state", "openclaw", "verifier", "transaction")),
    ).rejects.toThrow();
  });

  it("keeps protected existing-config mode default-off and rejects invalid values", async () => {
    const normal = await createDockerSetupSandbox();
    const defaultResult = runDockerSetup(normal);
    expect(defaultResult.status).toBe(0);
    expect(await readDockerLog(normal)).toContain(" onboard --mode local ");

    const explicitlyFalse = await createDockerSetupSandbox();
    const falseResult = runDockerSetup(explicitlyFalse, {
      OPENCLAW_SETUP_READ_ONLY_CONFIG: "0",
    });
    expect(falseResult.status).toBe(0);
    expect(await readDockerLog(explicitlyFalse)).toContain(" config set --batch-json ");

    const invalid = await createDockerSetupSandbox();
    const invalidResult = runDockerSetup(invalid, {
      OPENCLAW_SETUP_READ_ONLY_CONFIG: "sometimes",
    });
    expect(invalidResult.status).not.toBe(0);
    expect(invalidResult.stderr).toContain(
      "OPENCLAW_SETUP_READ_ONLY_CONFIG must be a boolean value",
    );
  });

  it.each(["1", "true", "yes", "on"])(
    "accepts protected existing-config truthy value %s only with verifier publication",
    async (value) => {
      const isolated = await createDockerSetupSandbox();
      const fixture = await prepareReadOnlyVerifierFixture(isolated);
      const result = await runVerifierDockerSetup(isolated, {
        ...fixture.env,
        OPENCLAW_SETUP_READ_ONLY_CONFIG: value,
      });
      expect(result.status, result.stderr).toBe(0);
    },
  );

  it("requires verifier publication whenever protected existing-config mode is enabled", async () => {
    const isolated = await createDockerSetupSandbox();
    const fixture = await prepareReadOnlyVerifierFixture(isolated);
    const result = runDockerSetup(isolated, {
      ...fixture.env,
      OPENCLAW_SANDBOX: "",
      OPENCLAW_VERIFIER_WORKSPACE_DIR: "",
      OPENCLAW_VERIFIER_GATEWAY_WORKSPACE: "",
      OPENCLAW_VERIFIER_PACKAGE_MANAGER: "",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("requires guarded verifier publication");
    expect(await readDockerLog(isolated)).not.toContain(" up -d ");
  });

  it("lets an explicit process false override a persisted protected-config true", async () => {
    const isolated = await createDockerSetupSandbox();
    await writeFile(join(isolated.rootDir, ".env"), "OPENCLAW_SETUP_READ_ONLY_CONFIG=1\n", {
      mode: 0o600,
    });
    const result = runDockerSetup(isolated, {
      OPENCLAW_SETUP_READ_ONLY_CONFIG: "0",
    });
    expect(result.status).toBe(0);
    expect(await readFile(join(isolated.rootDir, ".env"), "utf8")).toContain(
      "OPENCLAW_SETUP_READ_ONLY_CONFIG=0",
    );
    expect(await readDockerLog(isolated)).toContain(" onboard --mode local ");
  });

  it.each([
    { kind: "missing", expected: "capture failed" },
    { kind: "malformed", expected: "policy validation failed" },
    { kind: "symlink", expected: "capture failed" },
    { kind: "hardlink", expected: "capture failed" },
    { kind: "special", expected: "capture failed" },
    { kind: "unreadable", expected: "capture failed" },
  ])("rejects a $kind protected config before setup mutation", async ({ kind, expected }) => {
    const isolated = await createDockerSetupSandbox();
    const fixture = await prepareReadOnlyVerifierFixture(isolated);
    const victim = join(isolated.rootDir, `protected-config-${kind}-victim`);
    if (kind === "missing") {
      await rm(fixture.configPath);
    } else if (kind === "malformed") {
      await writeFile(fixture.configPath, "{\n");
    } else if (kind === "symlink") {
      await writeFile(victim, '{"victim":true}\n');
      await rm(fixture.configPath);
      await symlink(victim, fixture.configPath);
    } else if (kind === "hardlink") {
      await writeFile(victim, '{"victim":true}\n');
      await rm(fixture.configPath);
      await link(victim, fixture.configPath);
    } else if (kind === "special") {
      await rm(fixture.configPath);
      await mkdir(fixture.configPath);
    } else {
      await chmod(fixture.configPath, 0o000);
    }
    const result = await runVerifierDockerSetup(isolated, fixture.env);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(expected);
    const log = await readDockerLog(isolated);
    expect(log).not.toContain("build ");
    expect(log).not.toContain(" up -d ");
  });

  it.each([
    { field: "mode", overrides: { mode: "remote" } },
    { field: "bind", overrides: { bind: "loopback" } },
    { field: "sandbox mode", overrides: { sandboxMode: "off" } },
    { field: "sandbox scope", overrides: { sandboxScope: "session" } },
    { field: "workspace access", overrides: { workspaceAccess: "rw" } },
  ])("rejects an exact protected $field mismatch", async ({ overrides }) => {
    const isolated = await createDockerSetupSandbox();
    const fixture = await prepareReadOnlyVerifierFixture(isolated, overrides);
    const result = await runVerifierDockerSetup(isolated, fixture.env);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("policy validation failed");
    expect(await readDockerLog(isolated)).not.toContain(" up -d ");
  });

  it.each([
    {
      description: "non-Darwin host",
      override: { OPENCLAW_TEST_HOST_PLATFORM: "Linux" },
      expected: "requires macOS user-immutable config protection",
    },
    {
      description: "missing uchg flag",
      override: { OPENCLAW_TEST_PROTECTED_CONFIG_FLAGS: "none" },
      expected: "requires the macOS user-immutable uchg flag",
    },
  ])(
    "rejects a protected config on $description before mutation",
    async ({ override, expected }) => {
      const isolated = await createDockerSetupSandbox();
      const fixture = await prepareReadOnlyVerifierFixture(isolated);
      const result = await runVerifierDockerSetup(isolated, {
        ...fixture.env,
        ...override,
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(expected);
      const log = await readDockerLog(isolated);
      expect(log).not.toContain("build ");
      expect(log).not.toContain(" up -d ");
      await expect(stat(join(isolated.rootDir, ".env"))).rejects.toThrow();
    },
  );

  it("resolves an unset token only after immutable protected-config validation", async () => {
    const rejected = await createDockerSetupSandbox();
    const rejectedFixture = await prepareReadOnlyVerifierFixture(rejected, {
      token: "protected-unset-token-rejected",
    });
    const rejectedResult = await runVerifierDockerSetup(rejected, {
      ...rejectedFixture.env,
      OPENCLAW_GATEWAY_TOKEN: undefined,
      OPENCLAW_TEST_PROTECTED_CONFIG_FLAGS: "none",
    });
    expect(rejectedResult.status).not.toBe(0);
    expect(rejectedResult.stdout).not.toContain("protected-unset-token-rejected");
    await expect(stat(join(rejected.rootDir, ".env"))).rejects.toThrow();

    const accepted = await createDockerSetupSandbox();
    const acceptedFixture = await prepareReadOnlyVerifierFixture(accepted, {
      token: "protected-unset-token-accepted",
    });
    const acceptedResult = await runVerifierDockerSetup(accepted, {
      ...acceptedFixture.env,
      OPENCLAW_GATEWAY_TOKEN: undefined,
    });
    expect(acceptedResult.status, acceptedResult.stderr).toBe(0);
    expect(acceptedResult.stdout).not.toContain("protected-unset-token-accepted");
    expect(await readFile(join(accepted.rootDir, ".env"), "utf8")).toContain(
      "OPENCLAW_GATEWAY_TOKEN=protected-unset-token-accepted",
    );
  });

  it.each([
    {
      boundary: "final pre-exec",
      label: "Protected OpenClaw config at final pre-exec boundary",
      gatewayStarted: false,
    },
    {
      boundary: "post-create",
      label: "Protected OpenClaw config at post-create boundary",
      gatewayStarted: true,
    },
  ])("rejects uchg removal at the $boundary boundary", async ({ label, gatewayStarted }) => {
    const isolated = await createDockerSetupSandbox();
    const fixture = await prepareReadOnlyVerifierFixture(isolated);
    const result = await runVerifierDockerSetup(isolated, {
      ...fixture.env,
      OPENCLAW_TEST_REMOVE_UCHG_AT: label,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("requires the macOS user-immutable uchg flag");
    const log = await readDockerLog(isolated);
    const recreate = log.includes("up -d --no-deps --force-recreate openclaw-gateway");
    expect(recreate).toBe(gatewayStarted);
    expect(await readFile(join(isolated.rootDir, ".env"), "utf8")).not.toMatch(
      /OPENCLAW_VERIFIER_IMAGE_ID=sha256:/u,
    );
    await expect(
      stat(join(isolated.stateRoot, "operator-state", "openclaw", "verifier", "transaction")),
    ).rejects.toThrow();
  });

  it("stops only the transaction-labeled pre-ID Gateway before missing-uchg recovery fails", async () => {
    const isolated = await createDockerSetupSandbox();
    const interrupted = await beginInterruptedGatewayCreateIntent(isolated);
    expect(interrupted.result.signal).toBe("SIGKILL");
    const interruptedJournal = await readFile(interrupted.journalPath, "utf8");
    const candidateLabel = readJournalValue(interruptedJournal, "gateway-candidate-label");
    const runtimeImage = readJournalValue(interruptedJournal, "runtime-image-id");
    expect(readJournalValue(interruptedJournal, "phase")).toBe("gateway-create-intent");
    expect(readJournalValue(interruptedJournal, "new-gateway-id")).toBe("");
    expect(readJournalValue(interruptedJournal, "old-gateway-id")).toBe(interrupted.priorGateway);
    expect(readJournalValue(interruptedJournal, "gateway-compose-project")).toBe("openclaw");
    expect(readJournalValue(interruptedJournal, "gateway-compose-service")).toBe(
      "openclaw-gateway",
    );
    expect(candidateLabel).toMatch(/^[a-f0-9]{64}$/u);
    expect(readJournalValue(interruptedJournal, "gateway-create-binding")).toMatch(
      /^[a-f0-9]{64}$/u,
    );
    const unrelatedGateway = "f".repeat(64);
    await writeDockerStubContainer(isolated, unrelatedGateway, {
      image: runtimeImage,
      running: true,
      project: "openclaw",
      service: "openclaw-gateway",
      candidateLabel: "0".repeat(64),
    });

    await resetDockerLog(isolated);
    const rejectedRecovery = await runVerifierDockerSetup(isolated, {
      ...interrupted.env,
      OPENCLAW_TEST_PROTECTED_CONFIG_FLAGS: "none",
    });
    expect(rejectedRecovery.status).not.toBe(0);
    expect(rejectedRecovery.stderr).toContain("requires the macOS user-immutable uchg flag");
    const recoveryLines = await readDockerLogLines(isolated);
    const stopIndex = recoveryLines.indexOf(`stop ${interrupted.candidateGateway}`);
    const immutableFailureIndex = recoveryLines.findIndex((line) =>
      line.includes("flag-stat Protected OpenClaw config before verifier recovery -"),
    );
    expect(stopIndex).toBeGreaterThanOrEqual(0);
    expect(immutableFailureIndex).toBeGreaterThan(stopIndex);
    expect(recoveryLines).not.toContain(`stop ${unrelatedGateway}`);
    expect(recoveryLines).not.toContain(`rm ${interrupted.candidateGateway}`);
    expect(
      recoveryLines.some((line) => line.includes("ps -a -q --no-trunc openclaw-gateway")),
    ).toBe(true);
    expect(await readFile(join(isolated.rootDir, "docker-images", "gateway-running"), "utf8")).toBe(
      "false\n",
    );
    expect(readJournalValue(await readFile(interrupted.journalPath, "utf8"), "phase")).toBe(
      "gateway-create-intent",
    );

    const restoredRecovery = await runVerifierDockerSetup(isolated, interrupted.env);
    expect(restoredRecovery.status).not.toBe(0);
    await expect(stat(interrupted.transactionRoot)).rejects.toThrow();
    expect(await readFile(join(isolated.rootDir, "docker-images", "gateway-image"), "utf8")).toBe(
      `${interrupted.priorImage}\n`,
    );
    expect(await readFile(join(isolated.rootDir, "docker-images", "gateway-running"), "utf8")).toBe(
      "true\n",
    );
  });

  it.each(["missing", "altered", "duplicate", "trailing newline"] as const)(
    "rejects a same-service pre-ID Gateway with a %s transaction label",
    async (mutation) => {
      const isolated = await createDockerSetupSandbox();
      const interrupted = await beginInterruptedGatewayCreateIntent(isolated);
      expect(interrupted.result.signal).toBe("SIGKILL");
      const journal = await readFile(interrupted.journalPath, "utf8");
      const candidateLabel = readJournalValue(journal, "gateway-candidate-label");
      const containerPath = dockerStubContainerPath(isolated, interrupted.candidateGateway);
      const labelsPath = join(containerPath, "labels.json");
      const labels = JSON.parse(await readFile(labelsPath, "utf8")) as Record<string, string>;
      if (mutation === "duplicate") {
        await writeFile(
          join(containerPath, "labels-inspect-json"),
          [
            `{"com.docker.compose.project":"openclaw",`,
            `"com.docker.compose.service":"openclaw-gateway",`,
            `"com.docker.compose.oneoff":"False",`,
            `"ai.openclaw.verifier.gateway-candidate":"${candidateLabel}",`,
            `"ai.openclaw.verifier.gateway-candidate":"${candidateLabel}"}`,
          ].join(""),
        );
      } else {
        if (mutation === "missing") {
          delete labels["ai.openclaw.verifier.gateway-candidate"];
        } else if (mutation === "altered") {
          labels["ai.openclaw.verifier.gateway-candidate"] = "0".repeat(64);
        } else {
          labels["ai.openclaw.verifier.gateway-candidate"] = `${candidateLabel}\n`;
        }
        await writeFile(labelsPath, JSON.stringify(labels));
      }
      await resetDockerLog(isolated);

      const recovery = await runVerifierDockerSetup(isolated, interrupted.env);
      expect(recovery.status).not.toBe(0);
      expect(recovery.stderr).toContain("does not match the exact Compose service identity");
      const recoveryLines = await readDockerLogLines(isolated);
      expect(recoveryLines).not.toContain(`stop ${interrupted.candidateGateway}`);
      expect(await stat(interrupted.transactionRoot)).toBeDefined();
    },
  );

  it("rejects an ambiguous pre-ID Gateway service without stopping either candidate", async () => {
    const isolated = await createDockerSetupSandbox();
    const interrupted = await beginInterruptedGatewayCreateIntent(isolated);
    const otherGateway = "f".repeat(64);
    const journal = await readFile(interrupted.journalPath, "utf8");
    const runtimeImage = readJournalValue(journal, "runtime-image-id");
    const candidateLabel = readJournalValue(journal, "gateway-candidate-label");
    await writeDockerStubContainer(isolated, otherGateway, {
      image: runtimeImage,
      running: true,
      project: "openclaw",
      service: "openclaw-gateway",
      candidateLabel,
    });
    await resetDockerLog(isolated);

    const recovery = await runVerifierDockerSetup(isolated, {
      ...interrupted.env,
      DOCKER_STUB_GATEWAY_SERVICE_IDS: `${interrupted.candidateGateway}\\n${otherGateway}`,
    });
    expect(recovery.status).not.toBe(0);
    expect(recovery.stderr).toContain("ambiguous Gateway service container identity");
    const recoveryLines = await readDockerLogLines(isolated);
    expect(recoveryLines).not.toContain(`stop ${interrupted.candidateGateway}`);
    expect(recoveryLines).not.toContain(`stop ${otherGateway}`);
    expect(
      await readFile(
        join(dockerStubContainerPath(isolated, interrupted.candidateGateway), "running"),
        "utf8",
      ),
    ).toBe("true\n");
    expect(
      await readFile(join(dockerStubContainerPath(isolated, otherGateway), "running"), "utf8"),
    ).toBe("true\n");
    const verifierStateRoot = dirname(interrupted.transactionRoot);
    const markerPath = join(
      dirname(verifierStateRoot),
      `.openclaw-verifier-active-${createHash("sha256").update(verifierStateRoot).digest("hex")}`,
    );
    expect(await stat(interrupted.transactionRoot)).toBeDefined();
    expect(await stat(join(verifierStateRoot, "lock"))).toBeDefined();
    expect(await stat(markerPath)).toBeDefined();
    expect(recovery.stderr).toContain("Retaining verifier journal, lock, and active-state marker");
  });

  it("rejects a pre-ID Gateway with the exact transaction label but a different image", async () => {
    const isolated = await createDockerSetupSandbox();
    const interrupted = await beginInterruptedGatewayCreateIntent(isolated);
    await writeFile(
      join(dockerStubContainerPath(isolated, interrupted.candidateGateway), "image"),
      `sha256:${"f".repeat(64)}\n`,
    );
    await resetDockerLog(isolated);

    const recovery = await runVerifierDockerSetup(isolated, interrupted.env);
    expect(recovery.status).not.toBe(0);
    expect(recovery.stderr).toContain("does not match the exact runtime image");
    expect(await readDockerLogLines(isolated)).not.toContain(
      `stop ${interrupted.candidateGateway}`,
    );
    expect(await stat(interrupted.transactionRoot)).toBeDefined();
  });

  it("stops the journaled post-ID Gateway but rejects its same-label service replacement", async () => {
    const isolated = await createDockerSetupSandbox();
    const fixture = await prepareReadOnlyVerifierFixture(isolated);
    const stateRoot = join(isolated.stateRoot, "operator-state", "openclaw", "verifier");
    const transactionRoot = join(stateRoot, "transaction");
    const journalPath = join(transactionRoot, "journal");
    const readyPath = join(isolated.stateRoot, "gateway-started-ready");
    const continuePath = join(isolated.stateRoot, "gateway-started-continue");
    const verifierEnv = {
      ...fixture.env,
      OPENCLAW_GATEWAY_TOKEN: undefined,
      DOCKER_STUB_OLD_GATEWAY_ID: "9".repeat(64),
      DOCKER_STUB_OLD_GATEWAY_IMAGE: `sha256:${"8".repeat(64)}`,
      DOCKER_STUB_OLD_GATEWAY_RUNNING: "true",
    };
    const release = mutateAtTransactionStateBarrier({
      readyPath,
      continuePath,
      phase: "gateway-started",
      stateRoot,
      mutate: async () => undefined,
    });
    const [interrupted] = await Promise.all([
      runVerifierDockerSetup(isolated, {
        ...verifierEnv,
        OPENCLAW_TEST_TRANSACTION_STATE_PHASE: "gateway-started",
        OPENCLAW_TEST_TRANSACTION_STATE_READY: readyPath,
        OPENCLAW_TEST_TRANSACTION_STATE_CONTINUE: continuePath,
        OPENCLAW_TEST_TRANSACTION_STATE_SIGKILL: "1",
      }),
      release,
    ]);
    expect(interrupted.signal).toBe("SIGKILL");
    const journal = await readFile(journalPath, "utf8");
    const journaledGateway = readJournalValue(journal, "new-gateway-id");
    const replacementGateway = "f".repeat(64);
    const runtimeImage = readJournalValue(journal, "runtime-image-id");
    const candidateLabel = readJournalValue(journal, "gateway-candidate-label");
    await writeDockerStubContainer(isolated, replacementGateway, {
      image: runtimeImage,
      running: true,
      project: "openclaw",
      service: "openclaw-gateway",
      candidateLabel,
    });
    await setDockerStubCurrentGateway(isolated, replacementGateway, runtimeImage, true);
    await resetDockerLog(isolated);

    const recovery = await runVerifierDockerSetup(isolated, verifierEnv);
    expect(recovery.status).not.toBe(0);
    expect(recovery.stderr).toContain("different container under the Gateway service identity");
    const recoveryLines = await readDockerLogLines(isolated);
    expect(recoveryLines).toContain(`stop ${journaledGateway}`);
    expect(recoveryLines).not.toContain(`stop ${replacementGateway}`);
    expect(await stat(transactionRoot)).toBeDefined();
  });

  it("validates protected semantics before socket publication without writes or secret output", async () => {
    const isolated = await createDockerSetupSandbox();
    const fixture = await prepareReadOnlyVerifierFixture(isolated, {
      token: "protected-summary-secret",
    });
    await resetDockerLog(isolated);
    const result = await runVerifierDockerSetup(isolated, {
      ...fixture.env,
      OPENCLAW_GATEWAY_TOKEN: "protected-summary-secret",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain("protected-summary-secret");
    expect(result.stdout).toContain("$OPENCLAW_GATEWAY_TOKEN");
    const lines = await readDockerLogLines(isolated);
    expect(lines.some((line) => line.includes(" onboard "))).toBe(false);
    expect(lines.some((line) => line.includes(" config set "))).toBe(false);
    expect(lines.some((line) => line.includes("--entrypoint sh openclaw-gateway"))).toBe(false);
    expect(lines.some((line) => line.includes("dist/index.js config get"))).toBe(false);
    const gatewayRecreate = lines.findIndex((line) =>
      line.includes("up -d --no-deps --force-recreate openclaw-gateway"),
    );
    expect(gatewayRecreate).toBeGreaterThanOrEqual(0);
    expect(await readFile(fixture.configPath, "utf8")).toContain("protected-summary-secret");
  });

  it("does not re-read protected semantics through the path-following container CLI", async () => {
    const isolated = await createDockerSetupSandbox();
    const fixture = await prepareReadOnlyVerifierFixture(isolated);
    const result = await runVerifierDockerSetup(isolated, {
      ...fixture.env,
      DOCKER_STUB_CONFIG_BIND: "loopback",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(await readDockerLog(isolated)).not.toContain("dist/index.js config get");
  });

  it.each(["bytes", "mode"] as const)(
    "rejects protected config %s drift before socket publication",
    async (kind) => {
      const isolated = await createDockerSetupSandbox();
      const fixture = await prepareReadOnlyVerifierFixture(isolated);
      const result = await runVerifierDockerSetup(isolated, {
        ...fixture.env,
        DOCKER_STUB_MUTATE_CONFIG_PATH: fixture.configPath,
        DOCKER_STUB_MUTATE_CONFIG_KIND: kind,
      });
      expect(result.status).not.toBe(0);
      expect(await readDockerLog(isolated)).not.toContain(
        "up -d --no-deps --force-recreate openclaw-gateway",
      );
    },
  );

  it.each(["hardlink", "parent"] as const)(
    "rejects protected config %s identity drift before socket publication",
    async (kind) => {
      const isolated = await createDockerSetupSandbox();
      const fixture = await prepareReadOnlyVerifierFixture(isolated);
      const victim = join(isolated.rootDir, `protected-${kind}-victim`);
      await writeFile(victim, await readFile(fixture.configPath));
      const displacedParent = join(isolated.rootDir, `protected-${kind}-displaced`);
      const result = await runVerifierDockerSetup(isolated, {
        ...fixture.env,
        DOCKER_STUB_SUBSTITUTE_PATH: fixture.configPath,
        DOCKER_STUB_SUBSTITUTE_KIND: kind,
        DOCKER_STUB_SUBSTITUTE_VICTIM: victim,
        DOCKER_STUB_SUBSTITUTE_DISPLACED_PARENT: kind === "parent" ? displacedParent : undefined,
      });
      expect(result.status).not.toBe(0);
      expect(await readDockerLog(isolated)).not.toContain(
        "up -d --no-deps --force-recreate openclaw-gateway",
      );
    },
  );

  it("persists and reloads the explicit protected-config choice", async () => {
    const isolated = await createDockerSetupSandbox();
    const fixture = await prepareReadOnlyVerifierFixture(isolated);
    const first = await runVerifierDockerSetup(isolated, fixture.env);
    expect(first.status, first.stderr).toBe(0);
    expect(await readFile(join(isolated.rootDir, ".env"), "utf8")).toContain(
      "OPENCLAW_SETUP_READ_ONLY_CONFIG=1",
    );
    const second = await runVerifierDockerSetup(isolated, {
      ...fixture.env,
      OPENCLAW_SETUP_READ_ONLY_CONFIG: undefined,
    });
    expect(second.status, second.stderr).toBe(0);
  });

  it("retains metadata-only protected config state across crash recovery", async () => {
    const isolated = await createDockerSetupSandbox();
    const interrupted = await beginInterruptedReadOnlyVerifier(isolated);
    expect(interrupted.result.signal).toBe("SIGKILL");
    await expect(stat(join(interrupted.transactionRoot, "config.backup"))).rejects.toThrow();
    const journal = await readFile(interrupted.journalPath, "utf8");
    expect(readJournalValue(journal, "transaction-format")).toBe("2");
    expect(readJournalValue(journal, "config-policy")).toBe("read-only");
    expect(readJournalValue(journal, "config-dev")).toMatch(/^[0-9]+$/u);
    expect(readJournalValue(journal, "config-ino")).toMatch(/^[0-9]+$/u);

    const recovery = await runVerifierDockerSetup(isolated, interrupted.env);
    expect(recovery.status).not.toBe(0);
    await expect(stat(interrupted.transactionRoot)).rejects.toThrow();
    const retry = await runVerifierDockerSetup(isolated, interrupted.env);
    expect(retry.status, retry.stderr).toBe(0);
  });

  it.each([
    { description: "missing format", remove: ["transaction-format"] },
    { description: "missing policy", remove: ["config-policy"] },
    {
      description: "missing all current discriminator fields",
      remove: [
        "transaction-format",
        "config-policy",
        "config-dev",
        "config-ino",
        "gateway-compose-project",
        "gateway-compose-service",
        "gateway-candidate-label",
        "gateway-create-binding",
      ],
    },
  ])("rejects a current journal with $description", async ({ remove }) => {
    const isolated = await createDockerSetupSandbox();
    const interrupted = await beginInterruptedReadOnlyVerifier(isolated);
    await removeJournalKeys(interrupted.journalPath, remove);
    const result = await runVerifierDockerSetup(isolated, interrupted.env);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/journal|policy|marker/iu);
  });

  it.each([
    { mutation: "duplicate", field: "config-policy", value: "read-only" },
    { mutation: "duplicate", field: "transaction-format", value: "2" },
    { mutation: "duplicate", field: "gateway-candidate-label", value: "0".repeat(64) },
    { mutation: "altered", field: "config-policy", value: "write" },
    { mutation: "altered", field: "transaction-format", value: "legacy" },
    { mutation: "altered", field: "gateway-candidate-label", value: "0".repeat(64) },
  ] as const)(
    "rejects a $mutation current journal $field field",
    async ({ mutation, field, value }) => {
      const isolated = await createDockerSetupSandbox();
      const interrupted = await beginInterruptedReadOnlyVerifier(isolated);
      if (mutation === "duplicate") {
        const journal = await readFile(interrupted.journalPath, "utf8");
        await writeFile(interrupted.journalPath, `${journal}${field}=${value}\n`);
      } else {
        await rewriteJournalValues(interrupted.journalPath, { [field]: value });
      }
      const result = await runVerifierDockerSetup(isolated, interrupted.env);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/journal|policy|marker/iu);
    },
  );

  it.each([
    { field: "configPolicy", value: "write" },
    { field: "transactionFormat", value: "legacy" },
  ] as const)("rejects an altered current active-marker $field", async ({ field, value }) => {
    const isolated = await createDockerSetupSandbox();
    const interrupted = await beginInterruptedReadOnlyVerifier(isolated);
    const marker = JSON.parse(await readFile(interrupted.markerPath, "utf8")) as Record<
      string,
      unknown
    >;
    await writeFile(interrupted.markerPath, `${JSON.stringify({ ...marker, [field]: value })}\n`, {
      mode: 0o600,
    });
    const result = await runVerifierDockerSetup(isolated, interrupted.env);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("active-state marker contract is unsafe");
  });

  it("rejects a recomputed legacy downgrade of metadata-only read-only recovery", async () => {
    const isolated = await createDockerSetupSandbox();
    const interrupted = await beginInterruptedReadOnlyVerifier(isolated);
    const journal = await readFile(interrupted.journalPath, "utf8");
    const transactionId = readJournalValue(journal, "transaction-id");
    const marker = JSON.parse(await readFile(interrupted.markerPath, "utf8")) as {
      markerState: "active" | "cleanup";
      statePath: string;
      stateDev: string;
      stateIno: string;
      parentDev: string;
      parentIno: string;
      stateTokenDigest: string;
    };
    const legacyBinding = createHash("sha256")
      .update(`${marker.stateTokenDigest}\0${transactionId}`)
      .digest("hex");
    await removeJournalKeys(interrupted.journalPath, [
      "transaction-format",
      "config-policy",
      "config-dev",
      "config-ino",
      "gateway-compose-project",
      "gateway-compose-service",
      "gateway-candidate-label",
      "gateway-create-binding",
    ]);
    await rewriteJournalValues(interrupted.journalPath, {
      "operation-binding": legacyBinding,
    });
    await writeFile(
      interrupted.markerPath,
      `${JSON.stringify({
        contractVersion: 2,
        markerState: marker.markerState,
        statePath: marker.statePath,
        stateDev: marker.stateDev,
        stateIno: marker.stateIno,
        parentDev: marker.parentDev,
        parentIno: marker.parentIno,
        stateTokenDigest: marker.stateTokenDigest,
        operationId: transactionId,
        operationBinding: legacyBinding,
      })}\n`,
      { mode: 0o600 },
    );
    const envPath = join(isolated.rootDir, ".env");
    const envSentinel = "DOWNGRADE_SENTINEL=preserved\n";
    const configBefore = await readFile(interrupted.configPath);
    await writeFile(envPath, envSentinel, { mode: 0o600 });

    const result = await runVerifierDockerSetup(isolated, interrupted.env);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("missing its captured backup");
    expect(await readFile(envPath, "utf8")).toBe(envSentinel);
    expect(await readFile(interrupted.configPath)).toEqual(configBefore);
    expect(await stat(interrupted.transactionRoot)).toBeDefined();
  });

  it("retains genuine legacy config-writing transaction recovery", async () => {
    const isolated = await createDockerSetupSandbox();
    const interrupted = await beginInterruptedVerifierTransaction(isolated);
    expect(interrupted.interrupted.signal).toBe("SIGKILL");
    const journal = await readFile(interrupted.journalPath, "utf8");
    const transactionId = readJournalValue(journal, "transaction-id");
    const stateRoot = interrupted.verifierStateRoot;
    const markerPath = join(
      dirname(stateRoot),
      `.openclaw-verifier-active-${createHash("sha256").update(stateRoot).digest("hex")}`,
    );
    const marker = JSON.parse(await readFile(markerPath, "utf8")) as {
      markerState: "active" | "cleanup";
      statePath: string;
      stateDev: string;
      stateIno: string;
      parentDev: string;
      parentIno: string;
      stateTokenDigest: string;
      operationId: string;
    };
    const legacyBinding = createHash("sha256")
      .update(`${marker.stateTokenDigest}\0${transactionId}`)
      .digest("hex");
    await removeJournalKeys(interrupted.journalPath, [
      "transaction-format",
      "config-policy",
      "config-dev",
      "config-ino",
      "gateway-compose-project",
      "gateway-compose-service",
      "gateway-candidate-label",
      "gateway-create-binding",
    ]);
    await rewriteJournalValues(interrupted.journalPath, {
      "operation-binding": legacyBinding,
    });
    await writeFile(
      markerPath,
      `${JSON.stringify({
        contractVersion: 2,
        markerState: marker.markerState,
        statePath: marker.statePath,
        stateDev: marker.stateDev,
        stateIno: marker.stateIno,
        parentDev: marker.parentDev,
        parentIno: marker.parentIno,
        stateTokenDigest: marker.stateTokenDigest,
        operationId: transactionId,
        operationBinding: legacyBinding,
      })}\n`,
      { mode: 0o600 },
    );

    const recovery = await runVerifierDockerSetup(isolated, interrupted.verifierEnv);
    expect(recovery.status).not.toBe(0);
    await expect(stat(interrupted.transactionRoot)).rejects.toThrow();
  });

  it("rolls back exact publication state when Gateway readiness fails", async () => {
    const isolated = await createDockerSetupSandbox();
    await writeFile(join(isolated.rootDir, "Dockerfile.sandbox-verifier"), "FROM scratch\n");
    const result = await runVerifierDockerSetup(isolated, {
      OPENCLAW_SANDBOX: "1",
      OPENCLAW_VERIFIER_WORKSPACE_DIR: isolated.rootDir,
      OPENCLAW_VERIFIER_GATEWAY_WORKSPACE: "/workspace/project",
      OPENCLAW_VERIFIER_PACKAGE_MANAGER: "yarn@4.9.2",
      DOCKER_STUB_FAIL_MATCH: "readyz",
    });

    expect(result.status).not.toBe(0);
    const envFile = await readFile(join(isolated.rootDir, ".env"), "utf8");
    expect(envFile).not.toContain(`OPENCLAW_VERIFIER_IMAGE_ID=sha256:${"e".repeat(64)}`);
    await expect(
      stat(join(isolated.stateRoot, "operator-state", "openclaw", "verifier", "transaction")),
    ).rejects.toThrow();
    await expect(
      stat(join(isolated.stateRoot, "operator-state", "openclaw", "verifier", "lock")),
    ).rejects.toThrow();
  });

  it("refuses to commit when the exact Gateway recreate lacks the socket overlay", async () => {
    const isolated = await createDockerSetupSandbox();
    await writeFile(join(isolated.rootDir, "Dockerfile.sandbox-verifier"), "FROM scratch\n");
    const result = await runVerifierDockerSetup(isolated, {
      OPENCLAW_SANDBOX: "1",
      OPENCLAW_VERIFIER_WORKSPACE_DIR: isolated.rootDir,
      OPENCLAW_VERIFIER_GATEWAY_WORKSPACE: "/workspace/project",
      OPENCLAW_VERIFIER_PACKAGE_MANAGER: "yarn@4.9.2",
      DOCKER_STUB_IGNORE_SOCKET_OVERLAY: "1",
    });

    expect(result.status).not.toBe(0);
    const log = await readDockerLog(isolated);
    const expectedRecreate = [
      `-f ${join(isolated.rootDir, "docker-compose.sandbox.yml")}`,
      "up -d --no-deps --force-recreate openclaw-gateway",
    ].join(" ");
    expect(log).toContain(expectedRecreate);
    const envFile = await readFile(join(isolated.rootDir, ".env"), "utf8");
    expect(envFile).not.toContain(`OPENCLAW_VERIFIER_IMAGE_ID=sha256:${"e".repeat(64)}`);
  });

  it.each(["config", "overlay"] as const)(
    "rejects a dangling %s symlink before optional-file backup",
    async (targetKind) => {
      const isolated = await createDockerSetupSandbox();
      await writeFile(join(isolated.rootDir, "Dockerfile.sandbox-verifier"), "FROM scratch\n");
      const configDir = join(isolated.rootDir, "config");
      await mkdir(configDir, { recursive: true });
      const target =
        targetKind === "config"
          ? join(configDir, "openclaw.json")
          : join(isolated.rootDir, "docker-compose.sandbox.yml");
      const missingTarget = join(isolated.rootDir, `${targetKind}-missing`);
      await symlink(missingTarget, target);

      const result = await runVerifierDockerSetup(isolated, {
        OPENCLAW_SANDBOX: "1",
        OPENCLAW_CONFIG_DIR: configDir,
        OPENCLAW_VERIFIER_WORKSPACE_DIR: isolated.rootDir,
        OPENCLAW_VERIFIER_GATEWAY_WORKSPACE: "/workspace/project",
        OPENCLAW_VERIFIER_PACKAGE_MANAGER: "yarn@4.9.2",
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("direct single-link regular file");
      expect(await readlink(target)).toBe(missingTarget);
      await expect(stat(missingTarget)).rejects.toThrow();
    },
  );

  it.each(["env", "config", "overlay"] as const)(
    "rejects a hardlinked %s file immediately before transaction backup",
    async (targetKind) => {
      const isolated = await createDockerSetupSandbox();
      await writeFile(join(isolated.rootDir, "Dockerfile.sandbox-verifier"), "FROM scratch\n");
      const configDir = join(isolated.rootDir, "config");
      await mkdir(configDir, { recursive: true });
      const target =
        targetKind === "env"
          ? join(isolated.rootDir, ".env")
          : targetKind === "config"
            ? join(configDir, "openclaw.json")
            : join(isolated.rootDir, "docker-compose.sandbox.yml");
      const victim = join(isolated.stateRoot, `${targetKind}-hardlink-victim`);
      await writeFile(target, "original\n");
      await writeFile(victim, "victim-preserved\n");

      const result = await runVerifierDockerSetup(isolated, {
        OPENCLAW_SANDBOX: "1",
        OPENCLAW_CONFIG_DIR: configDir,
        OPENCLAW_VERIFIER_WORKSPACE_DIR: isolated.rootDir,
        OPENCLAW_VERIFIER_GATEWAY_WORKSPACE: "/workspace/project",
        OPENCLAW_VERIFIER_PACKAGE_MANAGER: "yarn@4.9.2",
        DOCKER_STUB_SUBSTITUTE_BEFORE_BACKUP: "1",
        DOCKER_STUB_SUBSTITUTE_PATH: target,
        DOCKER_STUB_SUBSTITUTE_KIND: "hardlink",
        DOCKER_STUB_SUBSTITUTE_VICTIM: victim,
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("single-link regular file");
      expect(await readFile(victim, "utf8")).toBe("victim-preserved\n");
      expect((await lstat(target)).ino).toBe((await lstat(victim)).ino);
    },
  );

  it.each(["env", "config", "overlay"] as const)(
    "rejects %s parent replacement while its backup is being captured",
    async (targetKind) => {
      const isolated = await createDockerSetupSandbox();
      await writeFile(join(isolated.rootDir, "Dockerfile.sandbox-verifier"), "FROM scratch\n");
      const configDir = join(isolated.rootDir, "config");
      await mkdir(configDir, { recursive: true });
      const target =
        targetKind === "env"
          ? join(isolated.rootDir, ".env")
          : targetKind === "config"
            ? join(configDir, "openclaw.json")
            : join(isolated.rootDir, "docker-compose.sandbox.yml");
      const displacedParent = join(isolated.stateRoot, `${targetKind}-backup-displaced-parent`);
      const victim = join(isolated.stateRoot, `${targetKind}-backup-parent-victim`);
      const transactionRoot = join(isolated.stateRoot, "operator-state", "openclaw", "verifier");
      const readyPath = join(isolated.stateRoot, `${targetKind}-backup-ready`);
      const continuePath = join(isolated.stateRoot, `${targetKind}-backup-continue`);
      await writeFile(target, `${targetKind}-original\n`, { mode: 0o640 });
      await writeFile(victim, "victim-preserved\n");
      const replacement = replaceParentAtBackupBarrier({
        readyPath,
        continuePath,
        displacedParent,
        target,
        victim,
      });

      const [result] = await Promise.all([
        runVerifierDockerSetup(isolated, {
          OPENCLAW_SANDBOX: "1",
          OPENCLAW_CONFIG_DIR: configDir,
          OPENCLAW_VERIFIER_WORKSPACE_DIR: isolated.rootDir,
          OPENCLAW_VERIFIER_GATEWAY_WORKSPACE: "/workspace/project",
          OPENCLAW_VERIFIER_PACKAGE_MANAGER: "yarn@4.9.2",
          OPENCLAW_DOCKER_SETUP_TEST: "1",
          OPENCLAW_TEST_BACKUP_READY: readyPath,
          OPENCLAW_TEST_BACKUP_CONTINUE: continuePath,
          OPENCLAW_TEST_BACKUP_TARGET: target,
        }),
        replacement,
      ]);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Refusing to back up unsafe or changing");
      expect(await readFile(victim, "utf8")).toBe("victim-preserved\n");
      expect((await lstat(target)).ino).toBe((await lstat(victim)).ino);
      expect((await stat(join(transactionRoot, "transaction"))).isDirectory()).toBe(true);
      expect((await stat(join(transactionRoot, "lock"))).isDirectory()).toBe(true);
      await rm(displacedParent, { recursive: true, force: true });
    },
    60_000,
  );

  it.each([
    { targetKind: "env", substituteKind: "symlink" },
    { targetKind: "env", substituteKind: "dangling-symlink" },
    { targetKind: "env", substituteKind: "hardlink" },
    { targetKind: "env", substituteKind: "fifo" },
    { targetKind: "config", substituteKind: "symlink" },
    { targetKind: "config", substituteKind: "dangling-symlink" },
    { targetKind: "config", substituteKind: "hardlink" },
    { targetKind: "config", substituteKind: "fifo" },
    { targetKind: "overlay", substituteKind: "symlink" },
    { targetKind: "overlay", substituteKind: "dangling-symlink" },
    { targetKind: "overlay", substituteKind: "hardlink" },
    { targetKind: "overlay", substituteKind: "fifo" },
  ] as const)(
    "retains recovery state after post-backup $substituteKind substitution of $targetKind",
    async ({ targetKind, substituteKind }) => {
      const isolated = await createDockerSetupSandbox();
      await writeFile(join(isolated.rootDir, "Dockerfile.sandbox-verifier"), "FROM scratch\n");
      const configDir = join(isolated.rootDir, "config");
      await mkdir(configDir, { recursive: true });
      const target =
        targetKind === "env"
          ? join(isolated.rootDir, ".env")
          : targetKind === "config"
            ? join(configDir, "openclaw.json")
            : join(isolated.rootDir, "docker-compose.sandbox.yml");
      await writeFile(target, `${targetKind}-original\n`, { mode: 0o640 });
      const victim = join(isolated.stateRoot, `${targetKind}-${substituteKind}-victim`);
      await writeFile(victim, "victim-preserved\n");

      const result = await runVerifierDockerSetup(isolated, {
        OPENCLAW_SANDBOX: "1",
        OPENCLAW_CONFIG_DIR: configDir,
        OPENCLAW_VERIFIER_WORKSPACE_DIR: isolated.rootDir,
        OPENCLAW_VERIFIER_GATEWAY_WORKSPACE: "/workspace/project",
        OPENCLAW_VERIFIER_PACKAGE_MANAGER: "yarn@4.9.2",
        DOCKER_STUB_SUBSTITUTE_PATH: target,
        DOCKER_STUB_SUBSTITUTE_KIND: substituteKind,
        DOCKER_STUB_SUBSTITUTE_VICTIM: victim,
        DOCKER_STUB_FAIL_AFTER_MATCH: ":candidate-",
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("retaining recovery state");
      const targetStat = await lstat(target);
      if (substituteKind === "symlink" || substituteKind === "dangling-symlink") {
        expect(targetStat.isSymbolicLink()).toBe(true);
        expect(await readlink(target)).toBe(
          substituteKind === "dangling-symlink" ? `${victim}.missing` : victim,
        );
      } else if (substituteKind === "fifo") {
        expect(targetStat.isFIFO()).toBe(true);
      } else {
        expect(targetStat.ino).toBe((await lstat(victim)).ino);
        expect(targetStat.nlink).toBe(2);
      }
      expect(await readFile(victim, "utf8")).toBe("victim-preserved\n");
      const stateRoot = join(isolated.stateRoot, "operator-state", "openclaw", "verifier");
      expect((await stat(join(stateRoot, "transaction"))).isDirectory()).toBe(true);
      expect((await stat(join(stateRoot, "lock"))).isDirectory()).toBe(true);
    },
  );

  it.each(["env-and-overlay", "config"] as const)(
    "retains recovery state after post-backup %s parent replacement",
    async (targetKind) => {
      const isolated = await createDockerSetupSandbox();
      await writeFile(join(isolated.rootDir, "Dockerfile.sandbox-verifier"), "FROM scratch\n");
      const configDir = join(isolated.rootDir, "config");
      await mkdir(configDir, { recursive: true });
      const target =
        targetKind === "config" ? join(configDir, "openclaw.json") : join(isolated.rootDir, ".env");
      const displacedParent = join(isolated.stateRoot, `${targetKind}-displaced-parent`);
      const victim = join(isolated.stateRoot, `${targetKind}-parent-victim`);
      await writeFile(target, `${targetKind}-original\n`, { mode: 0o640 });
      await writeFile(victim, "victim-preserved\n");

      const result = await runVerifierDockerSetup(isolated, {
        OPENCLAW_SANDBOX: "1",
        OPENCLAW_CONFIG_DIR: configDir,
        OPENCLAW_VERIFIER_WORKSPACE_DIR: isolated.rootDir,
        OPENCLAW_VERIFIER_GATEWAY_WORKSPACE: "/workspace/project",
        OPENCLAW_VERIFIER_PACKAGE_MANAGER: "yarn@4.9.2",
        DOCKER_STUB_SUBSTITUTE_PATH: target,
        DOCKER_STUB_SUBSTITUTE_KIND: "parent",
        DOCKER_STUB_SUBSTITUTE_VICTIM: victim,
        DOCKER_STUB_SUBSTITUTE_DISPLACED_PARENT: displacedParent,
        DOCKER_STUB_FAIL_AFTER_MATCH: ":candidate-",
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("retaining recovery state");
      expect(await readFile(victim, "utf8")).toBe("victim-preserved\n");
      expect((await lstat(target)).ino).toBe((await lstat(victim)).ino);
      const stateRoot = join(isolated.stateRoot, "operator-state", "openclaw", "verifier");
      expect((await stat(join(stateRoot, "transaction"))).isDirectory()).toBe(true);
      expect((await stat(join(stateRoot, "lock"))).isDirectory()).toBe(true);
      await rm(displacedParent, { recursive: true, force: true });
    },
  );

  it("restores an exact prior stopped Gateway after publication failure", async () => {
    const isolated = await createDockerSetupSandbox();
    await writeFile(join(isolated.rootDir, "Dockerfile.sandbox-verifier"), "FROM scratch\n");
    const priorGateway = "9".repeat(64);
    const priorImage = `sha256:${"8".repeat(64)}`;
    const result = await runVerifierDockerSetup(isolated, {
      OPENCLAW_SANDBOX: "1",
      OPENCLAW_VERIFIER_WORKSPACE_DIR: isolated.rootDir,
      OPENCLAW_VERIFIER_GATEWAY_WORKSPACE: "/workspace/project",
      OPENCLAW_VERIFIER_PACKAGE_MANAGER: "yarn@4.9.2",
      DOCKER_STUB_OLD_GATEWAY_ID: priorGateway,
      DOCKER_STUB_OLD_GATEWAY_IMAGE: priorImage,
      DOCKER_STUB_FAIL_MATCH: "readyz",
    });

    expect(result.status).not.toBe(0);
    expect(await readDockerLog(isolated)).toContain(
      "create --no-deps --force-recreate openclaw-gateway",
    );
    const stateRoot = join(isolated.stateRoot, "operator-state", "openclaw", "verifier");
    await expect(stat(join(stateRoot, "transaction"))).rejects.toThrow();
    await expect(stat(join(stateRoot, "lock"))).rejects.toThrow();
  });

  it("rejects a missing Docker socket before verifier publication", async () => {
    const isolated = await createDockerSetupSandbox();
    await writeFile(join(isolated.rootDir, "Dockerfile.sandbox-verifier"), "FROM scratch\n");
    await resetDockerLog(isolated);
    const result = runDockerSetup(isolated, {
      OPENCLAW_SANDBOX: "1",
      OPENCLAW_DOCKER_SOCKET: join(isolated.rootDir, "missing.sock"),
      OPENCLAW_VERIFIER_WORKSPACE_DIR: isolated.rootDir,
      OPENCLAW_VERIFIER_GATEWAY_WORKSPACE: "/workspace/project",
      OPENCLAW_VERIFIER_PACKAGE_MANAGER: "yarn@4.9.2",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("requires the configured Docker socket before publication");
    expect(await readDockerLog(isolated)).not.toContain("openclaw-sandbox-verifier:candidate-");
  });

  it("rejects a runtime image without Docker CLI before verifier publication", async () => {
    const isolated = await createDockerSetupSandbox();
    await writeFile(join(isolated.rootDir, "Dockerfile.sandbox-verifier"), "FROM scratch\n");
    await resetDockerLog(isolated);
    const result = await runVerifierDockerSetup(isolated, {
      OPENCLAW_SANDBOX: "1",
      OPENCLAW_VERIFIER_WORKSPACE_DIR: isolated.rootDir,
      OPENCLAW_VERIFIER_GATEWAY_WORKSPACE: "/workspace/project",
      OPENCLAW_VERIFIER_PACKAGE_MANAGER: "yarn@4.9.2",
      DOCKER_STUB_FAIL_MATCH: "--entrypoint docker openclaw-gateway --version",
    });

    expect(result.status).not.toBe(0);
    expect(await readDockerLog(isolated)).not.toContain("openclaw-sandbox-verifier:candidate-");
  });

  it.each([
    {
      description: "sandbox config",
      failure: "agents.defaults.sandbox.mode",
      after: true,
    },
    {
      description: "Gateway recreate",
      failure: "up -d --no-deps --force-recreate openclaw-gateway",
      after: true,
    },
    {
      description: "Gateway readiness",
      failure: "readyz",
      after: false,
    },
  ])(
    "restores exact setup state after post-overlay $description failure",
    async ({ failure, after }) => {
      const isolated = await createDockerSetupSandbox();
      await writeFile(join(isolated.rootDir, "Dockerfile.sandbox-verifier"), "FROM scratch\n");
      const configDir = join(isolated.rootDir, "config");
      const configPath = join(configDir, "openclaw.json");
      const overlayPath = join(isolated.rootDir, "docker-compose.sandbox.yml");
      await mkdir(configDir, { recursive: true });
      await writeFile(configPath, '{"preserved":true}\n', { mode: 0o640 });
      await writeFile(overlayPath, "services:\n  preserved: {}\n", { mode: 0o644 });
      const result = await runVerifierDockerSetup(isolated, {
        OPENCLAW_SANDBOX: "1",
        OPENCLAW_CONFIG_DIR: configDir,
        OPENCLAW_VERIFIER_WORKSPACE_DIR: isolated.rootDir,
        OPENCLAW_VERIFIER_GATEWAY_WORKSPACE: "/workspace/project",
        OPENCLAW_VERIFIER_PACKAGE_MANAGER: "yarn@4.9.2",
        DOCKER_STUB_FAIL_AFTER_MATCH: after ? failure : undefined,
        DOCKER_STUB_FAIL_MATCH: after ? undefined : failure,
      });

      expect(result.status).not.toBe(0);
      expect(await readFile(configPath, "utf8")).toBe('{"preserved":true}\n');
      expect(await readFile(overlayPath, "utf8")).toBe("services:\n  preserved: {}\n");
      expect((await stat(configPath)).mode & 0o777).toBe(0o640);
      expect((await stat(overlayPath)).mode & 0o777).toBe(0o644);
      expect((await readdir(configDir)).some((name) => name.includes(".restore-"))).toBe(false);
      expect((await readdir(isolated.rootDir)).some((name) => name.includes(".restore-"))).toBe(
        false,
      );
      const envFile = await readFile(join(isolated.rootDir, ".env"), "utf8");
      expect(envFile).not.toContain(`OPENCLAW_VERIFIER_IMAGE_ID=sha256:${"e".repeat(64)}`);
    },
  );

  it.each([
    {
      description: "prepared journal before temp creation",
      state: "prepared",
      placement: "none",
    },
    {
      description: "written temp before identity journal",
      state: "prepared",
      placement: "temp",
    },
    { description: "journaled temp", state: "temp-written", placement: "temp" },
    {
      description: "rename before replacement journal",
      state: "temp-written",
      placement: "target",
    },
    {
      description: "replacement journal before final mode",
      state: "target-replaced",
      placement: "target",
    },
    {
      description: "final mode before mode journal",
      state: "target-replaced",
      placement: "target-final-mode",
    },
    {
      description: "journaled final mode",
      state: "mode-applied",
      placement: "target-final-mode",
    },
  ] as const)(
    "recovers the exact restore boundary after $description",
    async ({ state, placement }) => {
      const isolated = await createDockerSetupSandbox();
      const transaction = await beginInterruptedVerifierTransaction(isolated, "config");
      expect(transaction.interrupted.signal).toBe("SIGKILL");
      const journal = await readFile(transaction.journalPath, "utf8");
      const expectedMode = Number.parseInt(readJournalValue(journal, "config-backup-mode"), 8);
      const backup = await readFile(transaction.backupPath);
      await writeFile(transaction.targetPath, "mutated-after-backup\n");
      const originalTarget = await lstat(transaction.targetPath);
      const temporaryName = `.openclaw-restore-${"1".repeat(32)}`;
      const temporaryPath = join(resolve(transaction.targetPath, ".."), temporaryName);
      let temporaryDev = "";
      let temporaryIno = "";
      if (placement !== "none") {
        await writeFile(temporaryPath, backup, { mode: 0o600 });
        const temporaryIdentity = await lstat(temporaryPath);
        temporaryDev = String(temporaryIdentity.dev);
        temporaryIno = String(temporaryIdentity.ino);
      }
      if (placement === "target" || placement === "target-final-mode") {
        await rename(temporaryPath, transaction.targetPath);
      }
      if (placement === "target-final-mode") {
        await chmod(transaction.targetPath, expectedMode);
      }
      await rewriteJournalValues(transaction.journalPath, {
        "restore-kind": transaction.restoreKind,
        "restore-state": state,
        "restore-temp-name": temporaryName,
        "restore-temp-dev": state === "prepared" ? "" : temporaryDev,
        "restore-temp-ino": state === "prepared" ? "" : temporaryIno,
        "restore-target-present": "1",
        "restore-target-dev": String(originalTarget.dev),
        "restore-target-ino": String(originalTarget.ino),
      });

      const recovered = await runVerifierDockerSetup(isolated, transaction.verifierEnv);

      expect(recovered.status).not.toBe(0);
      expect(await readFile(transaction.targetPath)).toEqual(backup);
      expect((await stat(transaction.targetPath)).mode & 0o777).toBe(expectedMode);
      await expect(stat(temporaryPath)).rejects.toThrow();
      await expect(stat(transaction.transactionRoot)).rejects.toThrow();
      await expect(stat(join(transaction.verifierStateRoot, "lock"))).rejects.toThrow();
    },
  );

  it("promotes one complete abandoned bootstrap journal before recovery", async () => {
    const isolated = await createDockerSetupSandbox();
    const transaction = await beginInterruptedVerifierTransaction(isolated);
    expect(transaction.interrupted.signal).toBe("SIGKILL");
    const bootstrap = join(transaction.transactionRoot, `.journal.bootstrap-${"a".repeat(32)}`);
    await rename(transaction.journalPath, bootstrap);

    const recovered = await runVerifierDockerSetup(isolated, transaction.verifierEnv);

    expect(recovered.status).not.toBe(0);
    await expect(stat(transaction.transactionRoot)).rejects.toThrow();
    await expect(stat(join(transaction.verifierStateRoot, "lock"))).rejects.toThrow();
  });

  it.each(["state-instance-digest", "operation-binding"] as const)(
    "retains recovery state when the journal has a replayed %s",
    async (field) => {
      const isolated = await createDockerSetupSandbox();
      const transaction = await beginInterruptedVerifierTransaction(isolated);
      expect(transaction.interrupted.signal).toBe("SIGKILL");
      await rewriteJournalValues(transaction.journalPath, {
        [field]: "f".repeat(64),
      });

      const blocked = await runVerifierDockerSetup(isolated, transaction.verifierEnv);

      expect(blocked.status).not.toBe(0);
      expect(await readFile(transaction.journalPath, "utf8")).toContain(
        `${field}=${"f".repeat(64)}`,
      );
      expect((await stat(transaction.transactionRoot)).isDirectory()).toBe(true);
      expect((await stat(join(transaction.verifierStateRoot, "lock"))).isDirectory()).toBe(true);
    },
  );

  it("retains one state-instance token across committed cleanup and state-root reuse", async () => {
    const isolated = await createDockerSetupSandbox();
    await writeFile(join(isolated.rootDir, "Dockerfile.sandbox-verifier"), "FROM scratch\n");
    const stateRoot = await createShortVerifierStateRoot();
    const verifierEnv = {
      OPENCLAW_SANDBOX: "1",
      OPENCLAW_VERIFIER_WORKSPACE_DIR: isolated.rootDir,
      OPENCLAW_VERIFIER_GATEWAY_WORKSPACE: "/workspace/project",
      OPENCLAW_VERIFIER_PACKAGE_MANAGER: "yarn@4.9.2",
      OPENCLAW_VERIFIER_STATE_ROOT: stateRoot,
      OPENCLAW_DOCKER_SETUP_TEST: "1",
      OPENCLAW_TEST_STATE_INSTANCE_TOKEN: "8".repeat(64),
    };

    const first = await runVerifierDockerSetup(isolated, verifierEnv);
    const tokenPath = join(stateRoot, ".state-instance");
    const firstToken = await readFile(tokenPath, "utf8");
    const second = await runVerifierDockerSetup(isolated, {
      ...verifierEnv,
      OPENCLAW_TEST_STATE_INSTANCE_TOKEN: "9".repeat(64),
    });

    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect(firstToken).toBe(`${"8".repeat(64)}\n`);
    expect(await readFile(tokenPath, "utf8")).toBe(firstToken);
    await expect(stat(join(stateRoot, "transaction"))).rejects.toThrow();
    await expect(stat(join(stateRoot, "lock"))).rejects.toThrow();
    const markerNames = (await readdir(dirname(stateRoot))).filter((name) =>
      name.startsWith(".openclaw-verifier-active-"),
    );
    expect(markerNames).toEqual([]);
  });

  it("removes one strictly owned incomplete bootstrap journal before restarting", async () => {
    const isolated = await createDockerSetupSandbox();
    const transaction = await beginInterruptedVerifierTransaction(isolated);
    expect(transaction.interrupted.signal).toBe("SIGKILL");
    const bootstrap = join(transaction.transactionRoot, `.journal.bootstrap-${"b".repeat(32)}`);
    await rename(transaction.journalPath, bootstrap);
    await writeFile(bootstrap, "phase=begun\n", { mode: 0o600 });

    const recovered = await runVerifierDockerSetup(isolated, transaction.verifierEnv);

    expect(
      recovered.status,
      `setup stderr:\n${recovered.stderr}\nDocker stub log:\n${await readDockerLog(isolated)}`,
    ).toBe(0);
    await expect(stat(transaction.transactionRoot)).rejects.toThrow();
    await expect(stat(join(transaction.verifierStateRoot, "lock"))).rejects.toThrow();
  });

  it("discards one complete abandoned update journal when the authoritative journal exists", async () => {
    const isolated = await createDockerSetupSandbox();
    const transaction = await beginInterruptedVerifierTransaction(isolated);
    expect(transaction.interrupted.signal).toBe("SIGKILL");
    const update = join(transaction.transactionRoot, `.journal.update-${"c".repeat(32)}`);
    await copyFile(transaction.journalPath, update);

    const recovered = await runVerifierDockerSetup(isolated, transaction.verifierEnv);

    expect(recovered.status).not.toBe(0);
    await expect(stat(transaction.transactionRoot)).rejects.toThrow();
    await expect(stat(join(transaction.verifierStateRoot, "lock"))).rejects.toThrow();
  });

  it.each([
    {
      description: "unknown name",
      prepare: async (
        transaction: Awaited<ReturnType<typeof beginInterruptedVerifierTransaction>>,
      ) => {
        await copyFile(
          transaction.journalPath,
          join(transaction.transactionRoot, ".journal.unknown"),
        );
      },
    },
    {
      description: "malformed exact candidate",
      prepare: async (
        transaction: Awaited<ReturnType<typeof beginInterruptedVerifierTransaction>>,
      ) => {
        const candidate = join(transaction.transactionRoot, `.journal.update-${"d".repeat(32)}`);
        await writeFile(candidate, "unknown=value\n", { mode: 0o600 });
      },
    },
    {
      description: "ambiguous exact candidates",
      prepare: async (
        transaction: Awaited<ReturnType<typeof beginInterruptedVerifierTransaction>>,
      ) => {
        await copyFile(
          transaction.journalPath,
          join(transaction.transactionRoot, `.journal.update-${"e".repeat(32)}`),
        );
        await copyFile(
          transaction.journalPath,
          join(transaction.transactionRoot, `.journal.restore-${"f".repeat(32)}`),
        );
      },
    },
  ])("retains transaction state for an $description", async ({ prepare }) => {
    const isolated = await createDockerSetupSandbox();
    const transaction = await beginInterruptedVerifierTransaction(isolated);
    expect(transaction.interrupted.signal).toBe("SIGKILL");
    await prepare(transaction);

    const blocked = await runVerifierDockerSetup(isolated, transaction.verifierEnv);

    expect(blocked.status).not.toBe(0);
    expect((await stat(transaction.transactionRoot)).isDirectory()).toBe(true);
    expect((await stat(join(transaction.verifierStateRoot, "lock"))).isDirectory()).toBe(true);
    expect(await readFile(transaction.journalPath, "utf8")).toContain("phase=begun");
  });

  it.each(["symlink", "hardlink", "permissive-mode"] as const)(
    "retains transaction state for an unsafe %s journal candidate",
    async (candidateKind) => {
      const isolated = await createDockerSetupSandbox();
      const transaction = await beginInterruptedVerifierTransaction(isolated);
      expect(transaction.interrupted.signal).toBe("SIGKILL");
      const candidate = join(transaction.transactionRoot, `.journal.update-${"1".repeat(32)}`);
      if (candidateKind === "symlink") {
        await symlink(transaction.journalPath, candidate);
      } else if (candidateKind === "hardlink") {
        await link(transaction.journalPath, candidate);
      } else {
        await copyFile(transaction.journalPath, candidate);
        await chmod(candidate, 0o644);
      }

      const blocked = await runVerifierDockerSetup(isolated, transaction.verifierEnv);

      expect(blocked.status).not.toBe(0);
      expect((await stat(transaction.transactionRoot)).isDirectory()).toBe(true);
      expect((await stat(join(transaction.verifierStateRoot, "lock"))).isDirectory()).toBe(true);
    },
  );

  it.each(["directory", "symlink", "socket"] as const)(
    "retains restore state when the pinned transaction directory becomes a %s during journal publication",
    async (replacementKind) => {
      const isolated = await createDockerSetupSandbox();
      const shortStateRoot =
        replacementKind === "socket" ? await createShortVerifierStateRoot() : undefined;
      const transaction = await beginInterruptedVerifierTransaction(
        isolated,
        "env",
        shortStateRoot,
      );
      expect(
        transaction.interrupted.signal,
        `setup status=${transaction.interrupted.status}\nstderr:\n${transaction.interrupted.stderr}\nDocker stub log:\n${await readDockerLog(isolated)}`,
      ).toBe("SIGKILL");
      const displacedTransaction = join(
        transaction.verifierStateRoot,
        `transaction-displaced-${replacementKind}`,
      );
      const victimDirectory = join(isolated.stateRoot, `journal-dir-${replacementKind}-victim`);
      const victimMarker = join(victimDirectory, "marker");
      const readyPath = join(isolated.stateRoot, `journal-dir-${replacementKind}-ready`);
      const continuePath = join(isolated.stateRoot, `journal-dir-${replacementKind}-continue`);
      await mkdir(victimDirectory, { recursive: true });
      await writeFile(victimMarker, "victim-preserved\n");
      let replacementServer: ReturnType<typeof createServer> | undefined;
      const mutation = mutateAtRestoreJournalBarrier({
        readyPath,
        continuePath,
        mutate: async () => {
          await rename(transaction.transactionRoot, displacedTransaction);
          if (replacementKind === "directory") {
            await mkdir(transaction.transactionRoot, { mode: 0o700 });
            await writeFile(join(transaction.transactionRoot, "marker"), "replacement\n");
          } else if (replacementKind === "symlink") {
            await symlink(victimDirectory, transaction.transactionRoot);
          } else {
            replacementServer = createServer();
            await new Promise<void>((resolveListen, rejectListen) => {
              replacementServer?.once("error", rejectListen);
              replacementServer?.listen(transaction.transactionRoot, resolveListen);
            });
          }
        },
      });

      try {
        const [blocked, barrier] = await Promise.all([
          runVerifierDockerSetup(isolated, {
            ...transaction.verifierEnv,
            OPENCLAW_DOCKER_SETUP_TEST: "1",
            OPENCLAW_TEST_RESTORE_JOURNAL_READY: readyPath,
            OPENCLAW_TEST_RESTORE_JOURNAL_CONTINUE: continuePath,
          }),
          mutation,
        ]);

        expect(blocked.status).not.toBe(0);
        expect(blocked.stderr).toContain("retaining recovery state");
        expect(await readFile(victimMarker, "utf8")).toBe("victim-preserved\n");
        expect(
          await readFile(join(displacedTransaction, barrier.temporaryName), "utf8"),
        ).not.toHaveLength(0);
        expect(await readFile(join(displacedTransaction, "journal"), "utf8")).toContain(
          "phase=begun",
        );
        expect((await stat(join(transaction.verifierStateRoot, "lock"))).isDirectory()).toBe(true);
      } finally {
        if (replacementServer) {
          await new Promise<void>((resolveClose) => replacementServer?.close(() => resolveClose()));
        }
      }
    },
  );

  it.each(["symlink", "hardlink", "socket"] as const)(
    "retains restore state when the pinned journal temporary becomes a %s",
    async (replacementKind) => {
      const isolated = await createDockerSetupSandbox();
      const shortStateRoot =
        replacementKind === "socket" ? await createShortVerifierStateRoot() : undefined;
      const transaction = await beginInterruptedVerifierTransaction(
        isolated,
        "env",
        shortStateRoot,
      );
      expect(
        transaction.interrupted.signal,
        `setup status=${transaction.interrupted.status}\nstderr:\n${transaction.interrupted.stderr}\nDocker stub log:\n${await readDockerLog(isolated)}`,
      ).toBe("SIGKILL");
      const victim = join(isolated.stateRoot, `journal-temp-${replacementKind}-victim`);
      const readyPath = join(isolated.stateRoot, `journal-temp-${replacementKind}-ready`);
      const continuePath = join(isolated.stateRoot, `journal-temp-${replacementKind}-continue`);
      await writeFile(victim, "victim-preserved\n", { mode: 0o600 });
      let replacementServer: ReturnType<typeof createServer> | undefined;
      const mutation = mutateAtRestoreJournalBarrier({
        readyPath,
        continuePath,
        mutate: async (temporaryName) => {
          const temporaryPath = join(transaction.transactionRoot, temporaryName);
          await rm(temporaryPath);
          if (replacementKind === "symlink") {
            await symlink(victim, temporaryPath);
          } else if (replacementKind === "hardlink") {
            await link(victim, temporaryPath);
          } else {
            replacementServer = createServer();
            await new Promise<void>((resolveListen, rejectListen) => {
              replacementServer?.once("error", rejectListen);
              replacementServer?.listen(temporaryPath, resolveListen);
            });
          }
        },
      });

      try {
        const [blocked] = await Promise.all([
          runVerifierDockerSetup(isolated, {
            ...transaction.verifierEnv,
            OPENCLAW_DOCKER_SETUP_TEST: "1",
            OPENCLAW_TEST_RESTORE_JOURNAL_READY: readyPath,
            OPENCLAW_TEST_RESTORE_JOURNAL_CONTINUE: continuePath,
          }),
          mutation,
        ]);

        expect(blocked.status).not.toBe(0);
        expect(blocked.stderr).toContain("retaining recovery state");
        expect(await readFile(victim, "utf8")).toBe("victim-preserved\n");
        expect(await readFile(transaction.journalPath, "utf8")).toContain("phase=begun");
        expect((await stat(transaction.transactionRoot)).isDirectory()).toBe(true);
        expect((await stat(join(transaction.verifierStateRoot, "lock"))).isDirectory()).toBe(true);
      } finally {
        if (replacementServer) {
          await new Promise<void>((resolveClose) => replacementServer?.close(() => resolveClose()));
        }
      }
    },
  );

  it.each(["symlink", "hardlink"] as const)(
    "retains restore state when the journaled temp becomes a %s",
    async (substituteKind) => {
      const isolated = await createDockerSetupSandbox();
      const transaction = await beginInterruptedVerifierTransaction(isolated);
      expect(transaction.interrupted.signal).toBe("SIGKILL");
      const backup = await readFile(transaction.backupPath);
      await writeFile(transaction.targetPath, "mutated-after-backup\n");
      const originalTarget = await lstat(transaction.targetPath);
      const temporaryName = `.openclaw-restore-${"2".repeat(32)}`;
      const temporaryPath = join(isolated.rootDir, temporaryName);
      await writeFile(temporaryPath, backup, { mode: 0o600 });
      const temporaryIdentity = await lstat(temporaryPath);
      await rewriteJournalValues(transaction.journalPath, {
        "restore-kind": "env",
        "restore-state": "temp-written",
        "restore-temp-name": temporaryName,
        "restore-temp-dev": String(temporaryIdentity.dev),
        "restore-temp-ino": String(temporaryIdentity.ino),
        "restore-target-present": "1",
        "restore-target-dev": String(originalTarget.dev),
        "restore-target-ino": String(originalTarget.ino),
      });
      const victim = join(isolated.stateRoot, `restore-temp-${substituteKind}-victim`);
      await writeFile(victim, "victim-preserved\n", { mode: 0o600 });
      await rm(temporaryPath);
      if (substituteKind === "symlink") {
        await symlink(victim, temporaryPath);
      } else {
        await link(victim, temporaryPath);
      }

      const blocked = await runVerifierDockerSetup(isolated, transaction.verifierEnv);

      expect(blocked.status).not.toBe(0);
      expect(blocked.stderr).toContain("retaining recovery state");
      expect(await readFile(victim, "utf8")).toBe("victim-preserved\n");
      expect((await stat(transaction.transactionRoot)).isDirectory()).toBe(true);
    },
  );

  it("does not overwrite a substituted target while resuming a journaled temp", async () => {
    const isolated = await createDockerSetupSandbox();
    const transaction = await beginInterruptedVerifierTransaction(isolated);
    expect(transaction.interrupted.signal).toBe("SIGKILL");
    const backup = await readFile(transaction.backupPath);
    await writeFile(transaction.targetPath, "mutated-after-backup\n");
    const originalTarget = await lstat(transaction.targetPath);
    const temporaryName = `.openclaw-restore-${"3".repeat(32)}`;
    const temporaryPath = join(isolated.rootDir, temporaryName);
    await writeFile(temporaryPath, backup, { mode: 0o600 });
    const temporaryIdentity = await lstat(temporaryPath);
    await rewriteJournalValues(transaction.journalPath, {
      "restore-kind": "env",
      "restore-state": "temp-written",
      "restore-temp-name": temporaryName,
      "restore-temp-dev": String(temporaryIdentity.dev),
      "restore-temp-ino": String(temporaryIdentity.ino),
      "restore-target-present": "1",
      "restore-target-dev": String(originalTarget.dev),
      "restore-target-ino": String(originalTarget.ino),
    });
    const victim = join(isolated.stateRoot, "restore-target-victim");
    await writeFile(victim, "victim-preserved\n");
    await rm(transaction.targetPath);
    await link(victim, transaction.targetPath);

    const blocked = await runVerifierDockerSetup(isolated, transaction.verifierEnv);

    expect(
      blocked.status,
      `setup stderr:\n${blocked.stderr}\nDocker stub log:\n${await readDockerLog(isolated)}`,
    ).not.toBe(0);
    expect(blocked.stderr).toContain("retaining recovery state");
    expect(await readFile(victim, "utf8")).toBe("victim-preserved\n");
    const victimAfter = await lstat(victim);
    const targetAfter = await lstat(transaction.targetPath);
    expect(targetAfter.ino).toBe(victimAfter.ino);
    expect(targetAfter.nlink).toBe(2);
    expect((await lstat(temporaryPath)).ino).toBe(temporaryIdentity.ino);
    expect(await readFile(transaction.journalPath, "utf8")).toContain("restore-state=temp-written");
    expect((await stat(transaction.transactionRoot)).isDirectory()).toBe(true);
    expect((await stat(join(transaction.verifierStateRoot, "lock"))).isDirectory()).toBe(true);
  });

  it.each([
    "candidate-",
    "published-",
    "openclaw-sandbox-verifier:bookworm-slim",
    "up -d --no-deps --force-recreate openclaw-gateway",
  ])("recovers exact transaction artifacts when a command fails after %s", async (failure) => {
    const isolated = await createDockerSetupSandbox();
    await writeFile(join(isolated.rootDir, "Dockerfile.sandbox-verifier"), "FROM scratch\n");
    const result = await runVerifierDockerSetup(isolated, {
      OPENCLAW_SANDBOX: "1",
      OPENCLAW_VERIFIER_WORKSPACE_DIR: isolated.rootDir,
      OPENCLAW_VERIFIER_GATEWAY_WORKSPACE: "/workspace/project",
      OPENCLAW_VERIFIER_PACKAGE_MANAGER: "yarn@4.9.2",
      DOCKER_STUB_FAIL_AFTER_MATCH: failure,
    });

    expect(result.status).not.toBe(0);
    const stateRoot = join(isolated.stateRoot, "operator-state", "openclaw", "verifier");
    await expect(stat(join(stateRoot, "transaction"))).rejects.toThrow();
    await expect(stat(join(stateRoot, "lock"))).rejects.toThrow();
    const envFile = await readFile(join(isolated.rootDir, ".env"), "utf8");
    expect(envFile).not.toContain(`OPENCLAW_VERIFIER_IMAGE_ID=sha256:${"e".repeat(64)}`);
  });

  it("forward-recovers a committed journal after replacing its stale lock owner", async () => {
    const isolated = await createDockerSetupSandbox();
    await writeFile(join(isolated.rootDir, "Dockerfile.sandbox-verifier"), "FROM scratch\n");
    const verifierEnv = {
      OPENCLAW_SANDBOX: "1",
      OPENCLAW_VERIFIER_WORKSPACE_DIR: isolated.rootDir,
      OPENCLAW_VERIFIER_GATEWAY_WORKSPACE: "/workspace/project",
      OPENCLAW_VERIFIER_PACKAGE_MANAGER: "yarn@4.9.2",
    };
    const interrupted = await runVerifierDockerSetup(isolated, {
      ...verifierEnv,
      DOCKER_STUB_FAIL_COUNT_MATCH: "image rm openclaw-sandbox-verifier:published-",
      DOCKER_STUB_FAIL_COUNT_LIMIT: "2",
    });
    const stateRoot = join(isolated.stateRoot, "operator-state", "openclaw", "verifier");

    expect(interrupted.status).not.toBe(0);
    expect(await readFile(join(stateRoot, "transaction", "journal"), "utf8")).toContain(
      "phase=committed",
    );
    expect(await stat(join(stateRoot, "lock", "pid"))).toBeDefined();

    const recovered = await runVerifierDockerSetup(isolated, verifierEnv);
    expect(recovered.status).toBe(0);
    await expect(stat(join(stateRoot, "transaction"))).rejects.toThrow();
    await expect(stat(join(stateRoot, "lock"))).rejects.toThrow();
    expect(await readDockerLog(isolated)).toContain("image-rm-fail-count-2");
  });

  it.each(["direct consumer", "dependent image"] as const)(
    "retains committed recovery state when old-image GC is blocked by a %s",
    async (description) => {
      const isolated = await createDockerSetupSandbox();
      await writeFile(join(isolated.rootDir, "Dockerfile.sandbox-verifier"), "FROM scratch\n");
      await writeFile(
        join(isolated.rootDir, ".env"),
        [
          "OPENCLAW_IMAGE=openclaw:local",
          "OPENCLAW_SANDBOX=1",
          `OPENCLAW_SOURCE_REVISION=${"a".repeat(40)}`,
          `OPENCLAW_VERIFIER_WORKSPACE_DIR=${isolated.rootDir}`,
          "OPENCLAW_VERIFIER_GATEWAY_WORKSPACE=/workspace/project",
          "OPENCLAW_VERIFIER_PACKAGE_MANAGER=yarn@4.9.2",
          `OPENCLAW_VERIFIER_IMAGE_ID=sha256:${"b".repeat(64)}`,
          `OPENCLAW_VERIFIER_ARTIFACT_DIGEST=${"3".repeat(64)}`,
          `OPENCLAW_VERIFIER_DEPENDENCY_MANIFEST=${"1".repeat(64)}`,
          `OPENCLAW_VERIFIER_BROWSER_MANIFEST=${"2".repeat(64)}`,
          `OPENCLAW_VERIFIER_REPOSITORY_IDENTITY=${"4".repeat(64)}`,
          `OPENCLAW_VERIFIER_BROWSER_IDENTITY=${"5".repeat(64)}`,
          "OPENCLAW_VERIFIER_EFFECTIVE_YARN_VERSION=4.9.2",
          "",
        ].join("\n"),
      );
      const verifierEnv = {
        OPENCLAW_SANDBOX: undefined,
        OPENCLAW_SOURCE_REVISION: undefined,
        OPENCLAW_VERIFIER_WORKSPACE_DIR: undefined,
        OPENCLAW_VERIFIER_GATEWAY_WORKSPACE: undefined,
        OPENCLAW_VERIFIER_PACKAGE_MANAGER: undefined,
        OPENCLAW_VERIFIER_IMAGE_ID: undefined,
        OPENCLAW_VERIFIER_ARTIFACT_DIGEST: undefined,
        OPENCLAW_VERIFIER_DEPENDENCY_MANIFEST: undefined,
        OPENCLAW_VERIFIER_BROWSER_MANIFEST: undefined,
        OPENCLAW_VERIFIER_REPOSITORY_IDENTITY: undefined,
        OPENCLAW_VERIFIER_BROWSER_IDENTITY: undefined,
        OPENCLAW_VERIFIER_EFFECTIVE_YARN_VERSION: undefined,
      };
      const blocked = await runVerifierDockerSetup(isolated, {
        ...verifierEnv,
        OPENCLAW_VERIFIER_GC_OLD_IMAGE: "1",
        DOCKER_STUB_CONSUMER_ID: description === "direct consumer" ? "f".repeat(64) : undefined,
        DOCKER_STUB_CONSUMER_IMAGE:
          description === "direct consumer" ? `sha256:${"b".repeat(64)}` : undefined,
        DOCKER_STUB_FAIL_COUNT_MATCH:
          description === "dependent image" ? `image rm sha256:${"b".repeat(64)}` : undefined,
        DOCKER_STUB_FAIL_COUNT_LIMIT: description === "dependent image" ? "2" : undefined,
      });
      const stateRoot = join(isolated.stateRoot, "operator-state", "openclaw", "verifier");

      expect(blocked.status).not.toBe(0);
      expect(await readFile(join(stateRoot, "transaction", "journal"), "utf8")).toContain(
        "phase=committed",
      );

      const recovered = await runVerifierDockerSetup(isolated, verifierEnv);
      expect(recovered.status).toBe(0);
      await expect(stat(join(stateRoot, "transaction"))).rejects.toThrow();
      await expect(stat(join(stateRoot, "lock"))).rejects.toThrow();
    },
  );

  it("loads the persisted verifier overlay before deriving setup defaults", async () => {
    const activeSandbox = requireSandbox(sandbox);
    await resetSharedDockerSetupFixture(activeSandbox);
    await writeFile(join(activeSandbox.rootDir, "Dockerfile.sandbox"), "FROM scratch\n");
    await writeFile(join(activeSandbox.rootDir, "Dockerfile.sandbox-verifier"), "FROM scratch\n");
    await writeFile(
      join(activeSandbox.rootDir, ".env"),
      [
        "OPENCLAW_IMAGE=openclaw:local",
        "OPENCLAW_SANDBOX=1",
        `OPENCLAW_SOURCE_REVISION=${"a".repeat(40)}`,
        `OPENCLAW_VERIFIER_WORKSPACE_DIR=${activeSandbox.rootDir}`,
        "OPENCLAW_VERIFIER_GATEWAY_WORKSPACE=/workspace/project",
        "OPENCLAW_VERIFIER_PACKAGE_MANAGER=yarn@4.9.2",
        `OPENCLAW_VERIFIER_IMAGE_ID=sha256:${"e".repeat(64)}`,
        `OPENCLAW_VERIFIER_ARTIFACT_DIGEST=${"3".repeat(64)}`,
        `OPENCLAW_VERIFIER_DEPENDENCY_MANIFEST=${"1".repeat(64)}`,
        `OPENCLAW_VERIFIER_BROWSER_MANIFEST=${"2".repeat(64)}`,
        `OPENCLAW_VERIFIER_REPOSITORY_IDENTITY=${"4".repeat(64)}`,
        `OPENCLAW_VERIFIER_BROWSER_IDENTITY=${"5".repeat(64)}`,
        "OPENCLAW_VERIFIER_EFFECTIVE_YARN_VERSION=4.9.2",
        "",
      ].join("\n"),
    );
    await resetDockerLog(activeSandbox);

    const result = await runVerifierDockerSetup(activeSandbox, {
      OPENCLAW_SANDBOX: undefined,
      OPENCLAW_SOURCE_REVISION: undefined,
      OPENCLAW_VERIFIER_WORKSPACE_DIR: undefined,
      OPENCLAW_VERIFIER_GATEWAY_WORKSPACE: undefined,
      OPENCLAW_VERIFIER_PACKAGE_MANAGER: undefined,
      OPENCLAW_VERIFIER_IMAGE_ID: undefined,
      OPENCLAW_VERIFIER_ARTIFACT_DIGEST: undefined,
      OPENCLAW_VERIFIER_DEPENDENCY_MANIFEST: undefined,
      OPENCLAW_VERIFIER_BROWSER_MANIFEST: undefined,
      OPENCLAW_VERIFIER_REPOSITORY_IDENTITY: undefined,
      OPENCLAW_VERIFIER_BROWSER_IDENTITY: undefined,
      OPENCLAW_VERIFIER_EFFECTIVE_YARN_VERSION: undefined,
    });

    const setupLog = await readDockerLog(activeSandbox);
    expect(result.status, `setup stderr:\n${result.stderr}\nDocker stub log:\n${setupLog}`).toBe(0);
    expect(setupLog).toContain("verifier-verify");
    const recreateLine = setupLog
      .split("\n")
      .find((line) => line.includes("up -d --no-deps --force-recreate openclaw-gateway"));
    expect(recreateLine).toContain(
      `-f ${join(activeSandbox.rootDir, "docker-compose.sandbox.yml")}`,
    );
  });

  it("rejects dirty, revision-mismatched, or non-Yarn verifier builds", async () => {
    const activeSandbox = requireSandbox(sandbox);
    await writeFile(join(activeSandbox.rootDir, "Dockerfile.sandbox"), "FROM scratch\n");
    await writeFile(join(activeSandbox.rootDir, "Dockerfile.sandbox-verifier"), "FROM scratch\n");
    const verifierEnv = {
      OPENCLAW_SANDBOX: "1",
      OPENCLAW_VERIFIER_WORKSPACE_DIR: activeSandbox.rootDir,
      OPENCLAW_VERIFIER_GATEWAY_WORKSPACE: "/workspace/project",
      OPENCLAW_VERIFIER_PACKAGE_MANAGER: "yarn@4.9.2",
    };
    const dirty = runDockerSetup(activeSandbox, {
      ...verifierEnv,
      GIT_STUB_DIRTY: "1",
    });
    expect(dirty.status).not.toBe(0);
    expect(dirty.stderr).toContain("clean local OpenClaw checkout");

    const mismatch = runDockerSetup(activeSandbox, {
      ...verifierEnv,
      GIT_STUB_REVISION: "b".repeat(40),
    });
    expect(mismatch.status).not.toBe(0);
    expect(mismatch.stderr).toContain("does not match the clean local checkout HEAD");

    const wrongPackageManager = runDockerSetup(activeSandbox, {
      ...verifierEnv,
      OPENCLAW_VERIFIER_PACKAGE_MANAGER: "pnpm@10.0.0",
    });
    expect(wrongPackageManager.status).not.toBe(0);
    expect(wrongPackageManager.stderr).toContain("exact pinned Yarn version");
  });

  it("rejects first-publication state inside the declared verifier workspace before mutation", async () => {
    const isolated = await createDockerSetupSandbox();
    await writeFile(join(isolated.rootDir, "Dockerfile.sandbox-verifier"), "FROM scratch\n");
    const unsafeState = join(isolated.rootDir, "operator-state", "openclaw", "verifier");

    const result = runDockerSetup(isolated, {
      OPENCLAW_SANDBOX: "1",
      OPENCLAW_VERIFIER_WORKSPACE_DIR: isolated.rootDir,
      OPENCLAW_VERIFIER_GATEWAY_WORKSPACE: "/workspace/project",
      OPENCLAW_VERIFIER_PACKAGE_MANAGER: "yarn@4.9.2",
      OPENCLAW_VERIFIER_STATE_ROOT: unsafeState,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("overlaps the declared verifier workspace");
    expect(await readDockerLog(isolated)).not.toContain("build ");
    await expect(stat(join(isolated.rootDir, ".env"))).rejects.toThrow();
    await expect(stat(unsafeState)).rejects.toThrow();
  });

  it("rejects symlinked and non-directory verifier state roots before publication", async () => {
    for (const kind of ["symlink", "file"] as const) {
      const isolated = await createDockerSetupSandbox();
      await writeFile(join(isolated.rootDir, "Dockerfile.sandbox-verifier"), "FROM scratch\n");
      const unsafeState = join(isolated.stateRoot, `unsafe-state-${kind}`);
      if (kind === "symlink") {
        const target = join(isolated.stateRoot, "state-target");
        await mkdir(target, { recursive: true });
        await symlink(target, unsafeState);
      } else {
        await writeFile(unsafeState, "not a directory");
      }

      const result = runDockerSetup(isolated, {
        OPENCLAW_SANDBOX: "1",
        OPENCLAW_VERIFIER_WORKSPACE_DIR: isolated.rootDir,
        OPENCLAW_VERIFIER_GATEWAY_WORKSPACE: "/workspace/project",
        OPENCLAW_VERIFIER_PACKAGE_MANAGER: "yarn@4.9.2",
        OPENCLAW_VERIFIER_STATE_ROOT: unsafeState,
      });

      expect(result.status).not.toBe(0);
      expect(await readDockerLog(isolated)).not.toContain("build ");
      await expect(stat(join(isolated.rootDir, ".env"))).rejects.toThrow();
    }
  });

  it.each(["lock", "transaction"] as const)(
    "rejects a dangling stale %s symlink before protected setup mutation",
    async (staleKind) => {
      const isolated = await createDockerSetupSandbox();
      await writeFile(join(isolated.rootDir, "Dockerfile.sandbox-verifier"), "FROM scratch\n");
      const envPath = join(isolated.rootDir, ".env");
      const envBefore = "PRESERVED_DANGLING_STATE=1\n";
      await writeFile(envPath, envBefore, { mode: 0o600 });
      const verifierStateRoot = join(isolated.stateRoot, "dangling-state", staleKind, "verifier");
      await mkdir(verifierStateRoot, { recursive: true, mode: 0o700 });
      const victim = join(isolated.stateRoot, `dangling-${staleKind}-victim`);
      const missingTarget = `${victim}.missing`;
      const stalePath = join(verifierStateRoot, staleKind);
      await writeFile(victim, "victim-preserved\n", { mode: 0o600 });
      await symlink(missingTarget, stalePath);
      await resetDockerLog(isolated);

      const result = await runVerifierDockerSetup(isolated, {
        OPENCLAW_SANDBOX: "1",
        OPENCLAW_VERIFIER_WORKSPACE_DIR: isolated.rootDir,
        OPENCLAW_VERIFIER_GATEWAY_WORKSPACE: "/workspace/project",
        OPENCLAW_VERIFIER_PACKAGE_MANAGER: "yarn@4.9.2",
        OPENCLAW_VERIFIER_STATE_ROOT: verifierStateRoot,
      });

      expect(
        result.status,
        `setup stderr:\n${result.stderr}\nDocker stub log:\n${await readDockerLog(isolated)}`,
      ).not.toBe(0);
      expect(await readFile(envPath, "utf8")).toBe(envBefore);
      expect(await readFile(victim, "utf8")).toBe("victim-preserved\n");
      expect((await lstat(stalePath)).isSymbolicLink()).toBe(true);
      expect(await readlink(stalePath)).toBe(missingTarget);
      const otherStatePath = join(verifierStateRoot, staleKind === "lock" ? "transaction" : "lock");
      await expect(lstat(otherStatePath)).rejects.toThrow();
      const log = await readDockerLog(isolated);
      expect(log).not.toContain("build ");
      expect(log).not.toContain(" config set ");
      expect(log).not.toContain(" up -d");
    },
  );

  it.each(["symlink", "directory", "socket"] as const)(
    "rejects a %s replacement of the pinned verifier state root before protected mutation",
    async (replacementKind) => {
      const isolated = await createDockerSetupSandbox();
      await writeFile(join(isolated.rootDir, "Dockerfile.sandbox-verifier"), "FROM scratch\n");
      const envPath = join(isolated.rootDir, ".env");
      const envBefore = "PRESERVED_PINNED_STATE=1\n";
      await writeFile(envPath, envBefore, { mode: 0o600 });
      const verifierStateRoot = await createShortVerifierStateRoot();
      const shortParent = dirname(verifierStateRoot);
      const displacedStateRoot = join(shortParent, `v-pinned-${replacementKind}`);
      const victimDirectory = join(isolated.stateRoot, `state-root-${replacementKind}-victim`);
      const victimMarker = join(victimDirectory, "marker");
      const replacementMarker = join(verifierStateRoot, "attacker-marker");
      const readyPath = join(isolated.stateRoot, `state-root-${replacementKind}-ready`);
      const continuePath = join(isolated.stateRoot, `state-root-${replacementKind}-continue`);
      await mkdir(victimDirectory, { recursive: true, mode: 0o755 });
      await writeFile(victimMarker, "victim-preserved\n", { mode: 0o600 });
      await resetDockerLog(isolated);
      let replacementServer: ReturnType<typeof createServer> | undefined;
      const mutation = mutateAtStateRootBarrier({
        readyPath,
        continuePath,
        stateRoot: verifierStateRoot,
        mutate: async () => {
          const pinnedIdentity = await lstat(verifierStateRoot);
          await rename(verifierStateRoot, displacedStateRoot);
          if (replacementKind === "symlink") {
            await symlink(victimDirectory, verifierStateRoot);
          } else if (replacementKind === "directory") {
            await mkdir(verifierStateRoot, { mode: 0o755 });
            await writeFile(replacementMarker, "replacement-preserved\n", { mode: 0o600 });
          } else {
            replacementServer = createServer();
            await new Promise<void>((resolveListen, rejectListen) => {
              replacementServer?.once("error", rejectListen);
              replacementServer?.listen(verifierStateRoot, resolveListen);
            });
          }
          return pinnedIdentity;
        },
      });

      try {
        const [blocked, pinnedIdentity] = await Promise.all([
          runVerifierDockerSetup(isolated, {
            OPENCLAW_SANDBOX: "1",
            OPENCLAW_VERIFIER_WORKSPACE_DIR: isolated.rootDir,
            OPENCLAW_VERIFIER_GATEWAY_WORKSPACE: "/workspace/project",
            OPENCLAW_VERIFIER_PACKAGE_MANAGER: "yarn@4.9.2",
            OPENCLAW_VERIFIER_STATE_ROOT: verifierStateRoot,
            OPENCLAW_DOCKER_SETUP_TEST: "1",
            OPENCLAW_TEST_STATE_ROOT_READY: readyPath,
            OPENCLAW_TEST_STATE_ROOT_CONTINUE: continuePath,
          }),
          mutation,
        ]);

        expect(
          blocked.status,
          `setup stderr:\n${blocked.stderr}\nDocker stub log:\n${await readDockerLog(isolated)}`,
        ).not.toBe(0);
        expect(blocked.stderr).toContain("state root identity changed after pinning");
        expect(await readFile(envPath, "utf8")).toBe(envBefore);
        expect(await readFile(victimMarker, "utf8")).toBe("victim-preserved\n");
        const retainedState = await stat(displacedStateRoot);
        expect(retainedState.isDirectory()).toBe(true);
        expect(retainedState.dev).toBe(pinnedIdentity.dev);
        expect(retainedState.ino).toBe(pinnedIdentity.ino);
        expect(retainedState.mode & 0o777).toBe(0o700);
        expect(await readdir(displacedStateRoot)).toEqual([".state-instance"]);
        if (replacementKind === "symlink") {
          expect((await lstat(verifierStateRoot)).isSymbolicLink()).toBe(true);
          expect(await readlink(verifierStateRoot)).toBe(victimDirectory);
          expect(await readdir(victimDirectory)).toEqual(["marker"]);
          expect((await stat(victimDirectory)).mode & 0o777).toBe(0o755);
        } else if (replacementKind === "directory") {
          expect((await stat(verifierStateRoot)).isDirectory()).toBe(true);
          expect((await stat(verifierStateRoot)).mode & 0o777).toBe(0o755);
          expect(await readdir(verifierStateRoot)).toEqual(["attacker-marker"]);
          expect(await readFile(replacementMarker, "utf8")).toBe("replacement-preserved\n");
        } else {
          expect((await lstat(verifierStateRoot)).isSocket()).toBe(true);
        }
        const log = await readDockerLog(isolated);
        expect(log).not.toContain("build ");
        expect(log).not.toContain(" config set ");
        expect(log).not.toContain(" up -d");
      } finally {
        if (replacementServer) {
          await new Promise<void>((resolveClose) => replacementServer?.close(() => resolveClose()));
        }
      }
    },
  );

  it.each(["directory", "symlink"] as const)(
    "retains and recovers a durable begun transaction after post-begin state-root %s replacement",
    async (replacementKind) => {
      const isolated = await createDockerSetupSandbox();
      await writeFile(join(isolated.rootDir, "Dockerfile.sandbox-verifier"), "FROM scratch\n");
      const envPath = join(isolated.rootDir, ".env");
      await writeFile(envPath, "PRESERVED_POST_BEGIN_STATE=1\n", { mode: 0o600 });
      const verifierStateRoot = await createShortVerifierStateRoot();
      const shortParent = dirname(verifierStateRoot);
      const displacedStateRoot = join(shortParent, `v-displaced-${replacementKind}`);
      const victimDirectory = join(isolated.stateRoot, `post-begin-${replacementKind}-victim`);
      const victimMarker = join(victimDirectory, "marker");
      const replacementMarker = join(verifierStateRoot, "attacker-marker");
      const readyPath = join(isolated.stateRoot, `post-begin-${replacementKind}-ready`);
      const continuePath = join(isolated.stateRoot, `post-begin-${replacementKind}-continue`);
      const verifierEnv = {
        OPENCLAW_SANDBOX: "1",
        OPENCLAW_CONFIG_DIR: join(isolated.rootDir, "config"),
        OPENCLAW_VERIFIER_WORKSPACE_DIR: isolated.rootDir,
        OPENCLAW_VERIFIER_GATEWAY_WORKSPACE: "/workspace/project",
        OPENCLAW_VERIFIER_PACKAGE_MANAGER: "yarn@4.9.2",
        OPENCLAW_VERIFIER_STATE_ROOT: verifierStateRoot,
      };
      await mkdir(victimDirectory, { recursive: true, mode: 0o755 });
      await writeFile(victimMarker, "victim-preserved\n", { mode: 0o600 });
      await resetDockerLog(isolated);

      const mutation = mutateAtTransactionStateBarrier({
        readyPath,
        continuePath,
        phase: "begun",
        stateRoot: verifierStateRoot,
        mutate: async () => {
          const pinnedIdentity = await lstat(verifierStateRoot);
          const envAtBarrier = await readFile(envPath);
          const dockerLogAtBarrier = await readDockerLog(isolated);
          await rename(verifierStateRoot, displacedStateRoot);
          if (replacementKind === "directory") {
            await mkdir(verifierStateRoot, { mode: 0o755 });
            await writeFile(replacementMarker, "replacement-preserved\n", { mode: 0o600 });
          } else {
            await symlink(victimDirectory, verifierStateRoot);
          }
          return { dockerLogAtBarrier, envAtBarrier, pinnedIdentity };
        },
      });

      const [interrupted, captured] = await Promise.all([
        runVerifierDockerSetup(isolated, {
          ...verifierEnv,
          OPENCLAW_DOCKER_SETUP_TEST: "1",
          OPENCLAW_TEST_TRANSACTION_STATE_PHASE: "begun",
          OPENCLAW_TEST_TRANSACTION_STATE_READY: readyPath,
          OPENCLAW_TEST_TRANSACTION_STATE_CONTINUE: continuePath,
          OPENCLAW_TEST_TRANSACTION_STATE_SIGKILL: "1",
        }),
        mutation,
      ]);

      expect(interrupted.signal).toBe("SIGKILL");
      expect(await readFile(envPath)).toEqual(captured.envAtBarrier);
      expect(await readDockerLog(isolated)).toBe(captured.dockerLogAtBarrier);
      const retainedState = await stat(displacedStateRoot);
      expect(retainedState.dev).toBe(captured.pinnedIdentity.dev);
      expect(retainedState.ino).toBe(captured.pinnedIdentity.ino);
      expect(retainedState.mode & 0o777).toBe(0o700);
      expect(await readFile(join(displacedStateRoot, "transaction", "journal"), "utf8")).toContain(
        "phase=begun",
      );
      expect(await stat(join(displacedStateRoot, "lock", "pid"))).toBeDefined();
      const markerNames = (await readdir(shortParent)).filter((name) =>
        /^\.openclaw-verifier-active-[a-f0-9]{64}$/u.test(name),
      );
      expect(markerNames).toHaveLength(1);
      const [markerName] = markerNames;
      if (!markerName) {
        throw new Error("Expected one active-state marker.");
      }
      const markerPath = join(shortParent, markerName);
      expect((await stat(markerPath)).mode & 0o777).toBe(0o600);
      const marker = JSON.parse(await readFile(markerPath, "utf8")) as {
        contractVersion: number;
        markerState: string;
        operationId: string;
        operationBinding: string;
        parentDev: string;
        parentIno: string;
        stateDev: string;
        stateIno: string;
        statePath: string;
        stateTokenDigest: string;
        transactionFormat: string;
        configPolicy: string;
      };
      const stateToken = (
        await readFile(join(displacedStateRoot, ".state-instance"), "utf8")
      ).trim();
      const stateTokenDigest = createHash("sha256").update(stateToken).digest("hex");
      expect(marker).toMatchObject({
        contractVersion: 3,
        markerState: "active",
        parentDev: String((await stat(shortParent)).dev),
        parentIno: String((await stat(shortParent)).ino),
        stateDev: String(captured.pinnedIdentity.dev),
        stateIno: String(captured.pinnedIdentity.ino),
        statePath: verifierStateRoot,
        stateTokenDigest,
        transactionFormat: "2",
        configPolicy: "write",
      });
      expect(marker.operationId).toMatch(/^[a-f0-9]{32}$/u);
      expect(marker.operationBinding).toBe(
        createHash("sha256")
          .update(
            `${stateTokenDigest}\0${marker.operationId}\0${marker.transactionFormat}\0${marker.configPolicy}`,
          )
          .digest("hex"),
      );
      if (replacementKind === "directory") {
        expect(await readFile(replacementMarker, "utf8")).toBe("replacement-preserved\n");
      } else {
        expect((await lstat(verifierStateRoot)).isSymbolicLink()).toBe(true);
        expect(await readlink(verifierStateRoot)).toBe(victimDirectory);
        expect(await readFile(victimMarker, "utf8")).toBe("victim-preserved\n");
      }

      await resetDockerLog(isolated);
      const blockedRetry = await runVerifierDockerSetup(isolated, verifierEnv);
      expect(blockedRetry.status).not.toBe(0);
      if (replacementKind === "directory") {
        expect(blockedRetry.stderr).toContain("Active verifier state expects");
        expect(blockedRetry.stderr).toContain(`retained at ${JSON.stringify(displacedStateRoot)}`);
      } else {
        expect(blockedRetry.stderr).toContain("state root or workspace is not safely canonical");
      }
      expect(await readFile(envPath)).toEqual(captured.envAtBarrier);
      expect(await readFile(join(displacedStateRoot, "transaction", "journal"), "utf8")).toContain(
        "phase=begun",
      );
      const retryLog = await readDockerLog(isolated);
      expect(retryLog).not.toContain("build ");
      expect(retryLog).not.toContain(" config set ");
      expect(retryLog).not.toContain(" up -d");

      if (replacementKind === "directory") {
        await rm(verifierStateRoot, { recursive: true });
      } else {
        await rm(verifierStateRoot);
      }
      await rename(displacedStateRoot, verifierStateRoot);
      const recovered = await runVerifierDockerSetup(isolated, verifierEnv);
      expect(recovered.status).not.toBe(0);
      expect(await readFile(envPath)).toEqual(captured.envAtBarrier);
      await expect(stat(join(verifierStateRoot, "transaction"))).rejects.toThrow();
      await expect(stat(join(verifierStateRoot, "lock"))).rejects.toThrow();
      await expect(stat(markerPath)).rejects.toThrow();
      expect(await readFile(join(verifierStateRoot, ".state-instance"), "utf8")).toBe(
        `${stateToken}\n`,
      );
      expect(await readFile(victimMarker, "utf8")).toBe("victim-preserved\n");
    },
  );

  it.each([
    {
      description: "malformed JSON",
      rewrite: () => "{not-json}\n",
    },
    {
      description: "unknown field",
      rewrite: (marker: ActiveStateMarker) =>
        `${JSON.stringify({ ...marker, unexpected: true })}\n`,
    },
    {
      description: "missing field",
      rewrite: (marker: ActiveStateMarker) => {
        const value = { ...marker } as Partial<ActiveStateMarker>;
        delete value.stateTokenDigest;
        return `${JSON.stringify(value)}\n`;
      },
    },
    {
      description: "duplicate field",
      rewrite: (marker: ActiveStateMarker) =>
        `${JSON.stringify(marker).replace(
          '"contractVersion":2',
          '"contractVersion":2,"contractVersion":2',
        )}\n`,
    },
  ])("rejects active-state marker $description before mutation", async ({ rewrite }) => {
    const fixture = await createActiveStateMarkerFixture();
    const raw = rewrite(fixture.marker);
    await writeFile(fixture.markerPath, raw, { mode: 0o600 });

    await expectActiveStateMarkerRejection(fixture);

    expect(await readFile(fixture.markerPath, "utf8")).toBe(raw);
    expect(await readFile(fixture.tokenPath, "utf8")).toBe(`${fixture.token}\n`);
  });

  it.each(["wrong-mode", "wrong-owner", "symlink", "hardlink", "socket"] as const)(
    "rejects an active-state marker with unsafe %s metadata before mutation",
    async (markerKind) => {
      const fixture = await createActiveStateMarkerFixture();
      const victim = join(fixture.sandbox.stateRoot, `active-marker-${markerKind}-victim`);
      const markerRaw = `${JSON.stringify(fixture.marker)}\n`;
      const markerParentBefore = await stat(fixture.stateParent);
      const markerParentEntriesBefore = (await readdir(fixture.stateParent)).toSorted();
      let markerServer: ReturnType<typeof createServer> | undefined;
      let shortSocketParent: string | undefined;
      try {
        if (markerKind === "wrong-mode") {
          await chmod(fixture.markerPath, 0o644);
        } else if (markerKind === "symlink") {
          await writeFile(victim, markerRaw, { mode: 0o600 });
          await rm(fixture.markerPath);
          await symlink(victim, fixture.markerPath);
        } else if (markerKind === "hardlink") {
          await writeFile(victim, markerRaw, { mode: 0o600 });
          await rm(fixture.markerPath);
          await link(victim, fixture.markerPath);
        } else if (markerKind === "socket") {
          shortSocketParent = await mkdtemp("/tmp/oc-s-");
          await chmod(shortSocketParent, 0o700);
          const shortSocketPath = join(shortSocketParent, "s");
          await writeFile(victim, "victim-preserved\n", { mode: 0o600 });
          await rm(fixture.markerPath);
          const activeMarkerServer = createServer();
          markerServer = activeMarkerServer;
          await new Promise<void>((resolveListen, rejectListen) => {
            activeMarkerServer.once("error", rejectListen);
            activeMarkerServer.listen(shortSocketPath, resolveListen);
          });
          await rename(shortSocketPath, fixture.markerPath);
        }

        const result = await expectActiveStateMarkerRejection(
          fixture,
          markerKind === "wrong-owner"
            ? {
                OPENCLAW_DOCKER_SETUP_TEST: "1",
                OPENCLAW_TEST_MARKER_OWNER_MISMATCH: "1",
              }
            : {},
        );

        expect(result.error).toBeUndefined();
        expect(result.signal).toBeNull();
        expect(result.stderr).toContain("active-state marker contract is unsafe");
        expect(await readFile(fixture.tokenPath, "utf8")).toBe(`${fixture.token}\n`);
        const markerParentAfter = await stat(fixture.stateParent);
        expect({
          dev: markerParentAfter.dev,
          ino: markerParentAfter.ino,
          mode: markerParentAfter.mode,
          uid: markerParentAfter.uid,
        }).toEqual({
          dev: markerParentBefore.dev,
          ino: markerParentBefore.ino,
          mode: markerParentBefore.mode,
          uid: markerParentBefore.uid,
        });
        expect((await readdir(fixture.stateParent)).toSorted()).toEqual(markerParentEntriesBefore);
        if (markerKind === "symlink") {
          expect((await lstat(fixture.markerPath)).isSymbolicLink()).toBe(true);
          expect(await readlink(fixture.markerPath)).toBe(victim);
          expect(await readFile(victim, "utf8")).toBe(markerRaw);
        } else if (markerKind === "hardlink") {
          expect((await stat(victim)).nlink).toBe(2);
          expect(await readFile(victim, "utf8")).toBe(markerRaw);
        } else if (markerKind === "socket") {
          expect((await lstat(fixture.markerPath)).isSocket()).toBe(true);
          expect(await readFile(victim, "utf8")).toBe("victim-preserved\n");
          expect(await readDockerLog(fixture.sandbox)).toBe("");
        } else {
          expect(await readFile(fixture.markerPath, "utf8")).toBe(markerRaw);
        }
      } finally {
        try {
          if (markerServer) {
            const activeMarkerServer = markerServer;
            await new Promise<void>((resolveClose, rejectClose) => {
              const deadline = setTimeout(() => {
                activeMarkerServer.unref();
                rejectClose(new Error("Timed out closing active-marker socket fixture."));
              }, 2_000);
              activeMarkerServer.close((error) => {
                clearTimeout(deadline);
                if (error) {
                  rejectClose(error);
                } else {
                  resolveClose();
                }
              });
            });
          }
        } finally {
          if (markerKind === "socket") {
            await rm(fixture.markerPath, { force: true });
          }
          if (shortSocketParent) {
            await rm(shortSocketParent, { recursive: true, force: true });
          }
        }
      }
    },
  );

  it.each([
    {
      description: "canonical path",
      rewrite: (marker: ActiveStateMarker) => ({
        ...marker,
        statePath: `${marker.statePath}-other`,
      }),
    },
    {
      description: "device",
      rewrite: (marker: ActiveStateMarker) => ({ ...marker, stateDev: "0" }),
    },
    {
      description: "inode",
      rewrite: (marker: ActiveStateMarker) => ({ ...marker, stateIno: "0" }),
    },
    {
      description: "state token",
      rewrite: (marker: ActiveStateMarker) => ({
        ...marker,
        stateTokenDigest: "3".repeat(64),
      }),
    },
    {
      description: "operation replay binding",
      rewrite: (marker: ActiveStateMarker) => ({
        ...marker,
        operationId: "4".repeat(32),
      }),
    },
  ])("rejects an active-state marker with the wrong $description", async ({ rewrite }) => {
    const fixture = await createActiveStateMarkerFixture();
    const altered = rewrite(fixture.marker);
    const raw = `${JSON.stringify(altered)}\n`;
    await writeFile(fixture.markerPath, raw, { mode: 0o600 });

    await expectActiveStateMarkerRejection(fixture);

    expect(await readFile(fixture.markerPath, "utf8")).toBe(raw);
    expect(await readFile(fixture.tokenPath, "utf8")).toBe(`${fixture.token}\n`);
  });

  it.each(["missing", "corrupt"] as const)(
    "rejects an active marker when its state-instance token is %s",
    async (tokenKind) => {
      const fixture = await createActiveStateMarkerFixture();
      if (tokenKind === "missing") {
        await rm(fixture.tokenPath);
      } else {
        await writeFile(fixture.tokenPath, "corrupt\n", { mode: 0o600 });
      }

      await expectActiveStateMarkerRejection(fixture);

      expect(await readFile(fixture.markerPath, "utf8")).toBe(
        `${JSON.stringify(fixture.marker)}\n`,
      );
      if (tokenKind === "missing") {
        await expect(stat(fixture.tokenPath)).rejects.toThrow();
      } else {
        expect(await readFile(fixture.tokenPath, "utf8")).toBe("corrupt\n");
      }
    },
  );

  it("rejects a stale active operation marker without matching transaction state", async () => {
    const fixture = await createActiveStateMarkerFixture();

    const result = await expectActiveStateMarkerRejection(fixture);

    expect(result.stderr).toContain("no matching lock or transaction");
    expect(await readFile(fixture.markerPath, "utf8")).toBe(`${JSON.stringify(fixture.marker)}\n`);
    expect(await readFile(fixture.tokenPath, "utf8")).toBe(`${fixture.token}\n`);
  });

  it("does not authenticate a replacement state root from injected inode identity alone", async () => {
    const fixture = await createActiveStateMarkerFixture();
    const displaced = join(fixture.stateParent, "v-displaced-inode-reuse");
    await rename(fixture.stateRoot, displaced);
    await mkdir(fixture.stateRoot, { mode: 0o700 });
    await writeFile(join(fixture.stateRoot, ".state-instance"), `${"5".repeat(64)}\n`, {
      mode: 0o600,
    });
    const replacementMarker = join(fixture.stateRoot, "replacement-preserved");
    await writeFile(replacementMarker, "replacement\n", { mode: 0o600 });

    const result = await expectActiveStateMarkerRejection(fixture, {
      OPENCLAW_DOCKER_SETUP_TEST: "1",
      OPENCLAW_TEST_STATE_IDENTITY_ALIASES: fixture.stateRoot,
    });

    expect(result.stderr).toContain(`retained at ${JSON.stringify(displaced)}`);
    expect(await readFile(replacementMarker, "utf8")).toBe("replacement\n");
    expect(await readFile(join(displaced, ".state-instance"), "utf8")).toBe(`${fixture.token}\n`);
  });

  it("rejects ambiguous immediate-child state-instance matches without broad cleanup", async () => {
    const fixture = await createActiveStateMarkerFixture();
    await rm(fixture.stateRoot, { recursive: true });
    await mkdir(fixture.stateRoot, { mode: 0o700 });
    await writeFile(join(fixture.stateRoot, ".state-instance"), `${"6".repeat(64)}\n`, {
      mode: 0o600,
    });
    const matchingChildren = [
      join(fixture.stateParent, "matching-state-a"),
      join(fixture.stateParent, "matching-state-b"),
    ];
    for (const child of matchingChildren) {
      await mkdir(child, { mode: 0o700 });
      await writeFile(join(child, ".state-instance"), `${fixture.token}\n`, { mode: 0o600 });
      await writeFile(join(child, "preserved"), `${child}\n`, { mode: 0o600 });
    }

    const result = await expectActiveStateMarkerRejection(fixture, {
      OPENCLAW_DOCKER_SETUP_TEST: "1",
      OPENCLAW_TEST_STATE_IDENTITY_ALIASES: [fixture.stateRoot, ...matchingChildren].join("|"),
    });

    expect(result.stderr).toContain("with 2 matching direct children");
    for (const child of matchingChildren) {
      expect(await readFile(join(child, "preserved"), "utf8")).toBe(`${child}\n`);
    }
  });

  it.each(["insecure-mode", "symlink", "replacement"] as const)(
    "rejects an unsafe active-state marker parent %s",
    async (parentKind) => {
      const fixture = await createActiveStateMarkerFixture();
      const displacedParent = `${fixture.stateParent}-displaced-${parentKind}`;
      if (parentKind === "insecure-mode") {
        await chmod(fixture.stateParent, 0o777);
      } else {
        await rename(fixture.stateParent, displacedParent);
        onTestFinished(async () => {
          await rm(displacedParent, { recursive: true, force: true });
        });
        if (parentKind === "symlink") {
          await symlink(displacedParent, fixture.stateParent);
        } else {
          await mkdir(fixture.stateParent, { mode: 0o700 });
          await mkdir(fixture.stateRoot, { mode: 0o700 });
          await copyFile(join(displacedParent, "v", ".state-instance"), fixture.tokenPath);
          await copyFile(
            join(displacedParent, fixture.markerPath.slice(fixture.stateParent.length + 1)),
            fixture.markerPath,
          );
        }
      }

      await expectActiveStateMarkerRejection(fixture);

      if (parentKind === "insecure-mode") {
        expect((await stat(fixture.stateParent)).mode & 0o777).toBe(0o777);
      } else if (parentKind === "symlink") {
        expect((await lstat(fixture.stateParent)).isSymbolicLink()).toBe(true);
      } else {
        expect(await readFile(fixture.markerPath, "utf8")).toBe(
          `${JSON.stringify(fixture.marker)}\n`,
        );
      }
    },
  );

  it.each([
    { description: "writable", readOnly: "false" },
    { description: "read-only", readOnly: "true" },
  ])(
    "rejects verifier transaction state inside a $description Gateway bind",
    async ({ readOnly }) => {
      const isolated = await createDockerSetupSandbox();
      await writeFile(join(isolated.rootDir, "Dockerfile.sandbox-verifier"), "FROM scratch\n");
      const configDir = await createShortVerifierStateRoot();
      const workspaceDir = join(isolated.rootDir, `workspace-unsafe-state-${readOnly}`);
      const envPath = join(isolated.rootDir, ".env");
      const envBefore = `PRESERVED_GATEWAY_BIND_${readOnly}=1\n`;
      const stateToken = "7".repeat(64);
      await writeFile(envPath, envBefore, { mode: 0o600 });
      await writeFile(join(configDir, ".state-instance"), `${stateToken}\n`, { mode: 0o600 });
      await resetDockerLog(isolated);
      const result = await runVerifierDockerSetup(isolated, {
        OPENCLAW_CONFIG_DIR: configDir,
        OPENCLAW_WORKSPACE_DIR: workspaceDir,
        OPENCLAW_SANDBOX: "1",
        OPENCLAW_VERIFIER_WORKSPACE_DIR: isolated.rootDir,
        OPENCLAW_VERIFIER_GATEWAY_WORKSPACE: "/workspace/project",
        OPENCLAW_VERIFIER_PACKAGE_MANAGER: "yarn@4.9.2",
        OPENCLAW_VERIFIER_STATE_ROOT: configDir,
        DOCKER_STUB_CONFIG_READ_ONLY: readOnly,
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("not isolated from Gateway binds");
      expect(await readDockerLog(isolated)).not.toContain("build ");
      expect(await readFile(envPath, "utf8")).toBe(envBefore);
      expect(await readFile(join(configDir, ".state-instance"), "utf8")).toBe(`${stateToken}\n`);
    },
  );

  it("precreates config identity dir for CLI device auth writes", async () => {
    const activeSandbox = requireSandbox(sandbox);
    const configDir = join(activeSandbox.rootDir, "config-identity");
    const workspaceDir = join(activeSandbox.rootDir, "workspace-identity");

    const result = runDockerSetup(activeSandbox, {
      OPENCLAW_CONFIG_DIR: configDir,
      OPENCLAW_WORKSPACE_DIR: workspaceDir,
    });

    expect(result.status).toBe(0);
    const identityDirStat = await stat(join(configDir, "identity"));
    expect(identityDirStat.isDirectory()).toBe(true);
  });

  it("writes OPENCLAW_TZ into .env when given a real IANA timezone", async () => {
    const activeSandbox = requireSandbox(sandbox);

    const result = runDockerSetup(activeSandbox, {
      OPENCLAW_TZ: "Asia/Shanghai",
    });

    expect(result.status).toBe(0);
    const envFile = await readFile(join(activeSandbox.rootDir, ".env"), "utf8");
    expect(envFile).toContain("OPENCLAW_TZ=Asia/Shanghai");
  });

  it("precreates agent data dirs to avoid EACCES in container", async () => {
    const activeSandbox = requireSandbox(sandbox);
    const configDir = join(activeSandbox.rootDir, "config-agent-dirs");
    const workspaceDir = join(activeSandbox.rootDir, "workspace-agent-dirs");

    const result = runDockerSetup(activeSandbox, {
      OPENCLAW_CONFIG_DIR: configDir,
      OPENCLAW_WORKSPACE_DIR: workspaceDir,
    });

    expect(result.status).toBe(0);
    const agentDirStat = await stat(join(configDir, "agents", "main", "agent"));
    expect(agentDirStat.isDirectory()).toBe(true);
    const sessionsDirStat = await stat(join(configDir, "agents", "main", "sessions"));
    expect(sessionsDirStat.isDirectory()).toBe(true);

    // Verify that a root-user chown step runs before setup.
    const log = await readDockerLog(activeSandbox);
    const chownIdx = log.indexOf("--user root");
    const onboardIdx = log.indexOf("onboard");
    expect(chownIdx).toBeGreaterThanOrEqual(0);
    expect(onboardIdx).toBeGreaterThan(chownIdx);
    expect(log).toContain("run --rm --no-deps --user root --entrypoint sh openclaw-gateway -c");
  });

  it("reuses existing config token when OPENCLAW_GATEWAY_TOKEN is unset", async () => {
    const activeSandbox = requireSandbox(sandbox);
    const { result, envFile } = await runDockerSetupWithUnsetGatewayToken(
      activeSandbox,
      "token-reuse",
      async (configDir) => {
        await writeFile(
          join(configDir, "openclaw.json"),
          JSON.stringify({ gateway: { auth: { mode: "token", token: "config-token-123" } } }),
        );
      },
    );

    expect(result.status).toBe(0);
    expect(envFile).toContain("OPENCLAW_GATEWAY_TOKEN=config-token-123"); // pragma: allowlist secret
  });

  it("reuses existing .env token when OPENCLAW_GATEWAY_TOKEN and config token are unset", async () => {
    const activeSandbox = requireSandbox(sandbox);
    await writeFile(
      join(activeSandbox.rootDir, ".env"),
      "OPENCLAW_GATEWAY_TOKEN=dotenv-token-123\nOPENCLAW_GATEWAY_PORT=18789\n", // pragma: allowlist secret
    );
    const { result, envFile } = await runDockerSetupWithUnsetGatewayToken(
      activeSandbox,
      "dotenv-token-reuse",
    );

    expect(result.status).toBe(0);
    expect(envFile).toContain("OPENCLAW_GATEWAY_TOKEN=dotenv-token-123"); // pragma: allowlist secret
    expect(result.stderr).toBe("");
  });

  it("reuses the last non-empty .env token and strips CRLF without truncating '='", async () => {
    const activeSandbox = requireSandbox(sandbox);
    await writeFile(
      join(activeSandbox.rootDir, ".env"),
      [
        "OPENCLAW_GATEWAY_TOKEN=",
        "OPENCLAW_GATEWAY_TOKEN=first-token",
        "OPENCLAW_GATEWAY_TOKEN=last=token=value\r", // pragma: allowlist secret
      ].join("\n"),
    );
    const { result, envFile } = await runDockerSetupWithUnsetGatewayToken(
      activeSandbox,
      "dotenv-last-wins",
    );

    expect(result.status).toBe(0);
    expect(envFile).toContain("OPENCLAW_GATEWAY_TOKEN=last=token=value"); // pragma: allowlist secret
    expect(envFile).not.toContain("OPENCLAW_GATEWAY_TOKEN=first-token");
    expect(envFile).not.toContain("\r");
  });

  it("treats OPENCLAW_SANDBOX=0 as disabled", async () => {
    const activeSandbox = requireSandbox(sandbox);
    await resetDockerLog(activeSandbox);

    const result = runDockerSetup(activeSandbox, {
      OPENCLAW_SANDBOX: "0",
    });

    expect(result.status).toBe(0);
    const envFile = await readFile(join(activeSandbox.rootDir, ".env"), "utf8");
    expect(envFile).toContain("OPENCLAW_SANDBOX=");

    const log = await readDockerLog(activeSandbox);
    expect(log).toContain("--build-arg OPENCLAW_INSTALL_DOCKER_CLI=");
    expect(log).not.toContain("--build-arg OPENCLAW_INSTALL_DOCKER_CLI=1");
    expect(log).toContain("config set agents.defaults.sandbox.mode off");
  });

  it("resets stale sandbox mode and overlay when sandbox is not active", async () => {
    const activeSandbox = requireSandbox(sandbox);
    await resetDockerLog(activeSandbox);
    await writeFile(
      join(activeSandbox.rootDir, "docker-compose.sandbox.yml"),
      "services:\n  openclaw-gateway:\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\n",
    );

    const result = runDockerSetup(activeSandbox, {
      OPENCLAW_SANDBOX: "1",
      DOCKER_STUB_FAIL_MATCH: "--entrypoint docker openclaw-gateway --version",
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("Sandbox requires Docker CLI");
    const log = await readDockerLog(activeSandbox);
    expect(log).toContain("config set agents.defaults.sandbox.mode off");
    await expect(stat(join(activeSandbox.rootDir, "docker-compose.sandbox.yml"))).rejects.toThrow();
  });

  it("skips sandbox gateway restart when sandbox config writes fail", async () => {
    const activeSandbox = requireSandbox(sandbox);
    await resetDockerLog(activeSandbox);
    const socketPath = join(activeSandbox.rootDir, "sandbox.sock");

    await withUnixSocket(socketPath, async () => {
      const result = runDockerSetup(activeSandbox, {
        OPENCLAW_SANDBOX: "1",
        OPENCLAW_DOCKER_SOCKET: socketPath,
        DOCKER_STUB_FAIL_MATCH: "config set agents.defaults.sandbox.scope",
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toContain("Failed to set agents.defaults.sandbox.scope");
      expect(result.stderr).toContain("Skipping gateway restart to avoid exposing Docker socket");

      const log = await readDockerLog(activeSandbox);
      const gatewayStarts = (await readDockerLogLines(activeSandbox)).filter((line) =>
        isGatewayStartLine(line),
      );
      expect(gatewayStarts).toHaveLength(1);
      expect(log).toContain(
        "run --rm --no-deps openclaw-cli config set agents.defaults.sandbox.mode non-main",
      );
      expect(log).toContain("config set agents.defaults.sandbox.mode off");
      expect(log).not.toContain("up -d --no-deps --force-recreate openclaw-gateway");
      await expect(
        stat(join(activeSandbox.rootDir, "docker-compose.sandbox.yml")),
      ).rejects.toThrow();
    });
  });

  it("rejects injected multiline OPENCLAW_EXTRA_MOUNTS values", async () => {
    const activeSandbox = requireSandbox(sandbox);

    const result = runDockerSetup(activeSandbox, {
      OPENCLAW_EXTRA_MOUNTS: "/tmp:/tmp\n  evil-service:\n    image: alpine",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("OPENCLAW_EXTRA_MOUNTS cannot contain control characters");
  });

  it("rejects invalid OPENCLAW_EXTRA_MOUNTS mount format", async () => {
    const activeSandbox = requireSandbox(sandbox);

    const result = runDockerSetup(activeSandbox, {
      OPENCLAW_EXTRA_MOUNTS: "bad mount spec",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Invalid mount format");
  });

  it("rejects invalid OPENCLAW_HOME_VOLUME names", async () => {
    const activeSandbox = requireSandbox(sandbox);

    const result = runDockerSetup(activeSandbox, {
      OPENCLAW_HOME_VOLUME: "bad name",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("OPENCLAW_HOME_VOLUME must match");
  });

  it("rejects OPENCLAW_TZ values that are not present in zoneinfo", async () => {
    const activeSandbox = requireSandbox(sandbox);

    const result = runDockerSetup(activeSandbox, {
      OPENCLAW_TZ: "Nope/Bad",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("OPENCLAW_TZ must match a timezone in /usr/share/zoneinfo");
  });

  it("parses as valid Bash with heredoc failures routed through shell control flow", async () => {
    const systemBash = resolveBashForCompatCheck();
    if (!systemBash) {
      return;
    }

    const syntaxCheck = spawnSync(
      systemBash,
      ["-n", join(repoRoot, "scripts", "docker", "setup.sh")],
      {
        encoding: "utf8",
      },
    );

    expect(syntaxCheck.status).toBe(0);
    expect(syntaxCheck.stderr).toBe("");
  });

  it("passes zero or populated verifier manifests under Bash nounset", async () => {
    const systemBash = resolveBashForCompatCheck();
    if (!systemBash) {
      return;
    }
    const script = await readFile(join(repoRoot, "scripts", "docker", "setup.sh"), "utf8");
    const functionStart = script.indexOf("oci_verify_image() {");
    const functionEnd = script.indexOf(
      "\n}\n\nprepare_and_publish_verifier_toolchain",
      functionStart,
    );
    expect(functionStart).toBeGreaterThanOrEqual(0);
    expect(functionEnd).toBeGreaterThan(functionStart);
    const functionSource = script.slice(functionStart, functionEnd + 2);
    const probe = spawnSync(
      systemBash,
      [
        "-u",
        "-c",
        [
          'docker() { printf "CALL"; printf "|%s" "$@"; printf "\\n"; }',
          'OPENCLAW_VERIFIER_GATEWAY_WORKSPACE="/workspace/project"',
          `OPENCLAW_VERIFIER_WORKSPACE_DIR=${JSON.stringify(repoRoot)}`,
          `VERIFIER_REPOSITORY_HEAD=${JSON.stringify("a".repeat(40))}`,
          `OPENCLAW_SOURCE_REVISION=${JSON.stringify("b".repeat(40))}`,
          functionSource,
          `oci_verify_image "sha256:${"c".repeat(64)}"`,
          `oci_verify_image "sha256:${"d".repeat(64)}" "${"1".repeat(64)}" "${"2".repeat(64)}"`,
        ].join("\n"),
      ],
      { encoding: "utf8" },
    );

    expect(probe.status, probe.stderr).toBe(0);
    const calls = probe.stdout.trim().split("\n");
    expect(calls).toHaveLength(2);
    expect(calls[0]).not.toContain("--dependency-manifest");
    expect(calls[0]).not.toContain("--browser-manifest");
    expect(calls[1]).toContain(`--dependency-manifest|${"1".repeat(64)}`);
    expect(calls[1]).toContain(`--browser-manifest|${"2".repeat(64)}`);
  });

  it("avoids associative arrays so the script remains Bash 3.2-compatible", async () => {
    const script = await readFile(join(repoRoot, "scripts", "docker", "setup.sh"), "utf8");
    expect(script).not.toMatch(/^\s*declare -A\b/m);

    const systemBash = resolveBashForCompatCheck();
    if (!systemBash) {
      return;
    }

    const assocCheck = spawnSync(systemBash, ["-c", "declare -A _t=()"], {
      encoding: "utf8",
    });
    if (assocCheck.status === 0 || assocCheck.status === null) {
      // Skip runtime check when system bash supports associative arrays
      // (not Bash 3.2) or when /bin/bash is unavailable (e.g. Windows).
      return;
    }

    const syntaxCheck = spawnSync(
      systemBash,
      ["-n", join(repoRoot, "scripts", "docker", "setup.sh")],
      {
        encoding: "utf8",
      },
    );

    expect(syntaxCheck.status).toBe(0);
    expect(syntaxCheck.stderr).not.toContain("declare: -A: invalid option");
  });

  it("keeps docker-compose gateway command in sync", async () => {
    const compose = await readFile(join(repoRoot, "docker-compose.yml"), "utf8");
    expect(compose).not.toContain("gateway-daemon");
    expect(compose).toContain('"gateway"');
  });

  it("keeps docker-compose CLI network namespace settings in sync", async () => {
    const compose = await readFile(join(repoRoot, "docker-compose.yml"), "utf8");
    expect(compose).toContain('network_mode: "service:openclaw-gateway"');
    expect(compose).toContain("depends_on:\n      - openclaw-gateway");
  });

  it("keeps docker-compose gateway token env defaults aligned across services", async () => {
    const compose = await readFile(join(repoRoot, "docker-compose.yml"), "utf8");
    expect(compose.match(/OPENCLAW_GATEWAY_TOKEN: \$\{OPENCLAW_GATEWAY_TOKEN:-\}/g)).toHaveLength(
      2,
    );
  });

  it("keeps docker-compose timezone env defaults aligned across services", async () => {
    const compose = await readFile(join(repoRoot, "docker-compose.yml"), "utf8");
    expect(compose.match(/TZ: \$\{OPENCLAW_TZ:-UTC\}/g)).toHaveLength(2);
  });
});
