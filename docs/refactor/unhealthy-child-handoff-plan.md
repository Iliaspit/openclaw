# Unhealthy Child Session Handoff Plan

This plan covers the fix for planner work being sent into unhealthy or bloated
child sessions, including sub-agent and ACP-backed child lineage, based on the
June 2026 Docker log investigation and the runtime-health visibility work.

## Problem

Planner-owned child sessions can become poor targets for follow-up work after
context overflow, conversation/session expiry, auth-profile expiry, repeated
edit failures, or lifecycle failure. Today, a planner can still attempt to reuse
that child. In the observed case, the queue was not backed up, but planner work
was sent to an existing child that had already crossed risk signals, then the
child failed with an upstream `session_expired` error.

The fix should not treat the command queue as the owner of this decision. Queue
state describes scheduling pressure. Child reuse safety belongs at the child
routing, steering, and session-lineage boundary.

## Design Principles

- The runtime enforces the invariant; the planner reacts to the result.
- Reusing an unhealthy child must fail before enqueue, delivery,
  delivery-triggered abort, restart, reactivation, accepted/dedupe
  acknowledgement, session-store writes, or registry mutation.
- Child-target detection must not rely only on the `subagent:` string shape. It
  must include active registry records, stale registry-restored records, session
  lineage fields such as `spawnedBy` and `parentSessionKey`, derived-session
  metadata such as fork or compaction-branch ancestry, and spawned child key
  families such as `subagent:*` and `acp:*`.
- Explicit recovery controls such as abort, kill, delete, reset, and operator
  repair flows must remain available for unhealthy children. The guard blocks new
  follow-up work, not cleanup or recovery.
- Route health must come from a durable control-plane source, not from
  `queue.health` snapshots or the current bounded in-memory runtime-health map.
- Retention may prune detailed events, but it must not make a still-expired auth
  profile, expired child conversation, or unrepaired context-overflow child look
  healthy again.
- The first slice should fail closed instead of auto-rerouting.
- A fresh child needs task context, not a raw clone of the bloated child
  transcript.
- The planner owns the semantic handoff summary.
- The runtime owns factual handoff metadata such as run ids, health codes,
  delivery attempts, and requester-generation fences.
- Auto-reroute is allowed only after rejected-attempt, terminal-receipt,
  generation, and auth-action invariants are in place.

## Route Health Contract

Use closed codes and closed actions. Do not branch on gateway error messages,
provider prose, or planner-facing instruction text.

Initial route-health codes:

- `child_conversation_expired`: the child conversation/session itself is no
  longer a usable continuation target.
- `auth_profile_session_expired`: the provider auth profile, credential source,
  or upstream login state expired.
- `context_overflow`: the child has active, unrecovered, or failed-recovery model
  context overflow.
- `agent_lifecycle_blocked`: the child run reached blocked lifecycle health.
- `agent_lifecycle_abandoned`: the child run reached abandoned lifecycle health.
- `agent_lifecycle_error`: the child run reached bad terminal lifecycle health.
- `edit_failure_threshold`: repeated mechanical edit failures crossed the
  configured threshold.

Initial recommended actions:

- `spawn_fresh`: create a fresh child after the required handoff and generation
  invariants exist.
- `reauth`: stop the request and require an operator or provider auth state
  transition before retrying.
- `fallback_profile`: retry only on a configured healthy fallback profile.
- `stop`: fail terminally because no safe automatic continuation exists.

Action mapping rules:

- Child-local failures such as `child_conversation_expired`,
  `context_overflow`, bad lifecycle outcomes, and `edit_failure_threshold`
  may recommend `spawn_fresh`.
- `auth_profile_session_expired` must not recommend `spawn_fresh` by itself. It
  recommends `fallback_profile` when a configured healthy fallback credential is
  selected for this route, otherwise `reauth`, otherwise `stop`.
- If auth-profile expiry appears with child-local failures, the auth action wins
  until there is an auth state transition or positive auth probe for the failing
  credential scope. A fresh child on the same expired profile or credential
  source would only replay the same failure mode.
- Upstream raw errors named `session_expired` must be normalized before route
  health sees them. Provider/login failures become
  `auth_profile_session_expired`; unusable child continuation state becomes
  `child_conversation_expired`.

## Deliverables

### D0. Route-Safe Health History

Create a durable health-history source that route guards can safely consult.
The existing runtime-health ledger is useful operator visibility, but it is
bounded, in-memory, run-keyed, and cleared on normal lifecycle transitions. It
should not be the only source for rejecting child reuse.

Storage owner:

- The owner is a new child route-health store in the sub-agent and child
  control-plane state family, backed by
  `OPENCLAW_STATE_DIR/subagents/route-health.json`.
- The store belongs under the `src/agents` child routing/control surface, next to
  the persisted sub-agent run registry. It is not owned by the session store,
  task queue, UI queue-health layer, or provider-specific auth code.
- The implementation must not copy the existing best-effort persisted run
  registry behavior where read/write failures are ignored. Route-health storage
  is a routing safety input, so unavailable storage is a closed failure.
- The store must use a versioned JSON shape and the existing state-dir
  resolution path so tests can isolate it with `OPENCLAW_STATE_DIR`.
- The store must define a cross-process write-concurrency strategy. Atomic JSON
  replacement alone is not enough; route-health updates must use a file lock,
  append-only event log, or read-merge-write protocol that prevents one worker
  from losing another worker's recent health event.

Required event producers:

- Agent lifecycle events write `agent_lifecycle_blocked`,
  `agent_lifecycle_abandoned`, and bad terminal `agent_lifecycle_error`.
- Context-overflow detection writes a provisional `context_overflow` event that
  is resolved by the recovery outcome. Successful overflow recovery records a
  success marker and clears or downgrades the provisional blocker for that run;
  failed recovery and post-compaction failures keep `context_overflow` as a hard
  blocker.
- The actual model-request assembly path writes bounded context-headroom
  telemetry after it has assembled or estimated the prompt it is about to send.
  This telemetry is scalar metadata, not a transcript copy: estimated prompt
  tokens, model context limit when known, headroom percent or tokens when known,
  estimate source, last compaction status, and observed timestamp. The
  orchestrator must consume this maintained telemetry instead of rebuilding the
  child's raw prompt or reading the full child transcript before each assignment.
- Failover and provider error classification writes
  `auth_profile_session_expired` or `child_conversation_expired` after D6
  normalization rules are available.
- Sub-agent and tracked ACP child terminal state updates write successful
  completion markers and bad terminal outcomes.
- Repair and lifecycle-control surfaces write state-transition events:
  `sessions.reset`, gateway `agent` `/new` and `/reset`, ACP bound-session reset,
  `sessions.delete`, sub-agent kill, successful manual compaction, failed manual
  compaction, compaction checkpoint restore, and compaction branch creation from
  a child or unhealthy source transcript.
