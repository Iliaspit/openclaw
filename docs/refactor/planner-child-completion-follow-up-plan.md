# Planner Child Completion Follow-up Plan

## Status

Active follow-up plan created on 2026-07-05.

This plan starts after `docs/refactor/unhealthy-child-handoff-plan.md` was
closed for active execution and after thread
`019f321d-127c-7162-b114-860b56eb1358` completed the rebuild, child guardrail,
and shared-auth inheritance work.

Work from this plan must land one change at a time. Do not combine child result
finalization, slice-budget guardrails, runtime diagnostics, context telemetry,
early helper context protection, and child compaction controls in one patch.

Current implementation slice: **none active**. Change 2A, Change 2B, Change 3A,
Change 3B, and the E2E gate-placement guardrail were implemented as separate
slices and should not be extended without opening a new written slice first.

Next recommended implementation slice: Change 4, Context High-water Telemetry.

Latest investigation input:

- Thread `019f3b7b-c9a7-7713-908d-cca779220e98` reviewed the Planner 2
  Contract V2 runaway chain again on 2026-07-07.
- Reviewer-corrected evidence was worse than the first estimate: 58 child
  sessions, 12.77 hours of child runtime, 12 timeouts, 23 child-route failures,
  30 announce retries, 59 background-task failures, and 61 no-reply lines.
- The old Planner 2 chain should not be resumed. The Contract V2 recovery should
  be a fresh narrow task starting from CP-PW-12/text-containment failure,
  partial dirty state, and failed `test-results/.last-run.json`.

Completed slices:

- **1A Child Failure Terminalization:** failed child attempts now persist
  terminal timing/status even when best-effort telemetry fails, unexpected
  `agent.wait` errors terminalize the child run, and terminal old rows no longer
  reserve retry labels.
- **1B Visible Final Answer Required For Child Success:** completion-message
  child success now requires a visible assistant final reply. Raw tool output,
  timeout partial progress, and no-visible-reply completions cannot create a
  successful child result receipt.
- **2A Persistent Timeout And Route-health Budgets:** planner-controlled
  `sessions_spawn` work now records scalar slice budgets, blocks a same-slice
  third spawn after two timeout outcomes, and escalates repeated
  `child_route_health_unavailable` preflight failures into a route/system
  blocker before a child run starts.
- **2B Full-gate Slice Boundary Semantics:** planner-controlled `sessions_spawn`
  work can now mark a successful `sliceRole: "full_gate"` child as the scalar
  green gate for a slice, and later `sliceRole: "review"` or `sliceRole: "qa"`
  work defaults to a bounded post-green follow-up slice unless explicitly
  continued with `sliceContinuation: "same"`.
- **3A Spawn Acceptance Requires Background Task Registration:** native
  subagent run registration now creates the detached/background task before
  tracking the run as accepted. If task creation throws, `sessions_spawn` uses
  the existing rollback/error path instead of returning a normal accepted child.
- **3B Stale Runtime Diagnostics And Announce Retry Caps:** diagnostic
  heartbeat/stuck-session reporting now reconciles stale `processing` state
  against runtime queue, active-run, and durable session facts before surfacing
  it. Direct announce delivery caps repeated long gateway-timeout waits while
  preserving quick transient retries, and queued announce drains stop after
  bounded retry backoff with scalar-only diagnostics.
- **E2E Gate-placement Guardrail:** planner-facing orchestration guidance and
  `sessions_spawn` slice-role descriptions now say that QA children should run
  manual/behavioral checks plus the smallest relevant smoke command, while the
  full E2E suite belongs only to an explicit `sliceRole: "full_gate"` final-gate
  child. Native subagent and ACP children also receive child-visible slice-role
  notices in their initial task context. A failing full gate must report the
  first failing spec, test id, and artifact, then stop so the planner can open a
  fresh narrow recovery slice.

## Recently Completed Elsewhere

- Rebuilt `openclaw:local` explicitly with Docker and recreated the gateway.
- Verified the rebuilt gateway with `/healthz`, `/readyz`, and a live Planner 3
  delegation smoke.
- Added post-run child guardrails for context overflow and excessive child
  tool-call loops.
- Refreshed `SessionEntry.totalTokens` from prompt-token-only runs so child
  context guardrails can see prompt pressure.
- Added shared OAuth inheritance so helper/planner lanes can prefer fresher
  usable main-agent credentials over stale same-profile child credentials.

## Completed Change 1: Child Failure Terminalization And Result Finalization

Problem:

A child can be treated as successfully completed when the parent only receives a
tool/result excerpt, incomplete receipt, or no visible final assistant answer.
This can make a planner trust partial evidence as a real child report. A failed
child attempt can also leave a durable session row stuck in `running`, which can
make the UI show stale context pressure and block same-label retry metadata.

