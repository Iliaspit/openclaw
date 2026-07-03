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