- Edit-tool failure counting writes `edit_failure_threshold` once D8 exists.

Expected output:

- Per-child and per-run health history keyed by both `childSessionKey` and
  `runId`.
- Per-provider and per-auth-scope health indexes keyed by provider id plus a
  stable credential scope: auth profile key when known, credential source when
  there is no profile key, or a provider-scoped `unknown/default` credential
  bucket when the failing credential cannot be identified more precisely. Auth
  blockers must apply across children, not only to the child that first observed
  the failure.
- Stable route-health event identity: every event has a schema version, stable
  `eventId` or deterministic event hash, observed timestamp, expiry timestamp
  when applicable, source surface, child session key when known, run id when
  known, and provider/auth-scope context when known.
- Latest context-headroom snapshot per child/run: estimated prompt tokens, model
  context limit when known, headroom percent or tokens when known, estimate
  source (`actual_request`, `preflight_estimate`, or `unknown`), last compaction
  status, and timestamp. Retention may prune older snapshots, but the latest
  snapshot for a tracked child remains available to assignment preflight until a
  fresh generation replaces that child or a reset clears it.
- Provider context when known: provider id, model id, auth profile key,
  credential source or unknown/default credential bucket, and requester session
  key.
- Closed health codes from the Route Health Contract section.
- A defined initial evidence window: 30 minutes for transient or ambiguous
  evidence that has no durable target state. Structural blockers are not cleared
  by time alone:
  - `auth_profile_session_expired` remains active for that provider credential
    scope until an auth state transition or a positive auth probe for the same
    scope. Selecting a healthy fallback credential records a route override, but
    it does not clear the original failing credential scope.
  - `child_conversation_expired` remains active for that child continuation
    target until the child is reset, replaced, or a new usable conversation id is
    recorded.
  - Failed-recovery or post-compaction `context_overflow` remains active until
    successful overflow recovery, an explicit session reset, or a later
    successful accepted ordinary execution run proves the child is usable.
- Bounded retention: keep at most 24 hours of route-health events, 200 events
  per child, and 5000 events total. Keep the latest success marker per child
  even when old event details are pruned.
- Retention caps may prune detailed event payloads, but the store must preserve
  compact active-blocker summaries or tombstones for hard blockers until their
  clearing transition is recorded. If the cap is reached, prune non-blocking and
  superseded records first.
- A route-safe read API that does not clear state as a side effect.
- Explicit read/write failure behavior:
  - If route-health read fails before a child reuse decision, reject the request
    with a retryable control-plane error and do not enqueue or mutate child
    state.
  - If recording a new health event fails, log a sanitized warning and keep the
    originating runtime failure visible to the requester; do not report a false
    healthy route decision from missing persistence.
  - If recording a hard-blocking health event fails, the route-health subsystem
    must mark the affected child/auth scope or the whole route-health source
    unavailable until the event is persisted, superseded by a valid clearing
    transition, or explicitly repaired. Future guards must fail closed as
    `child_route_health_unavailable`; they must not treat the missing event as
    healthy.
  - If a rejected-attempt write fails, D2 must return a retryable
    control-plane error and must not fall through to normal child delivery.
- Explicit de-poisoning rules:
  - Child-local bad events can be superseded by a later successful accepted run
    for the same child and a newer run id or requester generation only when that
    run is ordinary target execution that exercised the child transcript.
    Completion receipts, descendant wakes, repair controls, transcript
    injections, and other bounded control messages do not clear child-local
    blockers by themselves.
  - A provisional `context_overflow` event from an overflow-retry attempt is
    superseded by successful overflow recovery for that same run. Failed recovery
    and post-compaction overflow remain hard blockers until successful recovery,
    explicit reset, replacement, or a later successful accepted ordinary
    execution run proves the child is usable.
  - `auth_profile_session_expired` is cleared only by an auth state transition or
    a positive auth probe for the same provider credential scope. A child success
    on another profile, env credential, or fallback credential must not silently
    clear the expired scope.
  - `child_conversation_expired` is cleared only by session reset, replacement,
    or a new usable child conversation identity. Waiting for retention expiry is
    not a repair.
  - Session reset, replacement, successful compaction, and checkpoint restore can
    clear or rewrite only child-local blockers. They must not clear
    `auth_profile_session_expired`; auth health needs its own auth transition or
    positive auth probe for the failing credential scope.
  - Checkpoint restore is a new transcript state. It must either clear a stale
    context blocker only when the restored checkpoint is known usable, or keep a
    blocker when it restores a pre-compaction or overflow-risk transcript.
  - A compaction branch or derived session from an unhealthy child does not start
    healthy by default. It must inherit or rewrite child-local blockers according
    to the source checkpoint/transcript, and it must never clear auth-scope
    blockers.

Done criteria:

- `auth_profile_session_expired` and `child_conversation_expired` are both
  available to route-health checks.
- Auth-scope failures block fresh child reuse across child boundaries until an
  auth transition or positive auth probe clears the failing credential scope.
  Healthy fallback selection allows only the route that explicitly selects that
  fallback credential.
- D3 can reference route-health events by stable event ids or deterministic event
  hashes.
- Unrecovered or failed-recovery `context_overflow` survives normal run-end
  cleanup and event retention until an explicit repair or successful accepted
  ordinary execution run proves reuse is safe.
- Successful completions are recorded separately from bad terminal outcomes.
- Route-health reads survive process restart and registry restore.
- Concurrent health writes from separate workers do not lose events or success
  markers.
- Health facts are actually fed by the listed runtime producers, not only by
  tests or manual helper calls.
- Route-health I/O failures do not silently degrade into unsafe child reuse.
- Retention pruning, active-blocker tombstones, and success-after-failure
  de-poisoning are deterministic and testable.
- The operator `queue.health` view may reuse this information, but routing does
  not depend on UI queue snapshots.

### D1. Child Route Health Assessment

Add a read-only helper that assesses whether a child target is safe to reuse.
This must cover registry-tracked children, stale or restored child records,
session-store lineage, and child-shaped keys that can still be addressed by
gateway or tool surfaces.

Expected output:

- `assessChildRouteHealth(childSessionKey, context)` helper.
- `context` is a typed route context, not a loose object. It includes route
  intent, which is one of `initial_spawn`, `followup_reuse`, `reactivation`,
  `a2a_step`, `completion_receipt`, `descendant_wake`, or `repair_control`;
  requester session key; target method; idempotency key when present; requester
  generation when present; target agent id when known; provider/model/auth-scope
  context when known, including provider id, model id, auth profile key,
  credential source, and unknown/default credential bucket; child target kind
  (`subagent` or `acp`) when known; registry record when available;
  session-lineage metadata when available; latest context-headroom telemetry when
  available; and provisional spawn context when route intent is `initial_spawn`.
