# Incidents

Short operational memory for issues we hit, how we fixed them, and the result.
Consult this before investigating a new issue or making a related change.

## 2026-05-15

1. **Planner chased child results with noisy back-and-forth**
   - **Issue:** Planner 4 received compact child completion receipts and then tried `sessions_history`, `sessions_list`, registry probes, and transcript reads to recover child results. The receipt-pointer behavior itself was intentional, but the parent could not read history for a cross-agent child it controlled.
   - **Fix and why:** Kept compact receipt delivery intact, then allowed a parent to read `sessions_history` for child sessions tracked under its own sub-agent controller. Also kept direct top-level agent-to-agent `sessions_send` as full-message delivery, separate from child completion receipts.
   - **Result:** Parent-owned cross-agent child results can be read without broadening generic agent-to-agent access, while receipt pointers still protect normal completion context size.

2. **Accidental receipt hydration regression was reverted**
   - **Issue:** A trial change hydrated compact child result receipts into normal parent delivery, which would have undone the intentional receipt-pointer design.
   - **Fix and why:** Reverted the hydration change and deleted the accidental test file. Receipt pointers remain the normal child completion shape; active steer paths may still hydrate where already designed.
   - **Result:** No change to the intentional receipt-pointer contract.

3. **Parent child-control send needed to bypass generic A2A allowlists**
   - **Issue:** A parent’s follow-up to its own cross-agent child could be denied by `tools.agentToAgent.allow`, even though sub-agent ownership had already scoped the relationship.
   - **Fix and why:** Added a controlled-child exception for `sessions_send`, and routed finished controlled children through tracked sub-agent restart delivery instead of generic A2A announce.
   - **Result:** Parent-owned children can be re-tasked with tracked completion, including cross-agent children, without opening broader cross-agent messaging.

4. **Late announce flow could end before long child follow-up completed**
   - **Issue:** `sessions_send` synchronous waits could time out while the target run was still valid, then the late announce flow had only a short wait window.
   - **Fix and why:** Extended the late announce wait path for timed-out `sessions_send` runs so the announce flow can observe slower completions.
   - **Result:** Fewer missed generic A2A announcements after a synchronous timeout.

5. **Queue confusion during inter-agent analysis**
   - **Issue:** It was unclear whether command queues, follow-up queues, announce queues, or embedded steer queues caused the noisy communication.
   - **Fix and why:** Separated ownership from timing: the sub-agent registry controls parent/child ownership and permissions; queues only serialize or schedule delivery. The root issue was ownership access and later stale tracking, not queue mechanics.
   - **Result:** Future debugging should inspect registry ownership/tracking first, then queues only when delivery ordering is suspect.

6. **Planner waited for tester T4 after tester had already finished**
   - **Issue:** `planner:main` sent T4 to `agent:tester:subagent:c609f936-...` with `sessions_send(timeoutSeconds: 0)`. The original child run had already aged out of the tracked sub-agent registry, so `sessions_send` fell back to generic `delivery: pending / mode: announce`. Tester finished T4, but the parent waited for a tracked child completion event that could not arrive.
   - **Fix and why:** `sessions_send` now rejects fire-and-forget delivery to untracked sub-agent sessions from agent runs. The error directs the agent to use `subagents(action="steer")` for listed controlled children or `sessions_spawn` for fresh tracked child work. Prompt/docs/rules now also say to consult this file and not use fire-and-forget `sessions_send` for stale sub-agent orchestration.
   - **Result:** The stale-wait pattern is prevented before the parent can yield on a non-tracked announce path.

7. **Docker rebuild versus restart ambiguity slowed applying fixes**
   - **Issue:** After agent/session source changes, it was unclear whether a gateway restart was enough or whether the Docker image had to be rebuilt. The active gateway was running from the `openclaw:local` Docker image, so plain container restarts could keep serving old `dist/index.js` code.
   - **Fix and why:** Added Docker Gateway Ops guidance to `AGENTS.md` covering how to detect the active Docker gateway, when to rebuild/recreate for source or system-prompt changes, when a restart is enough for bind-mounted config/env changes, how project `.env` differs from `~/.openclaw/.env`, and why `docker-compose.extra.yml` must be included when present.
   - **Result:** Future Docker questions should start from the local runbook instead of re-reading the Docker docs each time.

## 2026-05-26

1. **Agent worktree dependency installs failed on root-owned `node_modules` volumes**
   - **Issue:** Astino worktree profiles mounted `node_modules` as Docker named volumes. Fresh volumes were owned by `root:root`, while OpenClaw agents run as `node` uid/gid 1000, so Yarn could not create scoped package directories and `node_modules` could not be removed because it was a busy mount.
   - **Fix and why:** Removed the per-worktree `node_modules` volume mounts from `docker-compose.extra.yml`, recreated the gateway container, installed Node 20.19.4 under the mounted Codex runtime cache, and configured `tools.exec.pathPrepend` so agent exec runs use the project runtime while the OpenClaw gateway image can keep its own Node runtime.
   - **Result:** Fresh agent sessions see worktree `node_modules` as writable by `node:node`; `COREPACK_HOME="$PWD/.corepack" yarn install --immutable` and the targeted planner Vitest files run without sudo on the canonical mounted Astino repo.

## 2026-06-08

1. **Rollup optional native package blocked Astino planner validation**
   - **Issue:** A validation slice ran `COREPACK_HOME=/tmp/corepack yarn vitest tests/assist/profile/modePlannerDsl.compiler.test.ts tests/assist/profile/modePlanner.test.ts --run` in a Linux ARM64 agent/worktree and failed before tests loaded with `Cannot find module @rollup/rollup-linux-arm64-gnu`. Astino's Yarn lock includes platform-specific Rollup optional packages, while macOS-installed worktrees contain `@rollup/rollup-darwin-arm64`, so stale or host-installed `node_modules` cannot satisfy a Linux agent runtime.
   - **Fix and why:** Codified the recovery path in `AGENTS.md`: Rollup native optional package failures are dependency-install failures. The one-platform repair is `COREPACK_HOME="$PWD/.corepack" yarn install --immutable` in the active worktree before retrying tests. The durable cross-platform fix belongs in Astino's Yarn config: add `supportedArchitectures` for both `darwin` and `linux` on `arm64` so the shared mounted `node_modules` contains both Rollup native packages instead of flipping between host macOS and Linux agent installs.
   - **Result:** The mounted Astino worktree now contains both `@rollup/rollup-darwin-arm64` and `@rollup/rollup-linux-arm64-gnu`. The targeted planner Vitest command passes on both macOS and the Linux OpenClaw gateway container, so future validation slices should not report this as a planner/test-code blocker.

2. **Gateway microphone button was blocked by Permissions-Policy**
   - **Issue:** The Control UI voice-input button used browser `SpeechRecognition`, but the Docker-backed gateway served `Permissions-Policy: camera=(), microphone=(), geolocation=()`. Browser site permission for `localhost:18789` could not override that response header, so clicking the microphone button appeared to do nothing.
   - **Fix and why:** Changed the default gateway header to `microphone=(self)` and rebuilt/recreated the Docker gateway because `openclaw:local` serves built `dist` assets from the image.
   - **Result:** The recreated gateway now serves `Permissions-Policy: camera=(), microphone=(self), geolocation=()`, allowing same-origin microphone access while keeping camera and geolocation disabled.

3. **Docker rebuild pulled optional native runtime packages**
   - **Issue:** Local Docker rebuilds could spend time fetching or building optional native packages during prune/postinstall, even when the goal was only to deploy required gateway runtime code.
   - **Fix and why:** Kept the build-stage pnpm install frozen but restricted allowed package build scripts to required build tools, then pruned runtime dependencies with npm using `--omit=optional --ignore-scripts --legacy-peer-deps`. The bundled plugin postinstall now honors optional-dependency omission and passes `--omit=optional` to nested npm installs.
   - **Result:** The rebuilt `openclaw:local` image omits checked optional native packages such as `@discordjs/opus`, `node-llama-cpp`, `@napi-rs/canvas`, `@lancedb/*` native packages, `@snazzah/davey-win32-arm64-msvc`, and `@matrix-org/matrix-sdk-crypto-nodejs`; required runtime packages such as `sharp` remain installed.

## 2026-06-12

1. **Planner workspace edits were reverted by the guard**
   - **Issue:** Direct edits to live planner workspaces in `openclaw.json` read back successfully, then reverted because the planner guard re-materializes guarded agent blocks from `guard/agents.golden.d` plus the Astino lane-state planner bindings.
   - **Fix and why:** Reverted the accidental fixed planner workspace assignments, kept the guarded prompts workspace-neutral, and added a guard-aware switcher/helper path for creating or selecting a Git worktree profile and binding a specific planner through lane-state planner bindings.
   - **Result:** Future planner workspace changes should start from the Astino lane/profile switcher or lane-helper API, not direct live-config edits. Profile id `master` is a runtime profile name, not a guarantee that the mounted checkout is on the Git `master` branch.

2. **Planner-initiated worktree switches can restart the planner's own container**
   - **Issue:** A planner can reach the host lane helper from inside Docker, but a synchronous switch request may recreate the same gateway container running the planner command before the command can finish. The helper token also was not mounted into the container, so planners could not authenticate to the helper.
   - **Fix and why:** Mounted the lane-helper token read-only at `/home/node/.openclaw/astino-lane-helper-token`, added `scripts/openclaw-planner-worktree.sh` as the planner-facing wrapper, and taught the helper to accept `async: true` switch requests that return before the host performs the restart.
   - **Result:** Users can tell a planner to switch itself to `master`, an existing worktree profile, or a newly-created worktree. The planner runs the wrapper, gets `switch accepted`, and any required gateway restart happens after acceptance.

## 2026-06-17

1. **Agent slowness came from oversized GPT-5.5 runs plus intermittent outbound failures**
   - **Issue:** Planner 2 and related sub-agents appeared generally slow while the Docker gateway itself stayed healthy. Logs showed repeated context-overflow auto-compactions, long `agent.wait` spans, subagent announce retries, and transient `fetch failed`/DNS failures from inside the gateway container.
   - **Fix and why:** No code fix applied during diagnostics. Health checks and flow/task registries ruled out a current OpenFlow backlog; session timelines showed slow model/tool loops and context compaction as the active bottleneck, with intermittent container network failures worsening completion delivery.
   - **Result:** Future triage should first check Docker outbound/DNS health, recent `context-overflow-diag` lines, and whether agents are pinned to `openai-codex/gpt-5.5` before assuming the flow engine is blocked.

## 2026-06-28

1. **Queue widget conflated task depth with lane count**
   - **Issue:** The Control UI queue pill used labels like `Other lanes 3 total`, where `3` meant active plus queued tasks, not lane count. It also had no direct click path for inspecting the current per-lane snapshot.
   - **Fix and why:** Changed the pill to distinguish current-lane versus other-lane pressure, show active/waiting/busy-lane counts separately, and log a sanitized per-lane queue snapshot with timings on click.
   - **Result:** Operators can tell whether the selected chat lane is blocked or other lanes are consuming capacity, without exposing queued task payloads in the UI or console.

