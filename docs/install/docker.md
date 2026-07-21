---
summary: "Optional Docker-based setup and onboarding for OpenClaw"
read_when:
  - You want a containerized gateway instead of local installs
  - You are validating the Docker flow
title: "Docker"
---

# Docker (optional)

Docker is **optional**. Use it only if you want a containerized gateway or to validate the Docker flow.

## Is Docker right for me?

- **Yes**: you want an isolated, throwaway gateway environment or to run OpenClaw on a host without local installs.
- **No**: you are running on your own machine and just want the fastest dev loop. Use the normal install flow instead.
- **Sandboxing note**: agent sandboxing uses Docker too, but it does **not** require the full gateway to run in Docker. See [Sandboxing](/gateway/sandboxing).

## Prerequisites

- Docker Desktop (or Docker Engine) + Docker Compose v2
- At least 2 GB RAM for image build (`pnpm install` may be OOM-killed on 1 GB hosts with exit 137)
- Enough disk for images and logs
- If running on a VPS/public host, review
  [Security hardening for network exposure](/gateway/security),
  especially Docker `DOCKER-USER` firewall policy.

## Containerized Gateway

<Steps>
  <Step title="Build the image">
    From the repo root, run the setup script:

    ```bash
    ./scripts/docker/setup.sh
    ```

    This builds the gateway image locally. To use a pre-built image instead:

    ```bash
    export OPENCLAW_IMAGE="ghcr.io/openclaw/openclaw:latest"
    ./scripts/docker/setup.sh
    ```

    Pre-built images are published at the
    [GitHub Container Registry](https://github.com/openclaw/openclaw/pkgs/container/openclaw).
    Common tags: `main`, `latest`, `<version>` (e.g. `2026.2.26`).

  </Step>

  <Step title="Complete onboarding">
    The setup script runs onboarding automatically. It will:

    - prompt for provider API keys
    - generate a gateway token and write it to `.env`
    - start the gateway via Docker Compose

    During setup, pre-start onboarding and config writes run through
    `openclaw-gateway` directly. `openclaw-cli` is for commands you run after
    the gateway container already exists.

  </Step>

  <Step title="Open the Control UI">
    Open `http://127.0.0.1:18789/` in your browser and paste the configured
    shared secret into Settings. The setup script writes a token to `.env` by
    default; if you switch the container config to password auth, use that
    password instead.

    Need the URL again?

    ```bash
    docker compose run --rm openclaw-cli dashboard --no-open
    ```

  </Step>

  <Step title="Configure channels (optional)">
    Use the CLI container to add messaging channels:

    ```bash
    # WhatsApp (QR)
    docker compose run --rm openclaw-cli channels login

    # Telegram
    docker compose run --rm openclaw-cli channels add --channel telegram --token "<token>"

    # Discord
    docker compose run --rm openclaw-cli channels add --channel discord --token "<token>"
    ```

    Docs: [WhatsApp](/channels/whatsapp), [Telegram](/channels/telegram), [Discord](/channels/discord)

  </Step>
</Steps>

### Manual flow

If you prefer to run each step yourself instead of using the setup script:

```bash
OPENCLAW_BUILD_REVISION="$(git rev-parse --verify 'HEAD^{commit}')"
OPENCLAW_PROVENANCE_IMAGE="openclaw:local-provenance"
docker build --build-arg "OPENCLAW_SOURCE_REVISION=$OPENCLAW_BUILD_REVISION" --build-arg "OPENCLAW_PROVENANCE_ARTIFACT_URI=embedded:/opt/openclaw/build-provenance" --build-arg OPENCLAW_INSTALL_BROWSER=1 -t openclaw:local -f Dockerfile .
docker build --target provenance-artifacts --build-arg "OPENCLAW_SOURCE_REVISION=$OPENCLAW_BUILD_REVISION" --build-arg "OPENCLAW_PROVENANCE_ARTIFACT_URI=embedded:/opt/openclaw/build-provenance" -t "$OPENCLAW_PROVENANCE_IMAGE" -f Dockerfile .
docker compose run --rm --no-deps --entrypoint node openclaw-gateway \
  dist/index.js onboard --mode local --no-install-daemon
docker compose run --rm --no-deps --entrypoint node openclaw-gateway \
  dist/index.js config set --batch-json '[{"path":"gateway.mode","value":"local"},{"path":"gateway.bind","value":"lan"},{"path":"gateway.controlUi.allowedOrigins","value":["http://localhost:18789","http://127.0.0.1:18789"]}]'
docker compose up -d openclaw-gateway
```

<Note>
Run `docker compose` from the repo root. If you enabled `OPENCLAW_EXTRA_MOUNTS`
or `OPENCLAW_HOME_VOLUME`, the setup script writes `docker-compose.extra.yml`;
include it with `-f docker-compose.yml -f docker-compose.extra.yml`.
</Note>

### Build provenance and retained source maps

Every source build emits `dist/build-provenance.json`. The deterministic
manifest binds the full 40-character source revision, build-profile options,
hashed build inputs, every shipped runtime chunk, the build-info revision, the
validator identity and digest, and each generated source map. Release and
container builds fail closed when the revision or retained-artifact URI is
missing, null, malformed, a placeholder, or inconsistent with an available Git
checkout.

Runtime containers remove source maps from `dist`, but retain a root-owned,
read-only verification copy of the source maps and provenance validator under
`/opt/openclaw/build-provenance`. The matching `provenance-artifacts` image also
retains the manifest, validator, source maps, and a hash-bound copy of the
runtime artifacts. Published container images carry the same revision in
`org.opencontainers.image.revision` and bind the recorded retained-artifact URI
in `ai.openclaw.provenance.uri`. Npm release promotion likewise publishes the
preflight bundle at the exact OCI URI recorded in the package manifest.

For a source build, verify the current output before deployment with:

```bash
pnpm build:provenance:check
```

After runtime maps have been stripped, verify an extracted runtime against a
retained bundle and the exact source checkout with:

```bash
node scripts/verify-build-provenance.mjs --root /absolute/runtime-root --manifest /absolute/runtime-root/dist/build-provenance.json --source-root /absolute/source-checkout --artifact-root /absolute/runtime-root --source-map-root /absolute/provenance-bundle/source-maps --validator-root /absolute/provenance-bundle/validator --expected-revision 0123456789abcdef0123456789abcdef01234567 --require-retained-source-maps
```

Keep the lifecycle boundaries explicit: a source build creates artifacts; an
image rebuild packages them; deployment replaces the running image; installed
QA proves what is actually running. A green source check or implementation
status alone is not evidence that an image was rebuilt, deployed, restarted, or
validated in the installed environment.

<Note>
Because `openclaw-cli` shares `openclaw-gateway`'s network namespace, it is a
post-start tool. Before `docker compose up -d openclaw-gateway`, run onboarding
and setup-time config writes through `openclaw-gateway` with
`--no-deps --entrypoint node`.
</Note>

### Which rebuild path am I using?

If you are coming back to an existing Docker install and are not sure whether it
uses a locally built image or a pre-built registry image, check the configured
image first from the repo root:

```bash
grep '^OPENCLAW_IMAGE=' .env
docker compose ps --format json
```

How to interpret it:

- If `.env` sets `OPENCLAW_IMAGE=openclaw:local` or the running container image
  is `openclaw:local`, you are using the local-image flow. Rebuild with:

  ```bash
  ./scripts/docker/setup.sh
  docker compose -f docker-compose.yml -f docker-compose.extra.yml up -d --force-recreate openclaw-gateway
  ```

- If `.env` sets `OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:<tag>` (or another
  remote image reference), you are using the pre-built image flow. Update with:

  ```bash
  docker compose -f docker-compose.yml -f docker-compose.extra.yml pull openclaw-gateway openclaw-cli
  docker compose -f docker-compose.yml -f docker-compose.extra.yml up -d --force-recreate openclaw-gateway
  ```

If `OPENCLAW_IMAGE` is unset, `docker-compose.yml` falls back to
`openclaw:local`.

If `.env` contains `OPENCLAW_EXTRA_MOUNTS` or `OPENCLAW_HOME_VOLUME`, also check
whether `docker-compose.extra.yml` exists. When it does, include it in rebuild
and restart commands.

Recommended pattern:

```bash
openclaw_compose() {
  docker compose -f docker-compose.yml -f docker-compose.extra.yml "$@"
}

openclaw_compose up -d --force-recreate openclaw-gateway
openclaw_compose logs -f openclaw-gateway
openclaw_compose exec openclaw-gateway node dist/index.js health --token "$OPENCLAW_GATEWAY_TOKEN"
```

Do not store the full `docker compose ...` command in a plain string variable and
run it as `$COMPOSE`; shells such as `zsh` treat that as one command name and
fail with `command not found`.

If you forget the extra compose file, the gateway may still look healthy while
plugin sidecars or agent workspaces fail because expected mounts (for example
`/workspace/...`) are missing from the running container.

This is especially important when your OpenClaw config points agents at mounted
repo paths such as `/workspace/astino`. Without the extra compose file, those
paths do not exist in the container even though the gateway itself may still
start and pass basic health checks.

### Environment variables

The setup script accepts these optional environment variables:

| Variable                       | Purpose                                                                               |
| ------------------------------ | ------------------------------------------------------------------------------------- |
| `OPENCLAW_IMAGE`               | Use a remote image instead of building locally                                        |
| `OPENCLAW_DOCKER_APT_PACKAGES` | Install extra apt packages during build (space-separated)                             |
| `OPENCLAW_EXTENSIONS`          | Pre-install extension deps at build time (space-separated names)                      |
| `OPENCLAW_INSTALL_BROWSER`     | Bake Chromium and Linux browser deps into local builds (default `1`; set `0` to skip) |
| `OPENCLAW_EXTRA_MOUNTS`        | Extra host bind mounts (comma-separated `source:target[:opts]`)                       |
| `OPENCLAW_HOME_VOLUME`         | Persist `/home/node` in a named Docker volume                                         |
| `OPENCLAW_SANDBOX`             | Opt in to sandbox bootstrap (`1`, `true`, `yes`, `on`)                                |
| `OPENCLAW_DOCKER_SOCKET`       | Override Docker socket path                                                           |

### Health checks

Container probe endpoints (no auth required):

```bash
curl -fsS http://127.0.0.1:18789/healthz   # liveness
curl -fsS http://127.0.0.1:18789/readyz     # readiness
```

The Docker image includes a built-in `HEALTHCHECK` that pings `/healthz`.
If checks keep failing, Docker marks the container as `unhealthy` and
orchestration systems can restart or replace it.

Authenticated deep health snapshot:

```bash
docker compose exec openclaw-gateway node dist/index.js health --token "$OPENCLAW_GATEWAY_TOKEN"
```

### LAN vs loopback

`scripts/docker/setup.sh` defaults `OPENCLAW_GATEWAY_BIND=lan` so host access to
`http://127.0.0.1:18789` works with Docker port publishing.

- `lan` (default): host browser and host CLI can reach the published gateway port.
- `loopback`: only processes inside the container network namespace can reach
  the gateway directly.

<Note>
Use bind mode values in `gateway.bind` (`lan` / `loopback` / `custom` /
`tailnet` / `auto`), not host aliases like `0.0.0.0` or `127.0.0.1`.
</Note>

### Storage and persistence

Docker Compose bind-mounts `OPENCLAW_CONFIG_DIR` to `/home/node/.openclaw` and
`OPENCLAW_WORKSPACE_DIR` to `/home/node/.openclaw/workspace`, so those paths
survive container replacement.

That mounted config directory is where OpenClaw keeps:

- `openclaw.json` for behavior config
- `agents/<agentId>/agent/auth-profiles.json` for stored provider OAuth/API-key auth
- `.env` for env-backed runtime secrets such as `OPENCLAW_GATEWAY_TOKEN`

For full persistence details on VM deployments, see
[Docker VM Runtime - What persists where](/install/docker-vm-runtime#what-persists-where).

**Disk growth hotspots:** watch `media/`, session JSONL files, `cron/runs/*.jsonl`,
and rolling file logs under `/tmp/openclaw/`.

### Shell helpers (optional)

For easier day-to-day Docker management, install `ClawDock`:

```bash
mkdir -p ~/.clawdock && curl -sL https://raw.githubusercontent.com/openclaw/openclaw/main/scripts/clawdock/clawdock-helpers.sh -o ~/.clawdock/clawdock-helpers.sh
echo 'source ~/.clawdock/clawdock-helpers.sh' >> ~/.zshrc && source ~/.zshrc
```

If you installed ClawDock from the older `scripts/shell-helpers/clawdock-helpers.sh` raw path, rerun the install command above so your local helper file tracks the new location.

Then use `clawdock-start`, `clawdock-stop`, `clawdock-dashboard`, etc. Run
`clawdock-help` for all commands.
See [ClawDock](/install/clawdock) for the full helper guide.

<AccordionGroup>
  <Accordion title="Enable agent sandbox for Docker gateway">
    ```bash
    export OPENCLAW_SANDBOX=1
    ./scripts/docker/setup.sh
    ```

    Custom socket path (e.g. rootless Docker):

    ```bash
    export OPENCLAW_SANDBOX=1
    export OPENCLAW_DOCKER_SOCKET=/run/user/1000/docker.sock
    ./scripts/docker/setup.sh
    ```

    The script mounts `docker.sock` only after sandbox prerequisites pass. If
    sandbox setup cannot complete, the script resets `agents.defaults.sandbox.mode`
    to `off`.

  </Accordion>

  <Accordion title="Automation / CI (non-interactive)">
    Disable Compose pseudo-TTY allocation with `-T`:

    ```bash
    docker compose run -T --rm openclaw-cli gateway probe
    docker compose run -T --rm openclaw-cli devices list --json
    ```

  </Accordion>

  <Accordion title="Shared-network security note">
    `openclaw-cli` uses `network_mode: "service:openclaw-gateway"` so CLI
    commands can reach the gateway over `127.0.0.1`. Treat this as a shared
    trust boundary. The compose config drops `NET_RAW`/`NET_ADMIN` and enables
    `no-new-privileges` on `openclaw-cli`.
  </Accordion>

  <Accordion title="Permissions and EACCES">
    The image runs as `node` (uid 1000). If you see permission errors on
    `/home/node/.openclaw`, make sure your host bind mounts are owned by uid 1000:

    ```bash
    sudo chown -R 1000:1000 /path/to/openclaw-config /path/to/openclaw-workspace
    ```

  </Accordion>

  <Accordion title="Faster rebuilds">
    Order your Dockerfile so dependency layers are cached. This avoids re-running
    `pnpm install` unless lockfiles change:

    ```dockerfile
    FROM node:24-bookworm
    RUN curl -fsSL https://bun.sh/install | bash
    ENV PATH="/root/.bun/bin:${PATH}"
    RUN corepack enable
    WORKDIR /app
    COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
    COPY ui/package.json ./ui/package.json
    COPY scripts ./scripts
    RUN pnpm install --frozen-lockfile
    COPY . .
    RUN pnpm build
    RUN pnpm ui:install
    RUN pnpm ui:build
    ENV NODE_ENV=production
    CMD ["node","dist/index.js"]
    ```

  </Accordion>

  <Accordion title="Power-user container options">
    The default image is security-first and runs as non-root `node`. For a more
    full-featured container:

    1. **Persist `/home/node`**: `export OPENCLAW_HOME_VOLUME="openclaw_home"`
    2. **Bake system deps**: `export OPENCLAW_DOCKER_APT_PACKAGES="git curl jq"`
    3. **Bake browser automation deps**: Docker setup does this by default for
       local builds. For manual builds, pass the same build arg:
       ```bash
       ./scripts/docker/setup.sh
       ```
       The image uses the repo-pinned `playwright-core` installer with
       `install --with-deps chromium`, so Chromium and required Linux shared
       libraries are installed together.

  </Accordion>

  <Accordion title="OpenAI Codex OAuth (headless Docker)">
    If you pick OpenAI Codex OAuth in the wizard, it opens a browser URL. In
    Docker or headless setups, copy the full redirect URL you land on and paste
    it back into the wizard to finish auth.
  </Accordion>

  <Accordion title="Base image metadata">
    The main Docker image uses `node:24-bookworm` and publishes OCI base-image
    annotations including `org.opencontainers.image.base.name`,
    `org.opencontainers.image.source`, `org.opencontainers.image.revision`, and
    others. The revision matches `dist/build-info.json` and
    `dist/build-provenance.json`. See
    [OCI image annotations](https://github.com/opencontainers/image-spec/blob/main/annotations.md).
  </Accordion>
</AccordionGroup>

### Running on a VPS?

See [Hetzner (Docker VPS)](/install/hetzner) and
[Docker VM Runtime](/install/docker-vm-runtime) for shared VM deployment steps
including binary baking, persistence, and updates.

## Agent Sandbox

When `agents.defaults.sandbox` is enabled, the gateway runs agent tool execution
(shell, file read/write, etc.) inside isolated Docker containers while the
gateway itself stays on the host. This gives you a hard wall around untrusted or
multi-tenant agent sessions without containerizing the entire gateway.

Sandbox scope can be per-agent (default), per-session, or shared. Each scope
gets its own workspace mounted at `/workspace`. You can also configure
allow/deny tool policies, network isolation, resource limits, and browser
containers.

For full configuration, images, security notes, and multi-agent profiles, see:

- [Sandboxing](/gateway/sandboxing) -- complete sandbox reference
- [OpenShell](/gateway/openshell) -- interactive shell access to sandbox containers
- [Multi-Agent Sandbox and Tools](/tools/multi-agent-sandbox-tools) -- per-agent overrides

### Quick enable

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main", // off | non-main | all
        scope: "agent", // session | agent | shared
      },
    },
  },
}
```

Build the default sandbox image:

```bash
scripts/sandbox-setup.sh
```

## Troubleshooting

<AccordionGroup>
  <Accordion title="Image missing or sandbox container not starting">
    Build the sandbox image with
    [`scripts/sandbox-setup.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/sandbox-setup.sh)
    or set `agents.defaults.sandbox.docker.image` to your custom image.
    Containers are auto-created per session on demand.
  </Accordion>

  <Accordion title="Permission errors in sandbox">
    Set `docker.user` to a UID:GID that matches your mounted workspace ownership,
    or chown the workspace folder.
  </Accordion>

  <Accordion title="Custom tools not found in sandbox">
    OpenClaw runs commands with `sh -lc` (login shell), which sources
    `/etc/profile` and may reset PATH. Set `docker.env.PATH` to prepend your
    custom tool paths, or add a script under `/etc/profile.d/` in your Dockerfile.
  </Accordion>

  <Accordion title="OOM-killed during image build (exit 137)">
    The VM needs at least 2 GB RAM. Use a larger machine class and retry.
  </Accordion>

  <Accordion title="Unauthorized or pairing required in Control UI">
    Fetch a fresh dashboard link and approve the browser device:

    ```bash
    docker compose run --rm openclaw-cli dashboard --no-open
    docker compose run --rm openclaw-cli devices list
    docker compose run --rm openclaw-cli devices approve <requestId>
    ```

    More detail: [Dashboard](/web/dashboard), [Devices](/cli/devices).

  </Accordion>

  <Accordion title="Gateway target shows ws://172.x.x.x or pairing errors from Docker CLI">
    Reset gateway mode and bind:

    ```bash
    docker compose run --rm openclaw-cli config set --batch-json '[{"path":"gateway.mode","value":"local"},{"path":"gateway.bind","value":"lan"}]'
    docker compose run --rm openclaw-cli devices list --url ws://127.0.0.1:18789
    ```

  </Accordion>
</AccordionGroup>

## Related

- [Install Overview](/install) — all installation methods
- [Podman](/install/podman) — Podman alternative to Docker
- [ClawDock](/install/clawdock) — Docker Compose community setup
- [Updating](/install/updating) — keeping OpenClaw up to date
- [Configuration](/gateway/configuration) — gateway configuration after install