- Closed result shape:
  - `{ status: "ok", codes: [] }`
  - `{ status: "unhealthy", codes, recommendedAction, plannerInstruction }`
  - `{ status: "unavailable", errorKind, retryable, plannerInstruction }`
- `recommendedAction` is one of `spawn_fresh`, `reauth`, `fallback_profile`, or
  `stop`.
- Missing tracked ownership for a child-shaped target fails closed. Session-store
  lineage can identify a child target and requester relationship, but it is not
  sufficient by itself to authorize delivery as tracked child work. The helper
  must not treat "not found in the active registry" as proof that the target is
  safe for generic delivery.
- Missing required route context for the selected route intent fails closed as
  `status: "unavailable"` or an equivalent typed route-health error.
- Initial child creation is the only exception to missing-registry fail-closed.
  It must be represented by an explicit internal spawn context or a durable
  provisional pending-spawn record that binds requester session key, child
  session key, target agent, run/idempotency key, child target kind, and spawn
  mode before any child session patch, runtime bootstrap, attachment
  materialization, thread binding, parent stream relay, or first gateway `agent`
  call. A normal external request cannot bypass the guard by claiming a
  child-shaped session key is fresh.
- Hard-block initial signals:
  - active `child_conversation_expired` from the D0 health history
  - active `auth_profile_session_expired` from the D0 health history
  - active, unrecovered, or failed-recovery `context_overflow` from the D0 health
    history
  - blocked, abandoned, or bad terminal lifecycle outcomes
  - repeated edit failures over threshold once structured counting exists
- Soft-only initial signals:
  - large JSONL file
  - high message count
  - long wait time
  - recent successful auto-compaction

Done criteria:

- The helper is read-only.
- Route-health storage failures produce `status: "unavailable"` or an equivalent
  typed error that D2 must propagate without falling through to normal delivery.
- Stale or untracked child-shaped session keys, including `subagent:*` and
  `acp:*` lineage keys, cannot bypass route-health checks by leaving the
  tracked-child path.
- Externally created or patched lineage, including `sessions.create`
  `parentSessionKey` and `sessions.patch` `spawnedBy` metadata, can make a target
  child-shaped but cannot satisfy trusted ownership without an active or restored
  registry record or pending-spawn record.
- New sub-agent spawn still works: the first child `agent` call is allowed only
  when it is tied to a trusted provisional spawn context or pending-spawn record
  that was written before other child session side effects.
- Large session size alone does not block reuse.
- Context-headroom alone does not replace route-health assessment. It is a
  preflight input: hard context blockers or failed compaction can reject
  substantial work, while nominal headroom cannot make a child healthy when
  lifecycle, tracking, auth, or route-health blockers are active.
- Health codes and recommended actions are closed and testable.
- `auth_profile_session_expired` never recommends `spawn_fresh` without a
  separate auth state transition or positive auth probe for the failing
  credential scope.
- Successful completed child runs remain eligible for the existing restart and
  reuse flows unless D0 still has an active bad health event for the child or
  credential scope.
- Successful overflow recovery alone is a soft signal, not a hard-blocking
  route-health event.
- Descendant wake is treated as a bounded continuation of already accepted child
  work, not as a new arbitrary follow-up. It requires a requester generation,
  original child run id, descendant-settle evidence, and no active auth-scope
  blocker for the execution profile.
- `repair_control` covers explicit cleanup and operator recovery flows and must
  not require a healthy child route. It may still validate ownership and target
  shape before allowing destructive control actions. Repair controls include
  `sessions.reset`, gateway `agent` `/new` and `/reset`, ACP bound-session reset,
  `sessions.delete`, `sessions.compact`, `sessions.compaction.restore`, and
  `sessions.compaction.branch`, and kill or abort controls.
- A repair request that also carries new tail work is treated as two phases. The
  repair transition is recorded first; the post-repair delivery is then assessed
  as a new generation or normal follow-up against current route health. No reset,
  restore, or compaction transition may clear an active
  `auth_profile_session_expired` auth-scope blocker.

### D2. Fail-Closed Routing Guard

Call the route-health helper before accepting follow-up work for a child target.

Expected surfaces and chokepoints:

- Gateway `agent` requests that resolve to a child target: guard after the
  canonical target key can be identified, but before attachment parsing or media
  offload, session-store updates, run-context registration, tool-event recipient
  registration, accepted ack, and reactivation.
- Gateway `agent` initial-spawn requests for newly created child sessions must be
  allowed only through the trusted provisional spawn path from D1. The
  provisional record must exist before `sessions.patch`, runtime bootstrap,
  attachment materialization, thread binding, or parent stream-relay setup. If
  that provisional spawn record/context is missing, malformed, expired, already
  consumed, or requester/key/run mismatched, the request fails closed before
  normal delivery side effects.
- `sessions_spawn` runtime paths must participate in pending-spawn state:
  `spawnSubagentDirect` and `spawnAcpDirect` write the provisional record before
  patching the child session or initializing the ACP/sub-agent runtime, and
  either promote it to a tracked accepted run or mark it failed/expired with
  cleanup attempted.
- Gateway `agent` requests carrying bounded sub-agent completion receipts, such
  as `sourceTool: "subagent_announce"` with `task_completion` internal events,
  are classified as `completion_receipt`, not ordinary follow-up reuse. They must
  not be rejected in a way that loses the child's terminal result. Before D5
  lands, the first guarded slice must preserve existing completion announce
  behavior; after D5, receipt persistence is the source of truth and any model
  wake of an unhealthy requester can be suppressed without losing the terminal
  receipt.
- Descendant-wake `agent` calls from sub-agent announce flow are classified as
  `descendant_wake`, not generic follow-up reuse. They must be tied to the
  original child run generation and descendant-settle evidence before
  `replaceSubagentRunAfterSteer` can mutate registry or task state.
- Gateway `chat.send` requests that resolve to a child target: guard before
  attachment parsing or media offload, message writes,
  accepted/dedupe-write ack, abort-controller registration, and queue insertion.
- Gateway `sessions.send` and `sessions.steer`: guard after key/session lookup
  and before `interruptSessionRunIfActive`.
- Sub-agent reactivation paths: guard before restart, reactivation, or
  delivered/accepted marking.
- Restart/orphan recovery paths, including `recoverOrphanedSubagentSessions` and
  synthetic resume `agent` calls, guard before starting the resume run, clearing
  restart-aborted flags, or replacing registry/task state. Healthy
  restart-aborted children continue to resume.
- `sessions_send` controlled-child follow-up path: guard before recording a
  delivery attempt as queued, delivered, or accepted.