2. **Docker-backed agents missed Chromium shared libraries**
   - **Issue:** Browser/Playwright work in Linux Docker agents could fail on missing shared libraries such as `libnss3.so` when the local `openclaw:local` image was rebuilt without Chromium's distro dependencies.
   - **Fix and why:** Kept the Playwright install inside the OpenClaw image build and made local Docker and Podman setup pass `OPENCLAW_INSTALL_BROWSER=1` by default. The Dockerfile's pinned `playwright-core install --with-deps chromium` path installs Chromium and its Linux shared-library dependencies together.
   - **Result:** Future local image bootstraps bake browser automation dependencies into the base OpenClaw image; `OPENCLAW_INSTALL_BROWSER=0` remains available for smaller images that do not need browser automation.

3. **Planner runtime failures were invisible when queues went idle**
   - **Issue:** Planner 4 hit context overflow and then emitted a silent/no-final-report outcome while the command queue snapshot could show no backlog (`queueAhead=0`). Queue state captured scheduler pressure, but not semantic agent runtime failures, so operators had to inspect logs/session JSONL to understand why reporting stopped.
   - **Fix and why:** Added a bounded runtime-health ledger fed by agent lifecycle events, and folded those closed-code issue summaries into `queue.health` as per-lane `health`/`runtimeIssues` fields. Issue-only lanes are included even when no command task is active.
   - **Result:** Operator UIs can now show blocked/degraded agent state, including context overflow, without exposing prompts or tool payloads and without turning scheduler queues into orchestration logic.

4. **Queue pill still mixed selected and other-lane state**
   - **Issue:** The Control UI queue pill and click debug log still mixed global queue totals and other-lane runtime issues into the selected chat lane. This made a selected planner look busy or blocked because another planner lane was overloaded.
   - **Fix and why:** Made the UI request `queue.health` for the selected session lane and changed the pill, tooltip, and click log to derive labels/details from that selected lane only.
   - **Result:** Operators can inspect the selected planner's queue/runtime state without unrelated planner lanes obscuring the signal.

5. **Raw runtime codes and subagent keys obscured triage**
   - **Issue:** Queue pills and console output surfaced compact runtime codes such as `agent_lifecycle_error`, while planner-owned subagent sessions appeared as raw keys like `agent:implementer:subagent:<uuid>`.
   - **Fix and why:** Kept compact closed-code health for protocol safety, but added selected-lane action tables and additive subagent display metadata so UI labels can show planner name, sanitized feature label, and child ordinal without changing session keys.
   - **Result:** Operators can identify the selected planner-owned feature run more quickly without exposing prompt, transcript, tool payload, or secret text.

## 2026-06-29

1. **Planner 2 waited on a bounded send to an untracked child**
   - **Issue:** Planner 2 tried to retask stale child `agent:implementer:subagent:52cbaece-...`. The first `sessions_send(timeoutSeconds: 0)` was correctly rejected as an untracked subagent, but Planner 2 retried with `timeoutSeconds: 1`, which the running Docker image allowed through the generic announce path. The implementer completed T4, but Planner 2 was waiting for a tracked child completion event that could not arrive.
   - **Fix and why:** No code change applied during diagnostics. The live Docker image still has the older timeout-zero-only guard, while the checkout has a broader child-route guard in `src/agents/tools/sessions-send-tool.ts` that should reject stale child-shaped sends before generic delivery. Rebuild/recreate the Docker gateway before relying on the source behavior.
   - **Result:** Future triage should check both the subagent registry (`runs.json`) and the active Docker `dist` before assuming source changes are live. For untracked child follow-up, spawn a fresh child or use `subagents(action="steer")` only when the child is still listed as controlled.

2. **MCP loopback test mock inferred owner-only tools too narrowly**
   - **Issue:** `src/gateway/mcp-http.test.ts` used a hoisted `vi.fn` whose initial tool fixture did not include `ownerOnly`, so later owner-only fixtures were rejected by `pnpm tsgo` even though the runtime tool shape supports that metadata.
   - **Fix and why:** Added a tiny test-local tool factory that builds full `AnyAgentTool` fixtures with `label`, `details`, and optional `ownerOnly`, then reused it for the hoisted mock and the later fixture variants. This keeps the mock aligned with the real contract instead of relying on a narrower ad hoc shape.
   - **Result:** The MCP loopback test can model owner-only tools and typed tool results without loosening the gateway resolver or broadening runtime behavior.

## 2026-06-30

1. **Stale child retry and repair controls could escape the child route contract**
   - **Issue:** A stale or untracked child-shaped `sessions_send` target could be retried with a bounded timeout and fall toward generic announce delivery, while gateway session repair surfaces such as compaction branch/restore/compact did not consistently persist child route-health repair transitions before later follow-up decisions.
   - **Fix and why:** Added fail-closed route guards for child-shaped `sessions_send`, gateway session create/patch-derived delivery, and session repair/control transitions. `spawn_fresh` reroute now starts a fresh tracked child with a bounded handoff packet, waits on that fresh generation, and does not pass the old `sessionId` or `restartSessionId`; compaction repair paths record explicit route-health clear/active events without clearing auth-scope blockers.
   - **Result:** Timeout variants (`0`, short positive, default, and other bounded waits) cannot convert stale child rejection into announce-mode delivery, child-derived checkpoint branches keep route ancestry, and successful repair has typed route-health evidence before any new follow-up can proceed.

2. **Planner 2 top-level session could be deleted**
   - **Issue:** `sessions.delete` rejected only the configured main session, so sibling top-level agent sessions such as `agent:planner-2:main` could be archived even though operators treat planners as non-deletable roots. Planner 2 was recovered by restoring its `.jsonl.deleted.*` transcript and repointing the per-agent session store to the recovered session id.
   - **Fix and why:** Added a gateway delete guard for every canonical top-level agent main session, using the configured main-key resolver instead of hardcoding `main`. The regression test now rejects `agent:planner-2:main` while existing subagent delete coverage still proves child sessions can be removed.
   - **Result:** Top-level agents cannot be deleted through `sessions.delete`; only child or non-main sessions remain deletable.

3. **Unhealthy child handoff P1 review found fail-open gaps**
   - **Issue:** Reset repair clears could partially persist before a later clear failed, `sessions_send` could treat unrelated provider auth blockers as global, and `session_expired` recording for non-child-shaped derived sessions could lose the child-local blocker.
   - **Fix and why:** Batched reset repair clear events and marked the child route unavailable on failed repair persistence; made auth blocker reads target provider/auth-scope aware; and carried derived-session lineage into `session_expired` route-health recording.
   - **Result:** Repair persistence failures fail closed, unrelated auth profiles no longer block a target route, and lineage-derived child conversation expiry remains attached to the owning child route.

## 2026-07-02

1. **D4/D5 handoff review found stale-generation and receipt gaps**
   - **Issue:** Fresh child reroute could synthesize a sparse handoff instead of requiring planner-authored semantics, drop attachment/provider facts, accept active child follow-ups through announce-mode delivery, leak ACP key/value backend option secrets, lose receipt hydration when run rows were pruned, or let old top-level child completions/wakes race a newer replacement generation.
   - **Fix and why:** Required planner handoff input before fresh reroute, attached runtime-owned provider/auth/attachment facts, routed controlled child follow-ups through tracked restart delivery, added a locked durable result-receipt store and prompt-time receipt hydration, redacted ACP secret-labeled backend option values while marking them non-replay-safe, preserved session-mode replay through thread-bound fresh spawns with the original requester origin and runtime controls, marked superseded old runs as `fresh-reroute`, and fenced steer/wake replacement against newer child generations with deterministic latest-row selection.
   - **Result:** Fresh reroute now has bounded factual handoff metadata and accepted child work has a tracked generation/receipt path instead of relying on stale-child announce behavior; late old completions are ignored or attached only to the old generation.

## 2026-07-03

1. **Control UI planner notifications needed session-scoped orchestration filtering**
   - **Issue:** Planner completion popups need `session.activity`, which requires the Control UI to opt into orchestration events. That also exposes global `agent` orchestration events, and the existing compaction handler accepted compaction events without first checking whether they belonged to the visible session/run.
   - **Fix and why:** Added the planner completion toast/chime from terminal top-level planner `session.activity` events, deduped by run, and filtered compaction events through the same visible-session/run acceptance path already used by fallback lifecycle state.
   - **Result:** Top-level planner completions can notify the page without unrelated planner/session compaction events changing the visible UI state.

2. **Docker dependency install missed the package-manager preinstall script**
   - **Issue:** Local `openclaw:local` rebuilds failed during the early Docker `pnpm install --frozen-lockfile` layer because `package.json` runs `scripts/preinstall-package-manager-warning.mjs`, but the Dockerfile copied only a subset of scripts before dependency installation.
   - **Fix and why:** Added `scripts/preinstall-package-manager-warning.mjs` to the early Docker build-stage script copy list, matching the package lifecycle contract before the full source tree is copied.
   - **Result:** Docker rebuilds can pass the preinstall lifecycle step without waiting for the later `COPY . .` layer.

3. **Memory embedding SDK barrel exported removed provider modules**
   - **Issue:** Docker `pnpm build:docker` failed because `src/memory-host-sdk/engine-embeddings.ts` still re-exported old host provider modules that had moved into bundled plugins or no longer existed in core.
   - **Fix and why:** Changed the barrel to export the remaining core embedding runtime helpers and current host utilities consumed by plugin SDK callers, while leaving provider-specific implementations owned by their bundled plugins.
   - **Result:** The Docker build no longer fails on missing memory embedding provider files, and plugin implementations keep using the SDK helper exports without unresolved memory-core-host-engine-embeddings warnings.

4. **Queue idle hid planner yield waits**
   - **Issue:** A selected planner lane could show `Queue idle` while the latest visible planner status was a `sessions_yield` wait on another agent or follow-up. The scheduler snapshot was accurate, but the pill gave the wrong operator cue.
   - **Fix and why:** Added a selected-lane-only `waitHint` from the latest transcript `openclaw.sessions_yield` status and taught the Control UI pill/hover text to show `Waiting on agent` with the yielded status while preserving runtime degraded/error precedence.
   - **Result:** Operators can distinguish an actually idle lane from a planner that intentionally yielded while waiting, without exposing extra transcript or task payload fields in `queue.health`.

5. **Planner context overflow came from unbounded tool-result details**
   - **Issue:** Planner 1 overflowed after large `exec`, `sessions_list`, and `sessions_history` results. Text content was capped, but structured `toolResult.details` still persisted full payloads such as `details.aggregated` diffs and session arrays, so recovery heuristics undercounted and failed to shrink the actual transcript bloat.
   - **Fix and why:** Made live tool-result truncation count text plus structured details, summarize oversized details while preserving small scalar metadata, apply the cap at the tool-definition adapter before transcript persistence, and use the same context-length accounting in overflow recovery.
   - **Result:** New tool results cannot silently carry huge details into planner transcripts, and persisted overflow recovery can now shrink details-heavy tool results instead of only trimming visible text blocks.

