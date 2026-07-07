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