Objective:

Subagent and tracked child success must require a visible final assistant
response. Tool-output-only completion, no-visible-reply completion, and
abandoned lifecycle outcomes must not produce a successful child result receipt.
Failed child attempts must terminalize their session rows before cleanup or
best-effort telemetry can fail.

Scope:

- Audit child completion and result receipt capture paths.
- Persist failed, timed-out, and killed child session terminal status promptly
  when `agent.wait` or lifecycle completion observes a terminal child outcome.
- Do not let a terminal stale child session row reserve a retry label forever.
- Require visible final assistant text before marking accepted child work as
  successful.
- Mark no-visible-reply child outcomes as abandoned or failed with structured
  lifecycle evidence.
- Preserve successful delivery for children that do produce a real final answer.
- Ensure parent recovery paths receive failure/abandoned state and can spawn a
  clean recovery child when appropriate.

Non-goals:

- Do not add context high-water UI or session-list telemetry in this change.
- Do not add proactive helper compaction in this change.
- Do not add planner-safe child compaction controls in this change.
- Do not broaden leaf helper tool permissions.

Validation:

- Added a regression test where strict completion capture ignores raw tool
  output when no visible assistant reply exists.
- Added a regression test where a completion-message child with no visible final
  reply is downgraded to a failed child outcome, clears result receipts, fails
  task finalization, and records route-health error state.
- Added a regression test where a child emits a normal final answer and still
  produces a successful receipt.
- Kept timeout partial-progress announcements inline instead of wrapping them in
  "full result" receipts.

Done:

- The child success contract is explicit in code and tests.
- Existing valid child completion flows still pass.
- A tool-output-only child cannot create a successful receipt.

## Completed Change 2A: Persistent Timeout And Route-health Budgets

Problem:

Planner 2 kept the same Contract V2 recovery chain alive after repeated child
timeouts, route failures, green E2E gates, reviewer or QA reopenings, and failed
child finalization. The child success contract now prevents false success, but
the planner still needs persistent stop conditions so it does not respond to
every poisoned child by spawning another broad recovery child.

Objective:

Add persistent, slice-keyed orchestration budgets for the two proven runaway
signals from the Planner 2 chain: repeated same-slice child timeouts and
repeated route-health unavailable preflight failures.

Scope:

- Define a stable slice identity for planner-controlled work. It should include
  the parent planner session, task or slice label when known, and run generation
  metadata so budget counters survive compaction without merging unrelated work.
- Track child spawn count, child timeout count, terminal evidence gaps, repeated
  `child_route_health_unavailable`, and placeholder full-gate scalar fields
  without storing prompts, tool payloads, or child transcript bodies.
- Stop after two same-slice child timeouts unless the user explicitly extends
  the slice. The stop output must include the failed child ids, last trusted
  evidence, dirty-state warning when known, and next focused recovery command or
  target.
- Escalate repeated `child_route_health_unavailable` into a route or system
  health blocker instead of spawning broad replacement children indefinitely.
- Make no-final, timeout, duplicate, or poisoned child completion states terminal
  evidence gaps. They may justify a focused recovery once, but they must not
  automatically authorize another broad recovery loop.
- Store enough scalar budget evidence for UI and incident triage without
  storing prompts, tool payloads, or child transcript bodies.

Non-goals:

- Do not implement the Contract V2 application recovery in this OpenClaw plan.
- Do not loosen the Change 1 visible-final-answer requirement.
- Do not make route-health state depend on `queue.health` UI snapshots.
- Do not add context high-water telemetry or child compaction controls in this
  change.

Validation:

- Add tests for a planner slice blocking after the second same-slice child
  timeout, including persistence at the registry store boundary.
- Add tests for repeated `child_route_health_unavailable` escalating to a route
  blocker instead of accepting another replacement child.
- Add tests that no-final or timeout child outcomes do not create successful
  receipts and do not reset budget counters.

Done:

- Planner-controlled work has durable budget counters keyed to a slice.
- The T21/T22/T23 style repeated-timeout chain would block instead of spawning
  more recovery children.
- A blocked slice report contains enough focused evidence for a human or fresh
  agent to continue without replaying the entire old chain.

Residuals intentionally split out:

- Wall-clock and child-count hard stops are not implemented in Change 2A.
- Store-level persistence is covered; a later slice should add an integrated
  reload-to-spawn test if spawn assessment restore ordering changes.

## Completed Change 2B: Full-gate Slice Boundary Semantics

Problem:

Change 2A prevents repeated timeout and route-health loops, but it does not yet
encode the incident pattern where a full E2E gate goes green and later reviewer
or QA feedback reopens the same broad recovery chain.