6. **Docker gateway crash-looped on a missing subagent spawn export**
   - **Issue:** The local `openclaw:local` gateway image started from `dist/index.js` but crashed before binding `18789` with `ReferenceError: SUBAGENT_SPAWN_CONTEXT_MODES is not defined`. The spawn tool imported the context-mode constant through `src/agents/subagent-spawn.ts`, but that module only re-exported the spawn and sandbox mode constants.
   - **Fix and why:** Re-exported `SUBAGENT_SPAWN_CONTEXT_MODES` and its type from `src/agents/subagent-spawn.ts`, keeping the existing tool import path valid and avoiding a broader import refactor.
   - **Result:** Rebuilding and recreating the Docker gateway image restores the `localhost:18789` listener instead of repeatedly writing startup-failed stability bundles.

7. **Bonjour discovery registration missed the plugin record field**
   - **Issue:** After the subagent export crash was fixed, the rebuilt Docker gateway still failed during Bonjour plugin registration with `Cannot read properties of undefined (reading 'push')`. `PluginRecord` required `gatewayDiscoveryServiceIds`, but the loader-created record did not initialize it, and snapshot/capability capture also ignored gateway discovery services.
   - **Fix and why:** Initialized `gatewayDiscoveryServiceIds` for loaded plugin records and taught captured registration plus bundled capability runtime to preserve gateway discovery services.
   - **Result:** The bundled Bonjour discovery plugin can register without aborting gateway startup, and registry snapshots retain the same discovery-service surface as activating loads.

8. **Channel compatibility exports drifted after presence-policy extraction**
   - **Issue:** The rebuilt gateway served the Control UI, but the `health` RPC failed with `listConfiguredChannelIdsForReadOnlyScope is not defined`. Channel presence helpers still had callers importing through `src/plugins/channel-plugin-ids.ts`, and bundled channel legacy setup helpers were expected by state migration code but were no longer exported.
   - **Fix and why:** Restored channel presence re-exports, typed `openclaw.setupFeatures`, preserved legacy setup-entry loader refs, and added setup-entry-only bundled helper exports so health/status and migration callers stay on the light path.
   - **Result:** Health/status callers can resolve the compatibility exports again without forcing full bundled channel runtime loads.

## 2026-07-04

1. **Embedded Codex ACP rejected legacy service tier**
   - **Issue:** The Docker gateway served `/chat`, but talking to `agent:planner-2:main` produced no useful response because the embedded `codex-acp` backend failed its startup probe with `/home/node/.codex/config.toml:6:16: unknown variant `priority`, expected `fast`or`flex``.
   - **Fix and why:** Updated the host-mounted Codex config from `service_tier = "priority"` to `service_tier = "fast"`, which preserves the intended low-latency tier using the current ACP config enum.
   - **Result:** A gateway restart is enough to make the bind-mounted config visible to the embedded ACP backend; future Docker image rebuilds are not required for this specific config fix.

2. **Control UI could ghost-send before websocket handshake was ready**
   - **Issue:** The Control UI could optimistically show a user chat bubble while the browser client only had an open WebSocket, not a completed Gateway `connect` handshake. In that gap, `chat.send` could be attempted without the gateway accepting it, so talking to the agent looked like it did nothing. Realtime Talk also surfaced the separate setup error `Realtime voice provider "openai" is not configured` when no OpenAI API key was available.
   - **Fix and why:** Made `GatewayBrowserClient.connected` mean handshake-ready, reset handshake state on reconnect, and reject non-`connect` RPCs until `hello-ok` arrives. This converts ghost-sends into normal disconnected/error handling instead of silently dropping operator intent.
   - **Result:** The fixed Control UI only sends chat RPCs after the gateway has accepted the connection. Browser Realtime Talk still requires `talk.provider: "openai"` plus an OpenAI API key before it can create voice sessions.

3. **Planner 2 pointed at a missing transcript after an empty or silent webchat run**
   - **Issue:** `agent:planner-2:main` was repeatedly marked `done` with `systemSent: true` and a freshly generated system prompt report, but its `sessionFile` pointed at a `.jsonl` that did not exist on the host mount or inside the Docker gateway. Deleting the stale row only helped briefly because the auto-reply CLI path could record prompt/model metadata and lifecycle completion without first materializing a transcript; a `NO_REPLY`-only result then normalized to no visible UI message and looked like a chat restart. The Control UI picker also hid configured top-level planners when their session rows were absent from `sessions.list`.
   - **Fix and why:** Added empty/no-visible-reply guards in `runReplyAgent`: if an agent turn produces no visible reply, no out-of-band send/tool/cron side effect, and no expected silent mode, the session is marked `failed`, `systemSent` is cleared, prompt metadata is removed, and the user gets a visible retryable error. The auto-reply CLI branch now persists the CLI turn transcript through the existing transcript helper before emitting lifecycle `end`, so successful CLI turns cannot be metadata-only. The Control UI also includes configured top-level planner keys in the chat picker even when session rows are missing.
   - **Result:** Empty or silent-only webchat CLI runs can no longer masquerade as successful first turns or pin a top-level planner to a missing transcript. The planner dropdown remains populated from agent config even if a row has not been materialized yet.

4. **Control UI ghost-sent before chat.send ACK**
   - **Issue:** A webchat send could append the user bubble and enter running/Stop state before the Gateway acknowledged `chat.send`. If the WebSocket request was stuck or dropped, gateway logs showed no `chat.send` while the UI looked sent/running, making follow-up sends look lost or like an empty/new chat.
   - **Fix and why:** Made `chat.send` ACK-gated in the Control UI, added a 15s per-request ACK timeout through `GatewayBrowserClient.request`, and kept user bubble/run state creation until the server ACK returns.
   - **Result:** A send is no longer shown as accepted until the gateway accepts it; stuck sends become visible retryable errors instead of ghost runs.

## 2026-07-05

1. **Planner ACP runs could finish before transcript proof existed**
   - **Issue:** `agent:planner:main` could be marked `done` with `systemSent: true` while its `sessionFile` was missing or had no assistant message. The Control UI then reloaded an empty completed planner session, and the next send looked like it started a new chat instead of continuing the selected planner.
   - **Fix and why:** Moved ACP lifecycle `end` emission after transcript persistence, fail ACP turns that complete with no visible assistant reply, and made gateway lifecycle persistence downgrade terminal `done` events to `failed` when no assistant transcript can be found.
   - **Result:** Successful planner turns now require persisted assistant transcript proof before the session is recorded as complete; failed/empty turns clear `systemSent` so retries can rebuild the prompt instead of pinning a missing transcript.

2. **Bound ACP bare reset skipped the startup turn**
   - **Issue:** Bound ACP `/new` or `/reset` reset the configured binding target, returned a reset-only reply, and stopped before the normal runner could build the bare session startup prompt. The Control UI picker also exposed configured planner keys with no `sessions.list` row as ordinary selectable targets.
   - **Fix and why:** Let successful bare bound ACP resets continue into the normal agent path while keeping reset-tail dispatch on the ACP same-turn path, and render missing configured planner session rows as disabled picker options.
   - **Result:** Bare ACP resets start a real startup turn, while missing planner rows remain visible for operator context without becoming normal send targets.

3. **Docker rebuild left gateway unstarted after Astino bootstrap OOM**
   - **Issue:** `clawdock-rebuild`/Compose recreated `openclaw-openclaw-gateway-1`, but `astino-deps-bootstrap` was OOM-killed during Yarn fetch and the gateway stayed in `Created` because `docker-compose.extra.yml` gates it on `service_completed_successfully`. Bypassing the dependency started the gateway, but `/chat` still returned empty replies until the long plugin startup finished; profiling showed Jiti/TypeBox loading during gateway plugin bootstrap, and readiness took about 60-75 seconds.
   - **Fix and why:** Started `openclaw-gateway` with `docker compose -f docker-compose.yml -f docker-compose.extra.yml up -d --no-deps openclaw-gateway`, then waited for `/readyz` before using the Control UI. This bypass is an operational recovery path only; the bootstrap OOM and slow plugin load remain separate startup friction.
   - **Result:** `http://127.0.0.1:18789/chat?session=agent%3Aplanner%3Amain` serves again once the gateway is healthy. Future rebuild triage should check `docker compose ... ps -a` first for `Created` gateway plus `astino-deps-bootstrap` exit 137, then check logs for the `ready (...; Ns)` line before treating `/chat` as broken.

4. **ACP pre-completion failures left hollow planner session rows**
   - **Issue:** `agent:planner:main` could still be marked `failed` after a very short ACP run while its `sessionFile` pointed at a `.jsonl` that did not exist. This happened when `acpManager.runTurn` failed before the ACP post-run transcript persistence block ran; lifecycle error handling updated the session row, but nothing materialized the transcript, so the Control UI reloaded an empty lane and the next message looked like a brand-new chat again.
   - **Fix and why:** Persist a durable ACP failure transcript from the pre-completion catch path, using the original user prompt plus a visible failure message, before emitting the lifecycle error. The existing successful ACP path now reuses the same transcript helper so success and failure resolve session cwd/store state consistently.
   - **Result:** ACP startup/backend failures can no longer leave a planner row with metadata but no transcript file. Reloading the selected planner lane should show the failed turn instead of collapsing back to an empty first-turn view.

5. **Accepted webchat sends dropped fast agent failure replies**
   - **Issue:** A `chat.send` `/new` could be ACKed with `status: "started"` and rotate the planner session, but the agent run then failed in a few milliseconds before writing an assistant transcript. The webchat dispatcher received a final error reply, but because `onAgentRunStart` had fired, the gateway assumed the agent-owned transcript path had persisted the assistant message and only broadcast the transient event. Reloading showed an empty failed session again.
   - **Fix and why:** When an accepted webchat send completes with delivered final replies, the gateway now checks whether the transcript already contains an assistant message. If not, it appends the final reply itself with `createIfMissing: true` before broadcasting the final event.
   - **Result:** Fast post-ACK agent failures become durable visible chat messages instead of disappearing into an empty failed planner lane.

6. **Codex Responses payloads were forced to provider-managed store**
   - **Issue:** After the missing `isOpenAIResponsesApi` export was restored, the embedded Codex Responses request reached the backend but failed with `{"detail":"Store must be set to false"}`. `openai-codex` had been included in the provider-managed Responses store allowlist, so the post-plugin OpenAI Responses wrapper changed Codex payloads from `store: false` to `store: true`.
   - **Fix and why:** Kept `openai-codex-responses` recognized as a Responses API that supports the `store` field, but removed `openai-codex` from the provider-managed store allowlist. Codex still emits `store: false`, while direct OpenAI Responses can continue opting into provider-managed store and server compaction.
   - **Result:** Docker CLI `/new` for `agent:planner:main` now produces a persisted Astino planner greeting, and a follow-up `hi` appends to the same session instead of creating another startup turn.