- `sessions_send` stale or untracked child-shaped target path: guard before
  generic A2A fallback, fire-and-forget delivery, or pending announce state.
- ACP-backed child follow-up or focused-session delivery paths: guard before
  passing user input to the ACP runtime, binding-derived delivery, or any
  registry/task mutation that treats the ACP child as accepted work.
- `subagents(action="steer")`: guard after controlled-child ownership is
  resolved and before steer rate-limit mutation, `markSubagentRunForSteerRestart`,
  child abort, queue clearing, restart, or gateway `agent.wait`.
- Any A2A path that can target an existing planner-owned child: guard before
  enqueue, delivery, or accepted marking.
- The A2A `sessions_send` implementation that runs a step directly on a target
  session, including `runSessionsSendA2AFlow` and its `runAgentStep` call path,
  must guard before invoking the target session. Its ping-pong leg must also
  guard when the requester session is itself a child target, so replies cannot be
  injected into an unhealthy requester child under the cover of A2A response
  handling.
- Repair/control surfaces such as `sessions.reset`, gateway `agent` `/new` and
  `/reset`, ACP bound-session reset, `sessions.delete`, `sessions.compact`,
  `sessions.compaction.restore`, `sessions.compaction.branch`, kill, and abort
  are classified as `repair_control`. The guard must not block the cleanup
  operation merely because the child is unhealthy, but the operation must write
  the D0 repair transition before any post-repair tail message, continuation, or
  restored follow-up can be delivered.
- Gateway `sessions.patch` lineage fields alone are not a trusted spawn or
  ownership proof. They may help identify a child target, but only an internal
  spawn context, pending-spawn record, active registry record, or restored
  registry record can authorize delivery as tracked child work.
- `sessions.compaction.restore` must update route-health blocker state before
  accepting any follow-up delivery. It may clear a `context_overflow` blocker
  only when the restored checkpoint is known usable; restoring a pre-compaction
  or overflow-risk transcript keeps or rewrites the blocker.
- `sessions.compaction.branch` from a child target or unhealthy source transcript
  is a derived-session repair/control operation, not a fresh healthy child. It
  must record ancestry and inherited or rewritten route-health blockers before
  the branch can accept follow-up work.
- Gateway `sessions.create` requests that would create a child-shaped key, set
  child lineage such as `parentSessionKey` to a child target, or carry an
  `initialMessage` for a child-derived session must be assessed before
  session-store creation or initial-message delivery. Trusted sub-agent and ACP
  creation still goes through the pending-spawn path; external create/initial
  message flows cannot manufacture a fresh child bypass. If a create-only repair
  or derived-session operation is allowed, it must be recorded as such and must
  not mark child work accepted.
- Gateway `chat.inject` against a child target must be classified before
  appending to the transcript. Trusted internal receipt/control injection can use
  `completion_receipt` or `repair_control`; arbitrary transcript injection into a
  child target requires route-health approval before append, broadcast, or
  message id creation.

Expected behavior:

- Healthy child reuse continues unchanged.
- Unhealthy child reuse returns a structured route-health failure.
- The guard writes only the D3 rejected delivery attempt record. It does not
  mutate the child session, child registry entry, normal delivery state, or
  command queue.

Gateway error contract:

- `error.code`: use the existing gateway error-code surface, normally
  `UNAVAILABLE`.
- `error.message`: short human text only, not a branch target.
- `error.retryable`: `false` for retrying the same child request unchanged.
- Add an exported schema and TypeScript type for
  `ChildRouteUnhealthyDetails`. The gateway error, tool JSON result, and
  planner/tool adapters must all use that shared contract instead of duplicating
  ad hoc object literals.
- `error.details` must conform to `ChildRouteUnhealthyDetails`:

```json
{
  "kind": "child_route_unhealthy",
  "childSessionKey": "agent:implementer:subagent:...",
  "requesterSessionKey": "agent:planner:main",
  "deliveryAttemptId": "attempt_...",
  "codes": ["context_overflow"],
  "recommendedAction": "spawn_fresh",
  "stateTransitionRequired": false,
  "plannerInstruction": "Start a fresh child with a bounded handoff packet."
}
```

Tool JSON result contract:

```json
{
  "ok": false,
  "code": "child_session_unhealthy",
  "details": {
    "kind": "child_route_unhealthy",
    "deliveryAttemptId": "attempt_...",
    "codes": ["auth_profile_session_expired"],
    "recommendedAction": "reauth",
    "stateTransitionRequired": true,
    "plannerInstruction": "Re-authenticate the provider profile before retrying."
  }
}
```

Route-health store failure contract:

- If route-health assessment cannot read its required D0 state, return a
  structured retryable control-plane failure with
  `kind: "child_route_health_unavailable"` and do not enqueue or mutate child
  state.
- If the D3 rejected-attempt write fails after an unhealthy result is known,
  return a structured retryable control-plane failure with
  `kind: "child_rejected_attempt_unavailable"` and do not enqueue or mutate
  child state.
- Neither failure mode may fall through to normal delivery or be represented as
  healthy child reuse.

Done criteria:

- Unhealthy child work is not queued.
- Unhealthy child work is not marked delivered or accepted.
- Unhealthy child work is not accepted, deduped as accepted, or written into the
  session store.
- Unhealthy child work does not parse or offload attachments, register
  run-context/tool-event state, or otherwise allocate request side effects before
  rejection.
- Unhealthy child rejection cannot start a run and then rely on later
  reactivation cleanup.
- The planner receives deterministic structured data it can branch on without
  parsing messages.
- The planner can also branch on route-health store failures without parsing
  messages.
- Stale or untracked child-shaped keys fail closed across gateway, tool,
  reactivation, steer, ACP, and A2A surfaces.
- Initial spawn and follow-up reuse are separated by type or record state, so the
  route guard cannot either break normal child creation or let arbitrary
  child-shaped keys bypass as "fresh".
- Pending-spawn records cannot leak: failed or abandoned pending spawns expire,
  failed cleanup is recorded, and a later ordinary request cannot reuse the
  pending-spawn allowance.
- Completion receipt delivery is separated from task delivery, so route-health
  rejection cannot erase child terminal results or falsely mark them as accepted
  follow-up work.
- Descendant-wake delivery is separated from both completion receipt and ordinary
  follow-up work, so it cannot accidentally restart an unrelated or unhealthy
  child generation.
- A2A direct-step delivery cannot bypass the guard by avoiding gateway `agent` or
  `chat.send`.
- Reset/new requests with tail work cannot bypass route health: the repair
  transition is recorded first, then the post-reset delivery is assessed against
  current child and auth-scope health.
- Session reset, compaction, checkpoint restore, and delete controls can clear or
  rewrite child-local blockers only through explicit D0 transition records. They
  cannot clear active auth-scope blockers.