Objective:

After a full gate goes green for a planner slice, later reviewer or QA blockers
should open a new bounded follow-up slice by default instead of extending the
old recovery chain, unless the user explicitly says to continue the same slice.

Scope:

- Add a narrow scalar writer for full-gate green evidence on a slice budget.
- Add the smallest spawn-time semantic needed to distinguish a post-green
  reviewer/QA follow-up from the original recovery slice.
- Keep the marker bounded and scalar: no prompts, logs, tool payloads, or child
  transcript bodies.
- Add focused tests for green marker persistence and post-green follow-up slice
  separation.

Non-goals:

- Do not implement Contract V2 application recovery.
- Do not add wall-clock or child-count limits in this slice.
- Do not broaden child tool permissions or route-health repair behavior.

Validation:

- Added tests that a green full-gate marker persists on the original slice.
- Added tests that a later reviewer or QA follow-up uses a new bounded slice while
  preserving the old slice's scalar evidence.
- Kept the existing Change 2A timeout and route-health tests green.

Done:

- The full-gate green field is written by a real code path.
- Post-green reviewer/QA follow-up does not silently reopen the old broad
  recovery chain.
- The behavior is covered without storing sensitive or large child output.

## Completed Change 3: Runtime Diagnostic And Spawn Reliability

Problem:

The Planner 2 incident mixed real task failure with misleading operator signals.
`queue.health` and session rows showed the lane was idle or terminal, while
Docker diagnostics still logged `state=processing`. `sessions_spawn` could also
look accepted even when background task registration failed, and repeated
announce retries added delay and noise.

Objective:

Make runtime status and child-spawn acceptance agree with durable state, then
cap noisy retry paths so they cannot stretch an already-failed orchestration
chain.

Scope:

- Reconcile stuck-session diagnostics against queue state, session status, and
  active run records before logging or surfacing `state=processing`.
- Clear or downgrade stale stuck-session diagnostics when queue depth is zero
  and the session row is `done`, `blocked`, `failed`, or reset.
- Tighten `sessions_spawn` acceptance semantics: either register the background
  task before reporting accepted, or return an explicit degraded or failed
  result when registration fails. **Completed in Change 3A for native subagent
  registry task creation failures.**
- Cap repeated announce retries and repeated 120 second announce waits per
  route/slice. The cap should produce a structured terminal routing issue rather
  than another silent wait.
- Ensure retry and announce diagnostics summarize scalar ids and counts instead
  of refeeding large child histories into the parent planner.

Validation:

- Added tests for stale `state=processing` diagnostics clearing when queue and
  session state are terminal, while preserving active-run and queued-work states.
- Added tests that a background task registration failure cannot be represented
  as a normal accepted native subagent run.
- Added tests that announce retry caps bound repeated long-wait gateway timeouts,
  preserve quick transient retries, space queued retry backoff independently of
  debounce, and log bounded scalar diagnostic text.

Done:

- Operators can distinguish active planner work from stale runtime-health noise.
- Spawn acceptance means a runnable child task exists, or the degraded state is
  visible and actionable.
- Announce retries cannot add unbounded wall-clock delay to a failed slice.

## Later Change 4: Context High-water Telemetry

Problem:

Post-compaction `totalTokens` can hide a child high-water such as
`129359 -> 14615`, and different surfaces may show different context limits.

Objective:

Persist and show current tokens, high-water tokens, effective context limit,
reserve, and compaction checkpoint data separately.

Notes:

- The completed child guardrail work is only a partial answer here because it
  records unhealthy post-run state, not full high-water telemetry.
- This change should define one canonical source for effective context limit and
  reserve at the time compaction or preflight occurs.

## Later Change 5: Early Helper Context Protection

Problem:

Helpers can accumulate many bounded tool reads until overflow. The latest
investigation showed growth from many tool results rather than a single user
paste or one huge command output.

Objective:

Add earlier cumulative protection for helper sessions before the overflow retry
path, using effective prompt budget and tool-result accumulation.

Notes:

- The completed guardrail is post-run and route-safety oriented.
- This change should be preflight or in-run protection, not only a warning after
  a helper is already unsafe to reuse.

## Later Change 6: Planner-safe Child Compaction

Problem:

Planners should be able to compact a controlled child intentionally, but sending
free-text `/compact` to a child is not a reliable control operation.

Objective:

Add a narrow explicit operation, such as `subagents(action: "compact")` or a
controlled `sessions_compact` tool surface, restricted to self or controlled
children.

Constraints:

- Do not expose broad planner session-control tools to leaf helpers.
- Return checkpoint id, tokens before/after, and route-health repair status.
- Do not let child compaction masquerade as child final output.