7. **Planner tool tags rendered without executable child creation**
   - **Issue:** `agent:planner-2:main` could show `sessions_spawn` / `sessions_yield` as tool-looking UI cards while no helper session row was created. Two failures overlapped: the embedded Pi runner passed an empty `tools` allowlist while registering OpenClaw tools as custom tools, so converted or native tool calls could be rejected as unavailable; and a stale route-health file containing a complete JSON document plus trailing garbage made fresh helper spawns fail with `Auth route health is unavailable`.
   - **Fix and why:** Normal planner turns now pass the exact registered custom tool names as Pi's session allowlist and activate that allowlist after session creation, matching the compaction runner. Leading XML-style OpenClaw text tool tags are normalized into real tool calls before final text is persisted. Route-health reads now recover the narrow corruption case of a complete valid JSON document followed by trailing garbage, while still failing closed for truly invalid JSON.
   - **Result:** Rebuilding `openclaw:local`, recreating `openclaw-gateway`, and testing through `openclaw gateway call chat.send` now creates a real `planner-helper` child row in `sessions.list`; the child transcript replied `CLI_SPAWN_CHILD_OK`, and the mounted route-health JSON was rewritten valid.

8. **Docker planner startup guessed `/root/.codex`**
   - **Issue:** After bare `/new` started a real startup turn again, Planner 2 exposed a first-turn read of `/root/.codex/AGENTS.md`. The Docker gateway runs as `node` with `CODEX_HOME=/home/node/.codex`, so the upstream read tool returned `EACCES` for the wrong home directory and the planner surfaced that as a startup read failure.
   - **Fix and why:** Wrapped host read operations with an OpenClaw fallback that maps `/root/.codex/...` to the active `CODEX_HOME` or OS-home `.codex` path before reporting failure. This preserves the model's requested path while honoring the Docker-mounted Codex home.
   - **Result:** After rebuilding `openclaw:local` and force-recreating `openclaw-gateway`, a CLI-forced read of `/root/.codex/AGENTS.md` returned the mounted global guidance, and a CLI `/new` for `planner-2` completed with startup tool calls plus a final greeting instead of `EACCES`.

9. **Startup context included empty or stock template files**
   - **Issue:** Once bare `/new` again produced a real startup turn, planners could spend tool calls and tokens on `IDENTITY.md`, `USER.md`, `TOOLS.md`, and `HEARTBEAT.md` files that were still blank scaffolds or unchanged stock templates. The reset prompt also told the model to read startup files even when the runtime had already injected available context.
   - **Fix and why:** Filtered missing, blank, header-only, and template-only bootstrap files out of model run context while preserving substantive notes, `AGENTS.md`, `BOOTSTRAP.md`, and real `MEMORY.md` content. Updated the bare `/new` prompt to use provided startup context and read startup files only when context is truncated/missing, `BOOTSTRAP.md` is present, or the current request needs more detail.
   - **Result:** Startup can still run as a real turn, but stock scaffolding no longer burns context or encourages visible rereads before the greeting.

10. **Planner helper lanes needed live rebuild, child guardrails, and shared auth**

- **Issue:** The live Docker gateway could lag the checkout because Compose did not build `openclaw:local`; helper/planner lanes could keep stale per-agent OAuth credentials; and child sessions that crossed context or tool-loop risk did not leave a clear post-run route/runtime issue.
- **Fix and why:** Rebuilt `openclaw:local` explicitly with Docker, recreated the gateway, added post-run child guardrails for context overflow and excessive tool-call loops, refreshed prompt-token-only `SessionEntry.totalTokens`, and made non-main agents inherit and heal from fresher usable main-agent OAuth credentials when identity matches.
- **Result:** The rebuilt gateway passed health/readiness and a Planner 3 delegation smoke with a real helper child. Remaining work is split into `docs/refactor/planner-child-completion-follow-up-plan.md`, starting with child result finalization.

11. **Failed helper attempts could leave stale running session rows**

- **Issue:** A helper attempt that failed around a gateway restart could report failure to the parent while the durable child session row stayed `running`. The stale row could make the UI look like the helper was still active or context-full and could block same-label retry metadata with `label already in use`.
- **Fix and why:** Persist child terminal timing/status as soon as terminal completion mutates the run record, make route-health terminal recording best-effort, terminalize unexpected `agent.wait` errors instead of swallowing them, and let `sessions.patch` reuse labels held only by terminal old rows.
- **Result:** Failed helper attempts now have a durable `failed` child row even when best-effort telemetry has trouble, and a clean retry can keep the same operator-facing label.

12. **Tool-output-only helpers could be recorded as successful child results**

- **Issue:** A completion-message helper could finish with `ok` while only raw tool output, timeout partial progress, or no visible assistant final reply was available. That could create a successful child result receipt or a misleading `Full child result` pointer even though the parent never received a real child report.
- **Fix and why:** Strict completion capture for success-required children now reads only visible assistant replies; no-visible-reply success is downgraded to a failed child outcome, receipts are cleared, task finalization sees failure, and route health records an error. Timeout partial progress remains inline and no longer masquerades as a full result receipt.
- **Result:** Accepted child work now needs an actual visible final answer before it can produce a successful receipt, while valid final replies still keep the receipt path.

## 2026-07-08

1. **Planner 2 waited forever on a helper child that was never durably registered**
   - **Issue:** `agent:planner-2:main` yielded waiting for helper child `helper-final-env-sanitize-1`, but the task-registry SQLite DB (`<state>/tasks/runs.sqlite`) had a corrupt `idx_task_runs_owner_key` index. Every DB open replays the legacy owner-key migration UPDATEs and every spawn INSERT touches that index, so startup restore failed (swallowed into an empty in-memory registry, never retried due to the `restoreAttempted` latch) and `createRunningTaskRun` threw during spawn. `registerSubagentRun` rethrew after the child gateway run was already started (`src/agents/subagent-spawn.ts` starts the `agent` run before registration), and the best-effort `sessions.delete` cleanup cannot abort an in-flight run. The helper finished normally, but with `runs.json` empty and no task row there was no completion wait, announce, or receipt, so the parent's wait could never be satisfied.
   - **Fix and why:** No code fix applied during diagnostics. Recovery: stop the gateway, back up `tasks/runs.sqlite` plus `-wal`/`-shm` sidecars, run `PRAGMA integrity_check`; index-only corruption is repairable with `REINDEX task_runs`, table-level corruption needs `.recover` into a fresh DB; restart and verify `openclaw tasks list` restores cleanly. Candidate hardening: create the durable task row (queued) before starting the child run so registration failure fails fast with no orphan child, record a child route-health blocker when registration fails, and surface task-store corruption through health/doctor instead of per-spawn warns.
   - **Result:** Root cause is coordination-persistence corruption, not Docker/gateway health. Likely corruption vectors: host CLI and Docker gateway sharing the same WAL-mode SQLite file across the Docker Desktop bind mount (unreliable cross-VM file locking), and/or unclean container kills during force-recreate/OOM.

2. **Docker task DB recovery cleared the orphan-child failure mode for new spawns**
   - **Issue:** The same unregistered-child symptom repeated for `impl-final-env-sanitize-1` while the task DB index corruption was still present; the child finished but the parent could not receive a task/subagent receipt.
   - **Fix and why:** Stopped the Docker gateway, backed up `<state>/tasks/runs.sqlite`, confirmed `PRAGMA integrity_check` reported only `idx_task_runs_owner_key` index corruption, ran `REINDEX task_runs`, verified integrity returned `ok`, and recreated the gateway so the one-shot task-registry restore latch read the repaired DB.
   - **Result:** Gateway health/readiness returned green, post-restart logs showed no `Failed to restore task registry`, `SQLITE_CORRUPT`, or `Failed to create background task` errors, and `tasks list --runtime subagent` restored historical subagent rows instead of returning an empty registry. Existing orphaned children still need manual parent recovery because repair does not synthesize missed receipts retroactively.

3. **Subagent spawn registered the durable task row only after the child gateway run had already started**
   - **Issue:** `spawnSubagentDirect` (`src/agents/subagent-spawn.ts`) started the child `agent` gateway run, then called `registerSubagentRun`, which created the durable task-registry row via `createRunningTaskRun`. If that later create/registration step threw (task-store write failure, corruption, etc.), the child run was already in flight with no durable record at all — the exact gap that made `helper-final-env-sanitize-1` and `impl-final-env-sanitize-1` invisible to `runs.json`/`tasks list` during the DB corruption above. Separately, the happy-path completion call in `waitForSubagentCompletion` (`src/agents/subagent-registry-run-manager.ts`) had no `.catch`, unlike its error-path sibling `terminalizeWaitError`, so a rejection from `completeSubagentRun` (e.g. a failed dynamic plugin-runtime load) could become an unhandled rejection and trip the global handler's `process.exit(1)`.
   - **Fix and why:** Added `registerPendingSubagentTaskRun`/`failPendingSubagentTaskRun` so a queued task-registry row is created via `createQueuedTaskRun` _before_ the child gateway run starts; `registerSubagentRun` now promotes that row to `running` via `reassignTaskRunByRunId` instead of creating a fresh row, falling back to `createRunningTaskRun` only if the pre-registered row is missing. Every failure path between pre-registration and in-process registration (gateway-call failure, `registerSubagentRun` failure) now terminalizes the pending row with `failPendingSubagentTaskRun` instead of leaving it stuck `queued` forever. Added the missing `.catch` to the `waitForSubagentCompletion` happy path, matching `terminalizeWaitError`.
   - **Result:** A spawn attempt now always has a durable task-store row from before the child starts through to a terminal state, even when in-process registration itself fails, so a future task-store hiccup produces a visible `failed` task instead of a silently orphaned child. This does not fix the underlying SQLite index-corruption risk (still needs health/doctor surfacing) and does not stop the child process itself from starting before durable registration completes.

4. **Repeated task-registry registration failures for the same spawn slice had no blocker, so a broken route would keep silently retrying**
   - **Issue:** Before this fix, `spawnSubagentDirect` only fed `recordSubagentSliceRouteHealthUnavailableForSpawn` (the existing "slice budget" route-health tracker in `src/agents/subagent-registry-budget.ts`, which trips a `route_health_unavailable_limit` block after `SUBAGENT_SLICE_ROUTE_HEALTH_UNAVAILABLE_LIMIT` = 2 occurrences for the same requester+task slice) from the auth-preflight `child_route_health_unavailable` path. None of the three registration-failure paths added in entry #3 above (`registerPendingSubagentTaskRun` failing, the child gateway call failing, or `registerSubagentRun` failing) recorded anything, so a persistently broken task-store route (the same SQLite-corruption scenario) would let a caller keep re-spawning into the identical failure indefinitely instead of getting a clear stop signal.
   - **Fix and why:** Factored the existing call into a shared `recordRegistrationRouteHealthUnavailable` helper in `src/agents/subagent-spawn.ts` and call it from all three registration-failure catch blocks, not just the auth-preflight one. Each call increments the slice's `childRouteHealthUnavailableCount`; once the limit trips, the caller gets the `route_health_unavailable_limit` error back instead of the raw per-attempt error, so the blocker is visible after the same number of failures used elsewhere for this budget.
   - **Result:** Two consecutive registration failures for the same requester+task slice (e.g. a still-corrupt task-registry DB) now produce an explicit "stop retrying this route" error on the second attempt instead of silently letting the caller loop into repeated orphaned/invisible spawn attempts. This still does not address the underlying SQLite index-corruption risk itself (task-store health/doctor/PRAGMA checks, item 3 from the original assessment, remain unimplemented).