- `queue.health` remains visibility-only and does not make routing decisions.

### D3. Rejected Delivery Attempt Ledger

Add a separate record for unhealthy delivery attempts that were rejected before
normal delivery state could mutate.

Expected output:

- A durable rejected-attempt ledger in the same sub-agent control-plane state
  family, backed by `OPENCLAW_STATE_DIR/subagents/delivery-attempts.json` or the
  same versioned file as D0 if the implementation keeps schemas clearly
  separated.
- Attempt records keyed by `deliveryAttemptId`, requester generation, route
  intent, target method, child target kind, child session key, idempotency key
  when present, and the route-health evidence epoch that caused rejection.
- D3 includes the minimal requester generation source needed for rejected-attempt
  idempotency in the first guarded slice. Do not defer that generation fence to
  D5; D5 expands the invariant to accepted child receipts and auto-reroute.
- `deliveryAttemptId` is generated once per attempted delivery and must be stable
  across a repeated request with the same idempotency key, requester generation,
  route intent, target child, and route-health evidence epoch.
- Dedupe lookup is allowed only to return an already-terminal result for the same
  idempotency key and the same route-health evidence epoch. It must not create or
  overwrite an accepted dedupe entry before route health passes. A request that
  was already accepted before a later health event remains that original accepted
  attempt; a new request after the health event must reject. After a valid
  clearing transition changes the health epoch, retrying the same idempotency key
  must be re-assessed instead of permanently returning the stale rejection.
- When no idempotency key is present, retries are deduped by a deterministic
  fingerprint of requester session key, requester generation, target child
  session key, route intent, child target kind, normalized target method,
  normalized route payload hash, and the stable route-health event ids or
  deterministic event hashes that caused rejection.
- Terminal state `rejected_unhealthy` with route-health codes,
  `recommendedAction`, timestamp, requester session key, target child session
  key, route intent, child target kind, health evidence epoch, and sanitized
  planner instruction.
- The rejected-attempt ledger stores hashes, closed codes, ids, timestamps, and
  sanitized instruction text only. It must not store raw prompts, raw
  transcripts, attachment contents, environment values, provider credentials, or
  auth material.
- Strict idempotency: repeating the same rejected request returns the same
  terminal attempt record and does not append duplicates.
- No child mutation: writing this ledger must not update the child session
  store, sub-agent run registry, normal queued/delivered/accepted state, abort
  state, or restart state.
- Ledger writes use the same cross-process concurrency guarantee as D0; atomic
  JSON replacement without locking, append semantics, or merge protection is not
  sufficient.

Done criteria:

- D2 can both reject before normal side effects and still expose a terminal
  result to the requester.
- Rejected unhealthy attempts are visible for audit and planner/tool responses.
- A rejected attempt cannot be mistaken for accepted child work.
- Rejected-attempt records are safe to inspect and do not leak raw task text,
  transcript text, attachment contents, secrets, or auth material.
- Repeated rejected attempts are deduped deterministically with or without an
  explicit idempotency key.
- Concurrent rejected-attempt writes do not lose records.
- Late old-child completions cannot satisfy a rejected attempt id.

### D4. Planner Handoff Packet Contract

Define the bounded context packet used when the planner starts a replacement
child.

Planner-authored semantic section:

- original task and desired outcome
- acceptance criteria
- constraints from applicable repo or workspace instructions
- relevant investigation findings
- files, commands, or logs already inspected
- current next step
- explicit non-goals

Runtime-attached factual envelope:

- requester session key
- requester run id or generation token
- original child session key
- old child run id when known
- health rejection codes
- recommended route action
- delivery attempt id
- old route state: queued, delivered, accepted, running, terminal, or rejected
- target agent id when known
- provider id, model id, model override source, auth profile key, auth profile
  source, credential source or unknown/default credential bucket,
  fallback-profile decision, fallback provider/model decision, and thinking
  override when known
- session execution controls when known: fast mode, reasoning level, verbosity,
  trace level, elevated level, tool/exec host, exec security, exec ask policy,
  exec node, TTS mode, and response-usage mode
- child control semantics when known: child target kind, sub-agent role, control
  scope, spawn depth, and spawned workspace
- ACP runtime semantics when known: backend, agent id, runtime session mode,
  runtime mode, runtime model, runtime working directory, permission profile,
  per-turn timeout, and replay-safe backend option entries. Secret-like,
  credential-like, or environment-derived values must be redacted and marked
  unreplayable unless the replacement child can resolve them through the normal
  runtime secret/config path.
- workspace directory
- run timeout
- spawn mode
- cleanup policy
- requester origin and display key
- original label or feature label
- attachment roots, retained attachment policy, and attachment references
- timestamp and idempotency key

Packet assembly owner:

- The planner supplies the semantic handoff section when it decides to continue
  work after a structured rejection.
- The orchestrator or retry controller assembles the final packet by merging the
  planner-authored semantic section with the runtime factual envelope from D0/D3
  and the current session/run sources.
- Runtime code validates, redacts, truncates, and records packet metadata. It
  must not trust planner prose for factual fields such as run ids, health codes,
  auth scope, attachment availability, or generation tokens.

Bounds and truncation:

- Maximum serialized UTF-8 packet size is 32 KiB.
- Planner-authored semantic content is capped at 24 KiB or roughly 4000 tokens,
  whichever limit is reached first.
- Runtime factual envelope is capped at 8 KiB.
- Include at most 30 file references, 20 findings, 20 inspected commands, and
  10 log excerpts.
- Each command or log excerpt is capped at 2 KiB, with an 8 KiB aggregate cap
  for all command and log excerpts.
- Attachment contents are not embedded. Include only sanitized references,
  roots, media type, size when known, and retained-attachment policy.
- Attachment references must include availability status. If an attachment root
  was already cleaned up or is not readable by the replacement child, the packet
  records a missing-reference fact and the reroute either stops for planner
  repair or continues with an explicit degraded-context flag; it must not silently
  pretend the fresh child has the same inputs.
- Relevant repo/workspace instructions are summarized as exact constraints with
  source references. Do not paste full instruction files unless they fit within
  the semantic budget and are necessary for correctness.
- Preserve original task, acceptance criteria, constraints, current next step,
  health codes, and recommended action first. Drop oldest or least relevant
  findings, commands, and logs first.
- When truncation occurs, set `truncated: true` and include dropped-item counts.
- Redact secrets, tokens, raw auth material, and environment values before
  writing the packet.

Done criteria:

- The packet is bounded and does not include the full raw old transcript.
- The planner can produce the semantic section without asking the unhealthy
  child to do one last summarization task.
- Runtime metadata is attached by code, not trusted from planner prose.
- If the existing sub-agent registry does not persist a required execution
  semantic such as provider id, auth profile key, credential source, fallback
  state, active fallback model/provider, thinking level, execution policy,
  sub-agent role/control scope, or ACP runtime option, the implementation must
  either load it from the canonical session/run source or extend the registry
  before relying on D4 packets for equivalent fresh execution.
- Attachment availability, missing-reference handling, and degraded-context flags
  are deterministic and testable.
- Truncation and redaction behavior are deterministic and testable.

### D5. Terminal Receipt And Generation Invariants

Before auto-reroute, make completion ownership unambiguous.

Expected output:

- Requester-run generation token on child delivery attempts.
- Durable terminal receipt for accepted child work.
- Distinct states for queued, delivered, accepted, running, terminal, and
  rejected.
- Late old-child completions cannot wake or complete a newer replacement task.
- Cancellation produces a terminal outcome visible to the requester.
- Unhealthy rejection uses the D3 rejected-attempt ledger, not accepted child
  receipt state.
- Completion receipt persistence is independent from whether the requester
  session is healthy enough for an immediate model wake.
- Descendant wake continuations use the same requester-run generation fence as
  accepted child work. A wake from an old child generation cannot replace a newer
  child run or satisfy a newer replacement task.

Done criteria:

- Accepted child work always has a terminal success, failure, or cancellation
  receipt.
- Rejected unhealthy reuse has a terminal rejected-attempt record without being
  represented as accepted child work.
- Child completion receipts are durable even when the requester session is
  unhealthy and the runtime suppresses or defers the requester wake.
- A late completion from the old child is ignored or attached only to the old
  generation.
- A late descendant wake from the old child is ignored or attached only to the old
  generation.
- There is no success path where no tracked completion can arrive.

### D6. Auth And Session Expiry Hardening

Improve handling for upstream `openai-codex` session expiry before auto-reroute
ships.

Expected output:

- Clear classification of raw upstream `session_expired` into either
  `auth_profile_session_expired` or `child_conversation_expired`.
- Source-evidence rules for that classification:
  - Provider login, OAuth, credential, account, token, or profile-invalid
    evidence maps to `auth_profile_session_expired`.
  - Conversation id, CLI session id, thread id, HTTP 404/410
    conversation-not-found, and no-conversation-found evidence maps to
    `child_conversation_expired`.
  - Ambiguous raw `session_expired` without source evidence maps to `stop`, not
    `spawn_fresh`, until a caller supplies enough provider/session context.
  - Auth expiry with provider evidence but no profile id maps to the provider's
    stable credential source when known, otherwise the provider-scoped
    `unknown/default` credential bucket. It must not be dropped because the
    precise auth profile key is missing.
  - Explicit billing, quota, model-not-found, and context-overflow signals keep
    their existing classifications and must not be collapsed into either expiry
    code.
- `auth_profile_session_expired` is treated as an auth/session issue, not a
  queue backlog and not a fresh-child-only problem.
- Cooldown, credential-scope, and fallback behavior visible in D0 route health
  and operator runtime health.
- Operator guidance for re-authentication and provider fallback.
- Avoid retrying long work on the same expired auth profile or credential source
  without a useful state transition.

Done criteria:

- Session-expired failures are visible to the planner, D0 health history, and
  operator UI as normalized closed codes.
- Tests cover representative HTTP 404/410 conversation-not-found cases,
  provider auth/profile expiry cases, provider-scoped unknown/default credential
  expiry cases, and ambiguous `session_expired` cases.
- Long-running work can fail cleanly, require reauth, or fall back according to
  configured profiles.
- The error message includes one clear next action.
- Auto-reroute never spawns a fresh child solely for
  `auth_profile_session_expired`.

### D7. Fresh Child Auto-Reroute

After D0 through D6, add optional automatic fresh-child creation for route-health
failures whose recommended action is `spawn_fresh`.

Expected behavior:

- On a structured route-health result with `recommendedAction: "spawn_fresh"`,
  the planner or orchestrator creates a fresh tracked child.
- Before assigning any non-trivial new task to a pinned per-slice child, the
  planner or orchestrator performs an assignment preflight. The preflight reads
  structured route-health, tracked-run generation, latest lifecycle outcome, and
  runtime-maintained context-headroom telemetry; it does not ask the possibly
  unhealthy child to self-assess and does not reconstruct the full child prompt
  from raw transcript bytes. A healthy small clarification may still reuse the
  pinned child, but implementation, testing, or review work must not be assigned
  to a child with active hard blockers, no-final/degraded lifecycle state, failed
  compaction/recovery, missing/unavailable headroom telemetry when policy
  requires it, or context headroom below the configured hard threshold.
- Per-slice pinning preserves the role and feature continuity, not the old raw
  model transcript. When preflight or route-health says the pinned child needs
  replacement, the reroute must either spawn a fresh tracked child for the same
  role or rotate to a fresh underlying session/run generation for that role. A
  restart path must not pass the old bloated `sessionId` into the replacement
  run after the old session was rejected, aborted, or marked unhealthy.
- If a planner attempts to reuse a stale or untracked child-shaped session and
  receives `child_session_unhealthy` or `child_route_health_unavailable`, it must
  not retry the same `sessions_send` with a short bounded timeout, default
  timeout, or any other value that can fall through to generic A2A announce
  delivery. A retry against the same stale child is allowed only after a valid D0
  clearing transition changes the route-health evidence epoch and D1 reports the
  route healthy.
- When the stale/untracked rejection recommends `spawn_fresh`, the continuation
  path is a new tracked child spawn with a D4 handoff packet. The parent must then
  wait on the fresh child's tracked completion receipt/generation, not on an
  announce-mode result from the old child.
- Reusing the same implementer/tester/reviewer role is allowed only by spawning a
  fresh child session for that role. The reroute must preserve the semantic work
  assignment and role choice while changing the child session/run generation.
- The fresh child receives the handoff packet from D4.
- The old child is not asked to summarize at failure time.
- Auto-reroute has per-parent cooldown and dedupe by task or feature label.
- Repeated reroute failures stop with a clear terminal error instead of spawning
  indefinitely.
- Bounded synchronous waits are not a fallback around route-health rejection.
  `timeoutSeconds: 0`, short positive timeouts such as `1`, and default timeouts
  must all produce the same no-delivery result for a stale/untracked child-shaped
  target until D7 deliberately starts a fresh tracked child.
- Results with `recommendedAction: "reauth"`, `fallback_profile`, or `stop` do
  not spawn fresh children on the same expired state.
- Before spawning, the reroute path checks the provider/auth-scope health index
  from D0. `spawn_fresh` is invalid when the target provider credential scope has
  an active `auth_profile_session_expired` blocker.
- Before spawning, the reroute path verifies D4 attachment references. Missing
  required attachments stop reroute unless the planner explicitly marks the
  handoff as degraded and acceptance criteria still make sense.