5. **Task-registry SQLite corruption (item 3 from the original assessment) had no doctor/health surfacing, only the manual recovery runbook from entry #1**
   - **Issue:** The only way to detect the `idx_task_runs_owner_key`-style corruption from entries #1/#2 was to notice downstream symptoms (orphaned children, `Failed to restore task registry` warnings) and manually run `PRAGMA integrity_check` / `REINDEX task_runs` by hand. There was no `openclaw doctor` check for task-registry sqlite health, and `restoreTaskRegistryOnce()` (`src/tasks/task-registry.ts`) opens the DB and immediately replays legacy owner-key migration `UPDATE`s before anything checks whether the file is even readable, so a naive health check added on top of the normal open path would itself risk touching a corrupt index.
   - **Fix and why:** Added `checkTaskRegistrySqliteIntegrity()`/`reindexTaskRegistrySqlite()` to `src/tasks/task-registry.store.sqlite.ts`: a short-lived connection runs `PRAGMA integrity_check` (catching the case where the check itself throws, e.g. "database disk image is malformed") before any schema/migration statement executes. Wired a new `openclaw doctor` contribution (`src/commands/doctor-task-store-health.ts`, registered as `doctor:task-store-health` in `src/flows/doctor-health-contributions.ts`) that reports corruption, classifies it as index-only (all issue lines mention "index") vs. structural, and only offers automatic repair for the index-only case: back up `runs.sqlite` plus `-wal`/`-shm` sidecars, run `REINDEX`, then re-verify. Structural corruption is reported with the manual `.recover` guidance from entry #1 and no automatic repair is attempted.
   - **Result:** `openclaw doctor` (and `openclaw doctor --fix`) now surfaces task-registry sqlite corruption directly instead of requiring someone to notice orphaned-child symptoms first, and repairable index corruption can be fixed in place with an automatic backup. This does not make the in-memory `restoreTaskRegistryOnce()` latch retryable within an already-running gateway process — a repaired DB still requires a gateway restart to be picked up (per entry #2's `Result`) — and does not implement automatic recovery for structural (non-index) corruption.

6. **`restoreTaskRegistryOnce()`'s one-shot latch (entry #5's remaining gap) meant a repaired task-registry DB still needed a full gateway restart to be picked up**
   - **Issue:** `restoreTaskRegistryOnce()` (`src/tasks/task-registry.ts`) set a permanent `restoreAttempted` flag on its very first call regardless of outcome, so if the initial restore failed (the exact corruption scenario in entries #1/#2), the in-memory registry stayed empty for the rest of the process lifetime even after an operator ran `openclaw doctor --fix` (entry #5) or a manual `REINDEX` against the same file. Nothing short of restarting the gateway would ever call `loadSnapshot()` again.
   - **Fix and why:** Replaced the boolean latch with a `pending`/`settled` outcome plus a 30s retry cooldown. While restore has failed and the in-memory registry is still empty (`tasks.size === 0 && taskDeliveryStates.size === 0`), each `ensureTaskRegistryReady()` call (which fires on nearly every task-registry read/write) retries `loadSnapshot()` once the cooldown elapses, so an externally repaired DB is picked up automatically within about 30 seconds of the next task-registry access — no restart required. The moment anything populates the in-memory registry (a successful restore, or a task created directly while restore was still down, e.g. via entry #3's pending-row path), the outcome is marked `settled` and retries stop permanently: merging a since-repaired snapshot on top of live in-memory state at that point risks clobbering data that only exists in memory. Updated the entry #5 doctor success message (`src/commands/doctor-task-store-health.ts`) to reflect that a restart is only needed if the gateway already has in-memory task state.
   - **Result:** A gateway that hits task-registry corruption at startup (before any task is spawned) and gets repaired via `openclaw doctor --fix` recovers without a restart. A gateway that already has in-memory task activity (the more common case once entry #3/#4's pending-row handling has produced any task, even a failed one) still needs a restart, same as before — this fix narrows rather than eliminates the restart requirement. Automatic recovery for structural (non-index) corruption remains unimplemented (manual `.recover` guidance only, per entry #5); this was evaluated and intentionally deferred rather than left unresolved-looking, because there is no safe automated path: Node's built-in `node:sqlite` does not expose the `sqlite3_recover` extension that backs SQLite's real `.recover`, so the only automatable options were shelling out to a system `sqlite3` CLI (new, version-fragile external-process dependency for a rare failure mode) or a hand-rolled SELECT-and-reinsert row salvage (can silently produce a partial database with no reliable way to tell the operator whether recovery was complete). Both traded a rare, already-detected-and-reported failure mode for a new correctness or dependency risk, so manual `.recover` guidance remains the recommended path.

## 2026-07-07

1. **Planner 2 recovery chain ended blocked while diagnostics still said processing**
   - **Issue:** Planner 2 spent hours on the Astino Contract V2 E2E recovery chain by spawning repeated helper children. The final T31 child timed out after 30 minutes, produced no trusted final report, and left partial dirty state; Planner 2 then hit context overflow, auto-compacted, and correctly reported the task blocked. Docker diagnostics continued logging `agent:planner-2:main state=processing` even after `queue.health` showed the Planner 2 lane idle and the session row was `done`.
   - **Fix and why:** No code fix applied during diagnostics. The evidence separates the real task failure from the stale operator signal: the gateway was healthy, Planner 2 was no longer active, and the remaining work is a fresh focused Contract V2 recovery starting from the failed CP-PW-12 state.
   - **Result:** Future triage should check `queue.health` and the planner/child session rows before trusting repeated `stuck session` diagnostics. Treat timed-out helper children as unavailable/poisoned unless they produced a visible final assistant report and a trusted receipt.

2. **Planner prompts overpacked helper recovery briefs**
   - **Issue:** A planner recovery handoff bundled dirty-diff classification, an individual failing-test fix, unit coverage, focused E2E, and the full final gate into one implementer child. The child timed out or hit context pressure, leaving partial evidence and forcing the parent to treat it as poisoned.
   - **Fix and why:** Added full-prompt sub-agent orchestration guidance that tells planners to split multi-step recovery into small sequential slices, keep implementation/testing/adversarial review as separate child phases, and treat timeout/no-final/partial children as blocked slices instead of broadening the same child brief.
   - **Result:** Top-level planners with `sessions_spawn` receive stable prompt guidance to start with the current failing test or smallest recovery target before widening to broader gates.

3. **Full E2E gates were too easy to run inside QA loops**
   - **Issue:** QA or recovery children could treat the full E2E suite as part of ordinary slice validation. When a broad E2E gate failed, the planner could keep the feature loop blocked while repeatedly spawning broad recovery children.
   - **Fix and why:** Tightened planner-facing orchestration guidance and `sessions_spawn.sliceRole` descriptions so QA children are for manual/behavioral checks plus the smallest relevant smoke command, while the full E2E suite belongs only to an explicit `sliceRole: "full_gate"` final-gate child. Native subagent and ACP children now receive child-visible role notices in their initial task context. A failing full gate must report the first failing spec/test id/artifact and stop so the planner can open a fresh narrow recovery slice.
   - **Result:** Full E2E remains the final landing gate, but normal development and QA slices should no longer run the whole suite or repair from broad full-gate failures in-place.

4. **Stale runtime diagnostics outlived terminal planner state**
   - **Issue:** Diagnostic session state could keep reporting `processing` after durable queue/session/run state showed the planner or child lane was idle or terminal.
   - **Fix and why:** Added scalar runtime reconciliation before heartbeat/stuck-session reporting, using queue counts, terminal/reset session rows, and active run records to downgrade stale `processing` to `idle`.
   - **Result:** Operator diagnostics should no longer keep surfacing stale `state=processing` when the runtime queue is empty and the session/run facts are terminal or no active run remains.

5. **Announce retries could stack long waits and queue noise**
   - **Issue:** Repeated announce delivery failures such as `gateway timeout after 120000ms` could still consume the normal transient retry budget, and queued announce drains could reschedule indefinitely after repeated send failures.
   - **Fix and why:** Added a local long-wait retry cap for direct announce delivery while preserving quick transient retries, and capped queued announce drain rescheduling after repeated consecutive failures with scalar-only diagnostics.
   - **Result:** Failed announce paths stop adding unbounded wall-clock delay or retry noise, while one flaky queue failure and quick listener/network transients can still recover.

## 2026-07-09

1. **Stale running task rows kept Codex OAuth refresh failures alive after reauth**
   - **Issue:** After reauth, the Docker gateway still tried to refresh `openai-codex` with an older OAuth refresh token and OpenAI rejected it with `refresh_token_reused`. Both `openai-codex/gpt-5.5` and fallback `openai-codex/gpt-5.4` failed because planner lanes were pinned to stale `openai-codex:default` auth profiles. The task store also still had five stale `cli` tasks marked `running` from April 16, April 18, and May 3.
   - **Fix and why:** Stopped the Docker gateway, backed up `<state>/tasks/runs.sqlite`, marked only those five stale `cli` rows `cancelled` with the same operator-cancel fields used by the task cancel path, then restarted the gateway with `docker-compose.extra.yml` included. A generic model smoke passed, but a planner-lane retry still failed; redacted profile metadata showed stale per-agent `openai-codex:default` credentials. Synced the fresh mounted Codex CLI credential into every managed per-agent `openai-codex:default` profile, backed up each auth profile first, and restarted again so no lane kept stale in-memory auth state.
   - **Result:** `openclaw tasks list --status running --json` returned zero tasks, `/healthz` and `/readyz` were green, the affected profiles expired on July 19, 2026 instead of July 9 or May 17, and a Planner 2 agent-path smoke succeeded on `openai-codex/gpt-5.5` with no fallback. If `refresh_token_reused` recurs after reauth, check stale running task rows, per-agent `openai-codex:default` profile expiry, and restart the gateway before retrying the larger job; only update the task DB directly after a backup if the supported cancel command is wedged.

## 2026-07-10

1. **Restart did not apply the Astino Docker Compose workspace overlay**
   - **Issue:** The checked-in `docker-compose.extra.yml` correctly declared the `/workspace/astino-profiles/master` bind mount, but the running gateway container had been restarted rather than recreated. Its immutable mount set therefore contained only `~/.openclaw`; ACPX failed its startup `mkdir('/workspace')`, and Planner 2 returned `UNAVAILABLE` before processing requests.
   - **Fix and why:** Recreated only `openclaw-gateway` using both compose files and `--no-deps`, which applies the existing overlay without re-running the expensive Astino dependency bootstrap. Verified the mounted planner workspace is writable by the container's `node` user, ACPX registered from `/workspace/astino`, and health/readiness are green.
   - **Result:** When an overlay changes or was not present at a container's creation, use `docker compose -f docker-compose.yml -f docker-compose.extra.yml up -d --force-recreate --no-deps openclaw-gateway`; `restart` alone cannot add or alter bind mounts.

## 2026-07-11

1. **Shell-sourcing the Docker `.env` truncated its package-list build argument**
   - **Issue:** `OPENCLAW_DOCKER_APT_PACKAGES` is intentionally stored as an unquoted space-separated list. `source .env` treated the second package name as a command, so the first rebuild attempt would have omitted most configured runtime packages.
   - **Fix and why:** Cancelled the incomplete build before it tagged the image, then extracted the individual build-argument values line-by-line without executing `.env` as shell code. Rebuilt `openclaw:local` with the complete package list before recreating the gateway.
   - **Result:** For this local `.env` shape, do not shell-source the file to obtain Docker build args; parse the required values without evaluation so whitespace-bearing values remain intact.

## 2026-07-13

1. **The tracked OpenClaw mirror retained a live gateway credential in reachable Git history**
   - **Issue:** Redacting the current `.openclaw/openclaw.json` mirror did not revoke the credential already present in repository history. A full local reachable-object assessment found the retired gateway token in 17 blobs at that path, including refs whose tips exist on `origin`.
   - **Fix and why:** Kept the tracked mirror recursively redacted, rotated the local gateway credential across live auth, remote auth, Docker env, and host env, and verified all current copies agree. No Git history rewrite, remote change, commit, or push was performed.
   - **Result:** The historical token is no longer active. Treat redaction and rotation as separate requirements whenever a secret reaches a tracked file.

2. **`docker compose config` expanded and printed a freshly rotated gateway token**
   - **Issue:** A diagnostic configuration render interpolated environment values and exposed the first replacement token in command output before the gateway started.
   - **Fix and why:** Immediately generated and installed a second replacement across every local token copy, then prohibited further unredacted Compose config rendering during the rollout.
   - **Result:** The disclosed replacement was never left active. Secret-bearing Compose diagnostics must be redacted before output or replaced with field-presence/equality checks.

3. **Testing-lane live validation compared unbound workers with master instead of the active profile**
   - **Issue:** The live guard used explicit planner bindings but ignored `ASTINO_ACTIVE_OPENCLAW_PROFILE_ID` for worker agents whose configured workspace is `/workspace/astino`, producing false HEAD, branch, and remote mismatches in the testing lane.
   - **Fix and why:** Added active-profile state parsing and a tested resolution rule: an explicit planner binding wins, while an unbound `/workspace/astino` agent uses the active lane profile for host identity.
   - **Result:** Testing and master lane live checks now use the authoritative profile catalog and both pass.

4. **The in-container missing-Docker test hit a null `spawnSync.stderr` error path**
   - **Issue:** When the tester ran the guard suite inside the gateway container, `docker` was unavailable and `spawnSync` returned an error with null stderr. The guard called `.trim()` on null, masking the intended model-authority diagnostic; the first tester handoff also had malformed manifest fields and was correctly rejected by the planner.
   - **Fix and why:** Prefer the spawn error message before optional stderr/stdout and added a PATH-isolated regression case. Re-ran a fresh candidate with a fresh tester rather than correcting substantive evidence in place.
   - **Result:** Host and gateway-container suites pass 23/23, the fresh tester manifest validates with no issues, and Planner 4 reports complete coverage with no missed or failed assigned paths.

5. **Dependency bootstrap wrote `.corepack` into the frozen testing checkout**
   - **Issue:** The Astino dependency bootstrap deliberately places `COREPACK_HOME` under the active workspace. In the frozen testing clone this appeared as untracked repository dirtiness, so later planner-binding and return-to-master switches correctly refused to proceed.
   - **Fix and why:** Moved only the generated cache to a temporary external backup before each switch and verified the frozen checkout was clean. The bootstrap cache-location design was not broadened into this accountability rollout.
   - **Result:** The rollout returned safely to master. A future Astino-local-storage slice should move or ignore the generated Corepack cache so frozen-lane switching does not need manual cleanup.

## 2026-07-14

1. **A root-scoped delegation fingerprint produced unbounded repository output**
   - **Issue:** An Astino planner invoked the legacy fingerprint path with `--scope .` in a heavily dirty checkout. The command traversed the repository root and emitted roughly 185 KB of inventory output; adjacent recovery attempts also ran Bash-only `pipefail` under `sh` and queried unsupported help behavior. The incorrect fingerprint was neither persisted nor delegated.
   - **Fix and why:** Added runtime-owned delegation authority with strict `openclaw-scope-v1` file manifests, an explicit operator-authorized repository scope kind, streamed repository hashing, bounded metadata-only results, and supported validator help/version/describe output. Dot, empty, directory, glob, alias, escape, duplicate, and undeclared-missing slice paths are rejected before candidate persistence.
   - **Result:** Guarded candidates can no longer express repository scope as `.` or expose full inventories. Repository-wide work is explicit and protected, while the legacy manifest/ledger CLI remains offline audit-fixture tooling only.

2. **The first runtime-enforced delegation pass still allowed incomplete wave and workspace authority**
   - **Issue:** Adversarial review found that a controller wait timeout could be persisted as a terminal route timeout and satisfy wave settlement without a validated tester/QA receipt; native guarded spawns inherited the worker's configured workspace rather than the slice worktree; candidate freezing did not reject changes outside the finite file scope; report validation could strand a persisted receipt after a gateway crash; and format correction omitted status and coverage from its semantic digest.
   - **Fix and why:** Observation timeouts are now bounded audit events while actual lifecycle run deadlines are the only terminal timeout evidence, and timeouts never approve remediation. Guarded spawn and execution bind and revalidate the slice's canonical worktree. Candidate records keep a protected dirty-path inventory and reject out-of-scope mutations at writable report acceptance and wave freeze. Receipt/correction validation resumes idempotently from immutable persisted bytes. The complete report, including status, coverage, conclusion, scope, and evidence relationships, is semantically hashed; inspected scope requires successful, nontruncated, scope-bound evidence.
   - **Result:** Rejected routes may use their single recovery child without wedging the wave, but every required review route family and conditional QA must end with one progressable validated receipt before consolidated remediation. A slow child remains pending when the planner stops waiting, cross-profile workers execute in the planner-selected worktree, and unreviewed out-of-scope edits fail closed.

3. **The first live Planner 4 canary used an empty read-only staging workspace and lost guarded defaults/tools**
   - **Issue:** The sandbox resolver made every read-only session's copied staging directory its primary workspace, so a guarded planner could not resolve files in its assigned repository. The CLI agent path also ignored per-agent `thinkingDefault`, and the coding profile filtered out `delegation_guard`/`delegation_report` even though the runtime created them.
   - **Fix and why:** Guarded read-only principals now mount the assigned workspace directly as their read-only primary sandbox workdir, while unguarded read-only sessions retain copied-workspace behavior. Agent-scoped thinking resolution now honors the per-agent default, and protected delegation tools are implicitly admitted through the active tool profile only for the matching runtime principal.
   - **Result:** Guarded planners resolve relative repository paths against the protected assignment, start at exact `xhigh`, and can access only their controller tool; guarded workers receive only `delegation_report`. Legacy unguarded sandbox and tool-profile behavior is unchanged.

4. **Guarded assignment authority was still overridden by generic spawn metadata**
   - **Issue:** After the planner tool became available, the first helper route was rejected because the generic spawn request resolved to `sandbox="inherit"`; its single recovery route was then rejected because planner-supplied `sliceRole="implementation"` conflicted with the helper assignment. The independent sandbox tool allowlist could also remove the protected delegation tool after the main profile admitted it.
   - **Fix and why:** Guarded spawn now derives required sandbox mode and slice role exclusively from the consumed assignment token, ignoring generic caller metadata for those authority fields. The independent sandbox allowlist admits only the principal-matching protected controller or worker tool, and planner guidance still states the required sandbox contract for clear operator evidence.
   - **Result:** A planner cannot accidentally or deliberately weaken token-bound sandbox or role identity through generic spawn arguments, and a guarded principal retains exactly its protected delegation tool after both policy layers. The failed slice remained blocked with no worker spawn or file mutation; the corrected runtime requires a fresh slice for the next canary.

## 2026-07-15

1. **Provider and session metadata could weaken exact guarded thinking authority**
   - **Issue:** Live Planner 4 smoke exposed a provider-specific thinking path that bypassed generic exact-level checks, and guarded model/thinking values were re-entering the public `sessions.patch` path as caller overrides.
   - **Fix and why:** Added a provider-runtime exact-thinking gate, persisted assignment-owned model/thinking internally, and limited the public initial patch to topology fields for guarded children.
   - **Result:** Controllers and workers now run at the assignment's exact model/thinking or fail closed; generic directives, patches, switches, and fallbacks cannot silently downgrade them.

2. **Guarded worker reports treated human scope labels as authority**
   - **Issue:** Helpers repeatedly added labels or expectation annotations to `scope.assigned`, causing otherwise complete one-file reports to be rejected even though every inspected/omitted/failed entry named the exact protected path.
   - **Fix and why:** The runtime now derives canonical assigned IDs from the immutable assignment and accepts worker-local labels only when the reported path partition maps one-to-one onto the protected scope. Ambiguous, duplicate, missing, or out-of-scope paths still reject before receipt persistence.
   - **Result:** Human report labels remain evidence, while candidate, assignment, and scope identity are runtime authority as intended.

3. **Accountable failure and artifact evidence caused false report rejection**
   - **Issue:** Coverage validation required every inspected evidence ID to be a command and required every reported command attempt to succeed. An implementer that transparently reported a failed `sh`/`pipefail` attempt, a successful Bash retry, and a path-bound SHA-256 artifact was therefore rejected despite complete successful evidence.
   - **Fix and why:** Path-matching artifacts now qualify as bound evidence, evidence IDs are unique across commands and artifacts, and failed/truncated attempts may remain in a complete report when each inspected scope unit has separate successful, nontruncated bound evidence.
   - **Result:** Workers can report what failed without being incentivized to hide it; complete coverage still fails closed unless every assigned unit has successful authoritative evidence.

4. **Duplicate completion callbacks and stale sandbox images produced false live failures**
   - **Issue:** The same guarded run could reach terminal completion twice and conflict with its first immutable receipt, while the locally tagged sandbox image predated its declared Python dependency and could not run the pinned mutation helper.
   - **Fix and why:** Terminal completion is idempotent for the same assignment/run and preserves the first protected result; different runs still conflict. Rebuilt `openclaw-sandbox:bookworm-slim` and verified `/usr/bin/python3` (`Python 3.11.2`).
   - **Result:** Compatibility transport re-rendering no longer turns a successful protected completion into a false negative, and writable guarded sandboxes can execute the pinned helper.

5. **Host SQLite inspection interfered with the gateway-owned WAL**
   - **Issue:** Opening the live delegation ledger with the macOS host `sqlite3` client while the Linux gateway owned the WAL exposed stale main-database state and interfered with failed-canary checkpointing under Docker Desktop.
   - **Fix and why:** Live rollout checks now use gateway-owned `delegation_guard status` and gateway API reads only; host SQLite access is prohibited while the gateway owns the ledger.
   - **Result:** Protected-state status and persistence checks no longer cross the Docker Desktop SQLite locking boundary.

6. **The Astino validator retained pre-fix evidence semantics**
   - **Issue:** OpenClaw accepted accountable failed attempts plus separate successful or path-bound artifact evidence, but the independently pinned Astino validator still required every command to succeed and every inspected evidence reference to be a command. The canary therefore failed at the adapter boundary after the runtime fix.
   - **Fix and why:** Aligned the Astino validator with the runtime evidence contract, added failed-attempt, artifact-only, and mismatched-artifact regressions, and bumped the pinned validator from `1.0.0` to `1.0.1` with a new digest. The semantic version bump is required because protected stack replacement refuses a same-version digest change.
   - **Result:** Runtime and validator now make the same bounded evidence decision, and the operator install created a new protected stack epoch before further guarded work.

7. **Guarded planners could not restore `xhigh` with `/think xhigh`**
   - **Issue:** Session projection consulted only the active plugin registry when advertising thinking options. After a cold or channel-scoped gateway load, `openai-codex/gpt-5.6-sol` therefore exposed only the generic levels through `high`. The delegation guard then rejected every public thinking patch, including an exact `xhigh` restore that matched the planner's immutable requirement.
   - **Fix and why:** Thinking-policy lookup now falls back to the provider hook loader when the provider is absent from the active registry, session rows report the configured per-agent default, and guarded session patching permits only the principal's exact required thinking value while continuing to reject every conflicting thinking, model, reasoning, or fast-mode override.
   - **Result:** `/think xhigh` is available again for the guarded planners, and planner, planner-helper, and implementer retain exact `xhigh` defaults without allowing a downgrade or a silent `xhigh`-to-`high` remap.

8. **Provider thinking fallback pulled server-only code into the Control UI bundle**
   - **Issue:** The first `/think xhigh` restoration imported the provider hook runtime from the shared thinking-policy module. The Control UI also imports that shared module, so Vite bundled a server-only dependency graph and the browser crashed at startup with `ReferenceError: process is not defined`, leaving `http://localhost:18789/` black.
   - **Fix and why:** Kept shared thinking-policy lookup limited to the browser-safe active registry and moved cold provider-hook resolution into the gateway-only session projection path. Runtime execution and session metadata now share the targeted provider profile without exposing loader, filesystem, or process dependencies to the browser bundle.
   - **Result:** The Control UI can render again while session metadata still advertises `xhigh`/`max` for supported provider models and exact guarded thinking remains enforced.

9. **A stale planner override and raw thinking comparison blocked an `xhigh` restore**
   - **Issue:** Planner 2 retained an older persisted `high` session override after its configured default became `xhigh`. The guard correctly blocked delegation, but the Control UI's restore request could still be rejected because the guarded patch check compared the raw client spelling with the canonical policy value.
   - **Fix and why:** Restored the live Planner 2 session to canonical `xhigh` and changed guarded session patching to compare normalized thinking values while still rejecting every level that does not resolve to the immutable requirement.
   - **Result:** Planner 2 starts from an effective `xhigh` session again, and `/think xhigh` or an equivalent supported spelling restores the required value without weakening guarded thinking authority.

10. **Rejected report correction could not complete an already-ended worker run**
    - **Issue:** A structurally rejected guarded report was not retained as protected correction input, and a later valid format correction could not promote the worker's already-ended terminal output into a completed receipt.
    - **Fix and why:** Persisted rejected receipts and validations, added append-only terminal-result staging, and made an accepted format correction promote the staged terminal result transactionally.
    - **Result:** The canary's deliberately malformed QA report produced protected rejection IDs, its one allowed format correction validated, and the corrected assignment reached protected completion without another worker turn.

11. **Generic session gates ran before protected send authority and lost restart ownership**
    - **Issue:** A guarded `sessions_send` was first rejected by generic cross-agent visibility. After that ordering was fixed and the gateway recreated, the immutable assignment still existed but the ephemeral subagent registry did not, so child-route health rejected the authorized target as untrusted.
    - **Fix and why:** Authorize the exact one-use protected route before applying generic visibility, and use the authorized ledger binding only to restore child ownership when the in-memory registry is empty. Unguarded sends retain the existing visibility and tracked-child requirements; persistent route-health blockers still run.
    - **Result:** Focused visibility, restart-recovery, child-health, and delegation-authorization tests pass. The rejected canary route used its single required fresh-child recovery assignment, whose tester receipt validated successfully.

12. **Generated dependency bootstrap exhausted Docker Desktop memory during rollout**
    - **Issue:** The generated Compose dependency/bootstrap service was OOM-killed twice while fetching the large workspace dependency tree. A raw fallback image build also lacked Docker CLI until the declared build arguments were applied.
    - **Fix and why:** Preserved the generated overlay, rebuilt `openclaw:local` with the configured runtime packages, browser bundle, and Docker CLI, then recreated the gateway with both Compose files and `--no-deps` so persistent dependencies were reused rather than replaced.
    - **Result:** The final image exposes Docker CLI, the gateway is healthy and ready, and the protected state survived a post-canary force recreation.

13. **Final delegation-runtime staged rollout completed and was cleaned up**

- **Issue:** Earlier canary attempts left the final staged-rollout claim incomplete and accumulated explicit planner sessions, child sessions, sandbox containers, and a slice-local fixture.
- **Fix and why:** Completed helper discovery, exact-thinking implementation, concurrent tester/reviewer review, rejected-plus-corrected QA evidence, one consolidated remediation, targeted confirmation, single route-rejection recovery, and post-recreation receipt validation. Then deleted every staged-rollout controller/child session, owned sandbox container, prompt file, and fixture while preserving Planner 2 and its children.
- **Result:** The protected slice reports `ok`; the recovery tester and reviewer remain `completed` with stable receipt IDs after recreation; no staged-rollout sessions, containers, or workspace artifacts remain.

14. **Gateway dispatch rechecked ephemeral ownership after consuming protected send authority**

- **Issue:** The local `sessions_send` path could authorize a guarded follow-up from the immutable ledger, consume its one-use route token, and then lose the request at the Gateway agent handler because that second layer rechecked only the restart-volatile subagent registry. Final review also found that a failed terminal task write could leave an in-memory terminal state ahead of SQLite, and accepted pre-crash dispatch proof did not require the durable task row that must already exist.
  - **Fix and why:** Added an opaque, one-use Gateway dispatch capability bound to the assignment, route-token hash, controller session, target child, idempotency key, and epoch. Send-token consumption and capability creation now commit atomically. Gateway use creates an idempotent durable claim before restoring only the missing ownership fact. Guarded inter-session runs are durably enqueued before execution, and acceptance is transactionally paired with an append-only run record bound to the current gateway writer before the in-process promise is allowed to start. A proof-write failure terminalizes the queued task and route without executing agent work. Every production ledger caller uses one configured opener with mandatory task reconciliation. On normal completion, the Gateway immediately records protected execution completion before its final response; an existing receipt remains authoritative, while a receipt-less completed execution becomes validation-rejected and cannot age into recoverable missing-task state. On gateway reopen, issued-but-unclaimed capabilities become rejected outcomes and recovery evidence; claimed dispatches without an outcome, legacy accepted outcomes without run proof, and accepted-but-unfinished runs owned by a prior gateway writer first terminalize the exact durable CLI task, then reconcile to route rejection and the one allowed fresh recovery. Accepted pre-crash proof now requires its durable task row, while the claimed-before-enqueue window may legitimately omit it. Restart reconciliation selects only still-open assignments and aggregates every prior-writer run for an assignment before making one decision; any succeeded run blocks recovery regardless of row order, while only an all-interrupted set may create route-rejection evidence. Historical terminal routes and receipts do not require task rows after normal retention pruning. Failed terminal writes roll memory and every derived task index back to the durable record and latch reconciliation closed for the process. Task-store restore or terminal-write failures abort ledger open and roll back recovery evidence. All persistent child-health blockers still run.
  - **Result:** Composed Gateway coverage proves dispatch succeeds with an empty in-memory registry, guarded runs reach durable terminal task state, a proof-write failure starts zero agent runs, and a same-process accepted outcome replays without another run. Process-reopen coverage proves the pre-claim, final pre-dispatch, claimed-without-outcome, and accepted-before-completion crash windows all reconcile to recoverable rejection without a stale active task. The succeeded-before-caller-ack window blocks recovery even when an interrupted run is reconciled first, and a subsequent restart remains healthy after simulated terminal-task pruning. Real task-store load and terminal-write failures fail closed; a same-process retry observes the original running record and cannot publish recovery evidence, missing accepted-run task state is treated as corruption, wrong bindings and rollback epochs fail, and persistent health blockers still reject. A live recreation preserved Planner 2 and protected ledger authority; the interrupted-child canary issued its protected send token after restart and then correctly stopped at the separate fresh-assignment recovery rule. All canary sessions, transcripts, sandboxes, and fixtures were removed afterward.

## 2026-07-16

1. **Fresh planner sessions displayed a generic thinking default instead of the agent default**
   - **Issue:** Session and Control UI projections recomputed a model-level thinking default without the session agent ID, and the active UI helper ignored the agent-scoped default already returned by `sessions.list`. Planner Helper and Implementer therefore appeared to start at a generic level even though their configured `thinkingDefault` was exact `xhigh`.
   - **Fix and why:** Threaded the session agent ID through gateway, TUI, and status-tool default resolution, and made the active Control UI selector prefer the session row's advertised thinking options and default.
   - **Result:** Fresh/no-override Planner 1–4, Planner Helper, and Implementer sessions now resolve and display `xhigh`; targeted regressions, type checks, production build, and live gateway checks passed.

2. **Initial guarded spawns bound assignments before issuing exact Gateway authority**
   - **Issue:** `sessions_spawn` consumed the controller assignment token and bound it to a provisional child, but the initial Gateway `agent` request carried no delegation dispatch capability. The Gateway correctly rejected the now-guarded child before execution, while the caller classified the deterministic rejection as generic child-route unavailability and left the assignment open, blocking rollback. Review also found that the initial path creates `subagent` and `cli` durable tasks with the same run ID, unscoped restart lookup selected the wrong task, and post-claim validation or session-store failures could escape without immediate protected settlement.
   - **Fix and why:** Initial spawn binding and an opaque capability scoped to the exact controller session, child session, idempotency key, token use, and epoch now commit in one ledger transaction. Gateway enqueue records protected run proof and initial route acceptance before execution starts, and a request-wide post-claim boundary rejects every ordinary pre-execution exit. Restart reconciliation selects the exact runtime/child task, terminalizes both legacy and capability-backed interrupted initial-spawn tasks, and exposes only rejected/no-run-proof child bindings for required pending-state and session cleanup before recovery. Controller cleanup verifies the durable subagent task is terminal, surfaces cleanup failures, and a tool-level catch-all terminalizes unexpected spawn exceptions without charging the generic route-health budget.
   - **Result:** Source regressions prove exact protected helper startup, one-execution capability replay, fail-closed missing/mismatched/stale authority, immediate post-claim rejection, dual-task restart recovery, required recovery cleanup, terminal assignment state, and unblocked rollback without deleting receipts or inventing completion evidence.

3. **Bootstrap limits silently removed workspace policy from agent context**
   - **Issue:** `AGENTS.md` used the same mechanical per-file truncation as ordinary bootstrap files, so policy in the omitted middle could be missing from the initial agent prompt while the run continued.
   - **Fix and why:** Reserved complete `AGENTS.md` content ahead of optional bootstrap context, exempted it from `bootstrapMaxChars`, and made agent execution fail closed when policy cannot fit within `bootstrapTotalMaxChars`. Near-limit prompt and doctor warnings now identify the effective file or total budget; doctor alone may render a truncated diagnostic copy so it can explain an over-limit policy.
   - **Result:** Agents no longer run with partially injected `AGENTS.md`; repository-size, reordered-file, overflow, warning, doctor, CLI, and embedded prompt regressions cover the contract.

4. **Bootstrap truncation silently removed workspace policy**
   - **Issue:** `AGENTS.md` used the same content-unaware per-file head/tail truncation as ordinary bootstrap files. A policy file slightly above `bootstrapMaxChars` could therefore lose middle instructions while the agent continued running with partial workspace authority.
   - **Fix and why:** Exempted `AGENTS.md` from the ordinary per-file cap, reserved its complete contents within the total bootstrap budget regardless of hook ordering, and made policy overflow fail closed instead of injecting a partial file. Bootstrap budget analysis now treats `AGENTS.md` against `bootstrapTotalMaxChars` and emits a prompt/doctor warning at 80% usage.
   - **Result:** Regression coverage prevents default-limit drift or repository policy growth from silently truncating `AGENTS.md`; near-limit pressure is visible before failure, and an over-total policy stops the run with an actionable configuration error.

## 2026-07-19

1. **Guarded post-report failures could remain awaiting or lose terminal evidence**
   - **Issue:** A timeout after report submission attempted the forbidden `timeout` transition, controller completion checks preferred an accepted report over later `validation_rejected` evidence, successful wait/read calls dropped stop-reason and timing metadata, late session refresh could fan one result across multiple generations and downgrade truncation, compatibility receipts overwrote prior result revisions, and restart validation missed receipt coexistence with rejected or timed-out routes.
   - **Fix and why:** Post-report deadlines now settle as fail-closed `validation_rejected`; controller reads expose terminal completion rejection before awaiting; wait and `sessions_send` results preserve typed completion metadata; late refresh requires one unambiguous generation and keeps truncation monotonic; result receipt IDs are content-addressed so refreshed bytes append a new revision; and reopen rejects contradictory route/receipt history while allowing an exact receipt-backed validation rejection at the same timestamp.
   - **Result:** Focused controller, lifecycle, wait, receipt, restart-integrity, and lifecycle E2E regressions pass without enabling automatic continuation or recovery from `validation_rejected`.

2. **Accepted format correction masked later terminal rejection during completion promotion**
   - **Issue:** Once a rejected report had an accepted format correction, completion promotion ignored every `validation_rejected` event for the assignment. A late worker result could therefore create a completed terminal receipt after a post-report timeout had already rejected the route.
   - **Fix and why:** Completion promotion now exempts only rejection events explicitly bound to the superseded original receipt. Global rejection and rejection tied to the corrected receipt remain terminal before and after ledger reopen.
   - **Result:** Late terminal result evidence remains recorded, but it cannot replace the authoritative rejection or promote the assignment to completed.

3. **Equal-time validation rejection lookup used random IDs as precedence**
   - **Issue:** When the superseded original-receipt rejection and an applicable terminal rejection shared one millisecond timestamp, lookup ordered them by randomly generated event ID. Controller completion could therefore alternate between terminal rejection and awaiting state across equivalent runs.
   - **Fix and why:** Rejection lookup now receives the accepted receipt identity, filters only the rejection belonging to its superseded original receipt, and uses append order for equal-time events.
   - **Result:** Equal-time replay deterministically returns the applicable terminal rejection and keeps controller completion fail-closed.

4. **Legacy result receipt hydration could attach refreshed bytes to an old identity**
   - **Issue:** Hydration searched mutable live runs before the exact persisted receipt. A refreshed run could therefore supply new result bytes while the parent event retained the legacy receipt ID and its original metadata.
   - **Fix and why:** Hydration now resolves an exact persisted receipt first, falls back to the live run only when none exists, and derives byte length and digest from the selected result text.
   - **Result:** Legacy receipt identity, hydrated result bytes, byte count, and digest remain consistent even after the live run refreshes.

5. **Fresh-child receipt failure dropped terminal wait metadata**
   - **Issue:** The fresh-child `sessions_send` path resolved timing and raw stop-reason metadata after waiting, but omitted it when post-wait result-receipt persistence failed.
   - **Fix and why:** The receipt-failure response now spreads the same completion metadata as success, timeout, and agent-error responses.
   - **Result:** Parents retain terminal timing and truncation classification across every waited fresh-child result shape.

6. **Correction supersession and restart checks needed exact event identity and provable order**
   - **Issue:** Receipt and validation IDs alone did not identify the one superseded rejection event: a missing original event still allowed correction promotion, while a later duplicate tuple could be masked. The first append-order migration also ranked every equal-time receipt before its route event, which could invert legacy route-before-receipt corruption into apparently valid history.
   - **Fix and why:** A correction now requires exactly one matching rejection event strictly between the original and corrected receipt append sequences and exempts only that immutable event ID. The versioned migration preserves non-ambiguous committed v1 order, but rejects every equal-time legacy receipt/rejection tie because the v1 marker may itself follow the earlier inferred backfill and cannot prove row-level provenance. Matching payload IDs never substitute for causal evidence. Failed migration and reopen checks release the database handle for repeatable operator recovery.
   - **Result:** Missing, duplicate, earlier, later, global, and corrected-receipt rejection evidence remains terminal, trustworthy prior order is preserved, and identity-bearing payload fields cannot launder ambiguous causal history.

## 2026-07-20

1. **Final provenance and historical correction recovery lacked durable authority**
   - **Issue:** Release and container output could carry nullable or unverified source identity, stripped source maps had no manifest-bound retained artifact, and the one known completed-format-correction ledger contradiction had no safe recovery path. Separately, an older stale-active subagent row could eclipse a newer restarted generation after its wait timed out.
   - **Fix and why:** Builds now require and cross-check a full revision, emit a deterministic hashed runtime/source-map manifest, publish retained provenance bundles, and stamp OCI revision metadata. The delegation ledger gained one stopped-gateway, operator-authorized, append-only repair event and receipt for the exact missing-supersession shape; every other corruption remains fail-closed. Child-session lookup now selects the newest deterministic run generation instead of preferring activity state across generations.
   - **Result:** Source and release artifacts have an auditable source-to-output chain, the historical contradiction can be repaired without rewriting evidence, and restarted follow-up runs remain current. Runtime rebuild, deployment, and installed QA remain separate operator phases and were not performed by this source implementation.

2. **Installed correction history included a pre-correction completion rejection outside the first repair shape**
   - **Issue:** The installed completed correction had four route events, including the exact receipt-bound supersession and a same-run `missing-accepted-report` observation written at the terminal-result timestamp before the corrected receipt. Strict open correctly kept the extra rejection authoritative, while the original maintenance contract rejected the additional event counts.
   - **Fix and why:** Added a versioned repair case for only that observed chronology. Its authorization fingerprints the complete four-event identities, canonical payloads, append order, timestamps, exact counts, unique terminal-run/child-session binding, correction and terminal state, validator, pre-repair head, operator, ticket, and idempotency evidence. Strict open exempts the extra rejection only when the immutable repair event and receipt reproduce every bound fact.
   - **Result:** The exact historical sequence can receive a forward-only operator repair without rewriting evidence; wrong identities, payloads, binding, ordering, counts, timing, stale heads, and all additional rejection shapes remain fail-closed.

## 2026-07-21

1. **Session-only child completion waited for the parent agent's full follow-up turn**
   - **Issue:** A completed protected child successfully handed its receipt to an idle parent through a direct `agent` callback, but delivery waited for the parent's final response. The parent consumed the completion and continued orchestration for longer than 120 seconds, so the callback reported two gateway timeouts and delayed child cleanup even though the handoff had already been accepted.
   - **Fix and why:** Session-only completion callbacks now settle when the gateway accepts the idempotent parent turn. Completion callbacks that deliver to an external channel still wait for the final response, as do non-completion direct announces.
   - **Result:** Parent follow-up duration no longer converts an accepted internal completion handoff into a false delivery failure or holds the child lifecycle open.

2. **Corrected slice could not reuse an accepted discovery receipt**
   - **Issue:** A later reviewer failure correctly forced a new same-epoch slice, but discovery prerequisites were slice-local. Revalidating the prior accepted receipt did not bind it to the corrected slice, while replaying the helper was explicitly prohibited.
   - **Fix and why:** Added an owner-authorized, append-only discovery receipt adoption bound to one provably unstarted reconciled target assignment and the exact later reviewer `missing-accepted-report` rejection that forced the corrected slice. The blocker must reproduce the receipt-free production lifecycle: one accepted route, matching child/run binding, one protected terminal result, the exact run-bound rejection, and no reviewer receipt, validation, or terminal receipt. The contract also requires causal ordering plus the exact controller/session, helper facts, canonical scope, repository root, baseline fingerprint and inventory, epoch, accepted validation, terminal receipt, post-reconciliation authorization timestamp, operator authorization, and idempotency key.
   - **Result:** A corrected slice can progress from existing validated discovery without fabricating a worker run, while stale, mismatched, executed, incomplete, or differently authorized evidence remains fail-closed.

3. **Verifier evidence IDs and installed-runtime proof were unavailable in guarded sandboxes**
   - **Issue:** Tester and reviewer reports reused short local evidence labels that collided within each report and reached the one-shot submission path without a non-mutating format check. Their sandboxes also correctly lacked Docker, host-source, and raw-ledger access, but no assignment-authorized runtime evidence surface existed to replace those prohibited capabilities.
   - **Fix and why:** The protected report producer now deterministically binds worker-local evidence IDs to the immutable assignment and rewrites all references, while rejecting duplicate producers, forged namespaces, missing references, and cross-assignment identity. `delegation_report` gained a non-terminal preflight that shares its canonicalization, immutable report-slot, validator path, and post-validator writable-scope check with submit. Guarded tester/reviewer lanes gained `delegation_evidence`, a no-argument, read-only, schema-validated snapshot of their exact candidate, protected linkage, twice-verified root-owned runtime/source-map/validator provenance, image-bound container identity, fixed live probes, artifact-bound contract attestations, and lane-only cleanup inventory.
   - **Result:** Different assignments can safely reuse `E1`, correctable format errors can be caught without consuming protected report state, and verifiers can cite authoritative installed-runtime digests without receiving Docker, arbitrary host execution, source-checkout, configuration, or raw SQLite/WAL authority. Legacy ledger records remain byte-preserved and strict validation stays fail-closed.