Done criteria:

- Fresh child starts with enough context to continue the task correctly.
- Assignment preflight is mandatory before planner/orchestrator task handoff to
  an existing pinned child. Tests cover healthy reuse, context-headroom warning
  that remains reuseable for small clarification, and hard-blocking context or
  lifecycle states that force fresh generation before work is assigned.
- Assignment preflight uses the runtime's latest context-headroom telemetry from
  the actual request path or a bounded preflight estimate. It must not read or
  rebuild the full transcript on every handoff, and telemetry read failures are
  surfaced as typed unavailable/blocked results for substantial work rather than
  ignored.
- A replacement for a pinned child receives a new child session/run generation or
  a new underlying `sessionId`; it never continues substantial work on the old
  unhealthy or bloated model session. The same implementer/tester/reviewer role
  may be preserved only as semantic role continuity, not as transcript reuse.
- A planner cannot escape a stale/untracked child rejection by changing
  `timeoutSeconds` or using another generic `sessions_send`/A2A path. The old
  child is neither queued nor marked pending announce, and the parent is not left
  waiting for a tracked completion that cannot arrive.
- The reroute result exposed to the planner clearly distinguishes:
  `rejected_old_child`, `fresh_child_spawned`, and `fresh_child_completion`.
  Planner status text must not claim it is waiting on the old child after the
  reroute decision.
- Fresh child either receives all required attachments by reference or receives a
  visible degraded-context handoff that the planner can reason about.
- Fresh child does not inherit the old child's bloated raw transcript.
- Old child completions cannot satisfy the new child generation.
- Auth-scope expiry is handled by D6 state transitions before any fresh-child
  retry on that same credential scope is considered.
- Fresh-child creation cannot cross from a child-local blocker into an auth-scope
  blocker without changing the recommended action to `reauth`,
  `fallback_profile`, or `stop`.
- Selecting a fallback credential for reroute does not clear the expired original
  credential; later work targeting the original profile/source still rejects
  until an auth transition or positive probe clears it.
- If the old child completes after rejection or after a fresh child is spawned,
  that completion is attached only to the old child generation. It cannot satisfy
  the fresh child task and cannot wake the parent as if the original tracked
  delivery had succeeded.

### D8. Edit Failure Signal

Turn repeated mechanical edit failures into a bounded health signal.

Expected output:

- Count repeated edit failures such as non-unique `oldText` matches.
- Expose thresholded edit failure health as a degraded or unhealthy signal.
- Keep a single edit failure as normal recoverable tool feedback.
- Define the counting window and clearing rules. The initial signal should be
  scoped by child session, run id, file path when known, and edit tool kind; it
  should decay by time or clear after a successful ordinary edit/execution run,
  explicit reset, or replacement. It must not permanently poison a child because
  of an old isolated patch mistake.

Done criteria:

- Repeated edit failure over threshold can contribute to route-health rejection.
- The threshold avoids blocking a child for one ordinary patch mistake.
- The planner receives guidance to inspect surrounding context and use unique
  edit anchors.
- Tests cover threshold crossing, decay/clearing, and the distinction between an
  old isolated edit miss and an active repeated mechanical failure.

### D9. Validation And Review

Keep implementation, testing, and adversarial review separate.

Implementation phase:

- Implement the D6 expiry-normalization contract, then D0, D1, D3, and D2 first.
  The broader D6 operator/fallback hardening can continue after the first guard
  slice, but D0/D2 must not land without closed-code classification for
  provider/auth expiry, child-conversation expiry, and ambiguous
  `session_expired`.
- Do not include test execution in the initial implementation command.

Tester phase:

- Run targeted tests with commands explicitly framed as `ROLE: TESTER`.
- Cover healthy reuse, unhealthy rejection before enqueue, no registry mutation,
  large-session soft signal, and `queue.health` remaining visibility-only.
- Cover pre-side-effect rejection for `agent`, `chat.send`, `sessions.send`,
  `sessions.steer`, `sessions_send`, `subagents(action="steer")`, A2A, and
  reactivation paths.
- Cover restart/orphan recovery, including the synthetic resume `agent` call and
  the no-mutation path when the target is unhealthy.
- Assert unhealthy rejection happens before session-store writes, accepted/dedupe
  ack, abort-controller registration, queue insertion, registry replacement,
  child abort, child restart, reactivation, task-registry reassignment,
  attachment/media offload, run-context registration, tool-event recipient
  registration, and steer rate-limit mutation.
- Cover D3's first-slice requester generation fence independently of D5's later
  accepted-receipt generation work.
- Cover D0 process restart, registry restore, retention pruning, and
  success-after-failure de-poisoning.
- Cover that only successful ordinary target execution can de-poison child-local
  blockers; completion receipts, descendant wakes, repair controls, and
  transcript injection do not count as proof that a bloated child can safely take
  new work.
- Cover retention cap pressure where active hard-blocking events must be
  preserved while non-blocking or expired records are pruned.
- Cover retention pruning where detailed events expire but active auth,
  child-conversation, or unrepaired context-overflow blocker tombstones continue
  to reject reuse until a valid clearing transition is recorded.
- Cover auth-scope health blocking fresh child creation across child boundaries.
- Cover unknown/default provider credential blockers when auth expiry lacks a
  precise profile id, including fallback selection that permits only the selected
  fallback route and does not clear the original blocker.
- Cover D1 `status: "unavailable"` or typed route-health read failure and D2
  propagation of that result.
- Cover auth-scope expiry separately from child-conversation expiry.
- Cover D3 idempotency and the absence of child mutation when writing rejected
  attempts.
- Cover rejected-attempt idempotency across health epochs: repeating the same
  request under the same blocker returns the same rejection, while a valid
  clearing transition causes the same idempotency key to be re-assessed instead
  of returning a stale rejection forever.
- Cover concurrent D0 and D3 writes so route-health events and rejected attempts
  are not lost under multi-worker access.
- Cover D0/D2 behavior when route-health reads fail, health-event writes fail,
  and rejected-attempt writes fail.
- Cover structured gateway `error.details` and tool JSON result shapes.
- Cover the exported `ChildRouteUnhealthyDetails` schema/type so gateway and tool
  adapters cannot drift.
- Cover D6 source-evidence classification for provider auth expiry,
  child-conversation expiry, and ambiguous raw `session_expired`.
- Cover D2 rejection for stale or untracked child-shaped keys across gateway,
  tool, reactivation, steer, and A2A surfaces.
- Cover the exact stale-child timeout escape: `sessions_send` to an untracked
  child-shaped key with `timeoutSeconds: 0`, a short positive timeout such as
  `1`, and the default timeout all reject before generic A2A announce delivery.
  Assert no result reports `delivery: { status: "pending", mode: "announce" }`
  and no parent can wait for a tracked completion on that stale child.
- Cover D2 rejection for ACP-backed child keys and registry-tracked ACP child
  records across gateway, tool, focus/binding delivery, reactivation, steer, and
  A2A-like surfaces.
- Cover normal initial sub-agent and ACP child spawn through the trusted
  provisional spawn path, plus rejection when the first child `agent` call or
  runtime bootstrap lacks that provisional record/context, has a requester/key/run
  mismatch, reuses a consumed record, or races an expired pending-spawn record.
- Cover failed or abandoned pending-spawn cleanup: the record expires, cleanup
  status is auditable, and later ordinary delivery cannot consume the stale
  pending-spawn allowance.
- Cover sub-agent completion announce and descendant-wake paths so bounded
  `task_completion` receipts are not rejected as ordinary follow-up reuse and
  cannot be lost when the requester session is unhealthy.
- Cover the A2A direct-step path, including `runSessionsSendA2AFlow` and
  `runAgentStep`, so it cannot bypass route health. Include both the target step
  and ping-pong requester-reply leg when either session is a child target.
- Cover D4 packet byte bounds, truncation ordering, redaction, provider/auth
  profile fields, credential source, unknown/default credential bucket, thinking
  override, fallback-profile decision fields, fallback provider/model decision
  fields, execution policy, sub-agent role/control scope, ACP runtime options,
  attachment availability, missing-attachment degraded-context handling, and
  stale attachment cleanup.
- Cover repair controls for unhealthy children: `sessions.reset`, gateway
  `agent` `/new` and `/reset`, ACP bound-session reset, `sessions.delete`,
  `sessions.compact`, `sessions.compaction.restore`,
  `sessions.compaction.branch`, kill, and abort remain available without
  accepting new work.
- Cover reset/new requests with tail work: the repair transition is recorded
  first, the post-reset delivery is separately route-checked, and an active
  auth-scope blocker still stops the post-reset run.
- Cover `sessions.create` and `sessions.patch` spoofing: externally created or
  patched lineage fields can identify a child-shaped target but cannot satisfy
  the trusted pending-spawn or registry ownership requirement for delivery.
- Cover `sessions.create` with `initialMessage` for child-shaped or
  child-derived targets: rejection or pending-spawn validation happens before
  session-store creation, initial `chat.send`, accepted/dedupe writes, or the
  created session is rolled back without accepted work.
- Cover `chat.inject` against child targets: arbitrary injection is guarded
  before transcript append/broadcast, while trusted receipt/control injection is
  classified as `completion_receipt` or `repair_control`.
- Cover compaction checkpoint restore behavior: restored usable checkpoints can
  clear child-local context blockers through D0 transition records, while
  pre-compaction or overflow-risk checkpoints keep or rewrite the blocker before
  any follow-up is accepted.
- Cover compaction branch behavior: a branch from an unhealthy child or risky
  checkpoint inherits or rewrites child-local blockers and cannot become a fresh
  healthy route by dropping child ancestry.
- Cover D7 planner/orchestrator behavior after stale-child rejection: the parent
  spawns a fresh tracked child for the same role with a D4 handoff packet, waits
  on the fresh child's tracked completion receipt/generation, and ignores or
  old-generation-attaches any later completion from the stale child.
- Cover D7 assignment preflight before per-slice pinned-child reuse: a healthy
  tracked child can receive a small clarification, but implementation/testing/
  review work is rerouted when context headroom is hard-blocked, compaction or
  recovery failed, the previous task produced no final report, or route-health
  has an active hard blocker.
- Cover context-headroom telemetry production and consumption: the model-request
  assembly path records scalar prompt/context estimates, D1/D7 consume those
  snapshots without transcript reconstruction, and unavailable telemetry fails
  closed for substantial work when policy requires a headroom decision.
- Cover D7 replacement generation for pinned roles: reroute preserves the role
  label/semantic assignment while changing child generation or underlying
  `sessionId`, and substantial work is never started with the old unhealthy or
  bloated `sessionId`.
- Cover D7 non-reroute actions: `reauth`, `fallback_profile`, and `stop` do not
  spawn a fresh child on the same expired auth/profile state, and the planner
  receives the next required state transition instead of retrying generic
  `sessions_send`.

Adversarial review phase:

- Review false positives, late completion handling, duplicate fresh spawns,
  receipt gaps, stale generation wakeups, auth expiry action semantics, and
  rejected-attempt idempotency.
- Do not let the same agent that implemented the slice be the only reviewer.

Done criteria:

- D6a, D0, D1, D3, and D2 land only with targeted tests.
- D4 through D7 do not start until rejected-attempt, receipt, generation, and
  auth-action risks are reviewed.
- Review findings are either fixed or explicitly deferred.

### D10. Operator Runbook

Document how to diagnose and operate the behavior.

Expected output:

- Short runbook entry covering:
  - Docker logs that indicate context overflow, session expiry, and child reuse
  - how to distinguish queue backlog from runtime child failure
  - when to re-auth `openai-codex`
  - when to use a fallback profile
  - when to spawn a fresh child manually
  - why `queue.health` is visibility-only

Done criteria:

- Operators can explain why a child was rejected.
- Operators can recover manually before auto-reroute ships.
- The runbook does not expose raw prompt, transcript, tool payload, or secret
  text.

## Suggested Sequence

1. D6a: closed-code expiry normalization and credential-scope classification for
   raw `session_expired` evidence.
2. D0: route-safe health history with the chosen storage owner.
3. D1: route-health helper against the D0 health source.
4. D3: rejected delivery attempt ledger.
5. D2: fail-closed routing guard integrated with D3.
6. D9: targeted tester pass for D6a, D0, D1, D3, and D2.
7. D9: adversarial review of D6a, D0, D1, D3, and D2.
8. D6b: remaining auth/session operator guidance, cooldown, and fallback
   hardening.
9. D4: handoff packet contract.
10. D5: terminal receipt and generation invariants.
11. D7: fresh-child auto-reroute for `spawn_fresh` only.
12. D8: edit failure signal, either after D1 or as a separate follow-up slice.
13. D10: operator runbook.

## Non-Goals For The First Slice

- Do not auto-spawn a new child yet.
- Do not copy full raw transcripts into a fresh child.
- Do not make `queue.health` responsible for routing.
- Do not use queue delay as a holding pattern for unhealthy children.
- Do not ask an unhealthy child to summarize itself at failure time.
- Do not retry the same expired auth profile or credential source without a state
  transition.

## Open Questions

- Should the initial 30-minute recent window become configurable?
- Are the D4 32 KiB total, 24 KiB semantic, and 8 KiB runtime-envelope limits
  the right defaults?
- Should repeated edit failures start as degraded-only before becoming a hard
  block?
