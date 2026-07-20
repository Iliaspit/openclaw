---
summary: "Agent tools for cross-session status, recall, messaging, and sub-agent orchestration"
read_when:
  - You want to understand what session tools the agent has
  - You want to configure cross-session access or sub-agent spawning
  - You want to inspect status or control spawned sub-agents
title: "Session tools"
---

OpenClaw gives agents tools to work across sessions, inspect status, and
orchestrate sub-agents.

## Available tools

| Tool               | What it does                                                                |
| ------------------ | --------------------------------------------------------------------------- |
| `sessions_list`    | List sessions with optional filters (kind, label, agent, recency, preview)  |
| `sessions_history` | Read the transcript of a specific session                                   |
| `sessions_send`    | Send a message to another session and optionally wait                       |
| `sessions_spawn`   | Spawn an isolated sub-agent session for background work                     |
| `sessions_yield`   | End the current turn and wait for follow-up sub-agent results               |
| `subagents`        | List, steer, or kill spawned sub-agents for this session                    |
| `session_status`   | Show a `/status`-style card and optionally set a per-session model override |

## Listing and reading sessions

`sessions_list` returns sessions with their key, agentId, kind, channel, model,
token counts, and timestamps. Filter by kind (`main`, `group`, `cron`, `hook`,
`node`), exact `label`, exact `agentId`, search text, or recency
(`activeMinutes`). When you need mailbox-style triage, it can also ask for a
visibility-scoped derived title, a last-message preview snippet, or bounded
recent messages on each row. Derived titles and previews are produced only for
sessions the caller can already see under the configured session tool
visibility policy, so unrelated sessions stay hidden.

`sessions_history` fetches the conversation transcript for a specific session.
By default, tool results are excluded -- pass `includeTools: true` to see them.
The returned view is intentionally bounded and safety-filtered:

- assistant text is normalized before recall:
  - thinking tags are stripped
  - `<relevant-memories>` / `<relevant_memories>` scaffolding blocks are stripped
  - plain-text tool-call XML payload blocks such as `<tool_call>...</tool_call>`,
    `<function_call>...</function_call>`, `<tool_calls>...</tool_calls>`, and
    `<function_calls>...</function_calls>` are stripped, including truncated
    payloads that never close cleanly
  - downgraded tool-call/result scaffolding such as `[Tool Call: ...]`,
    `[Tool Result ...]`, and `[Historical context ...]` is stripped
  - leaked model control tokens such as `<|assistant|>`, other ASCII
    `<|...|>` tokens, and full-width `<｜...｜>` variants are stripped
  - malformed MiniMax tool-call XML such as `<invoke ...>` /
    `</minimax:tool_call>` is stripped
- credential/token-like text is redacted before it is returned
- long text blocks are truncated
- very large histories can drop older rows or replace an oversized row with
  `[sessions_history omitted: message too large]`
- the tool reports summary flags such as `truncated`, `droppedMessages`,
  `contentTruncated`, `contentRedacted`, and `bytes`

Both tools accept either a **session key** (like `"main"`) or a **session ID**
from a previous list call.

If you need the exact byte-for-byte transcript, inspect the transcript file on
disk instead of treating `sessions_history` as a raw dump.

## Sending cross-session messages

`sessions_send` delivers a message to another session and optionally waits for
the response:

- **Fire-and-forget:** set `timeoutSeconds: 0` to enqueue and return
  immediately.
- **Wait for reply:** set a timeout and get the response inline.

After the target responds, OpenClaw can run a **reply-back loop** where the
agents alternate messages (up to 5 turns). The target agent can reply
`REPLY_SKIP` to stop early.

## Status and orchestration helpers

`session_status` is the lightweight `/status`-equivalent tool for the current
or another visible session. It reports usage, time, model/runtime state, and
linked background-task context when present. Like `/status`, it can backfill
sparse token/cache counters from the latest transcript usage entry, and
`model=default` clears a per-session override.

`sessions_yield` intentionally ends the current turn so the next message can be
the follow-up event you are waiting for. Use it after spawning sub-agents when
you want completion results to arrive as the next message instead of building
poll loops.

`subagents` is the control-plane helper for already spawned OpenClaw
sub-agents. It supports:

- `action: "list"` to inspect active/recent runs
- `action: "steer"` to send follow-up guidance to a running child
- `action: "kill"` to stop one child or `all`

## Spawning sub-agents

`sessions_spawn` creates an isolated session for a background task by default.
It is always non-blocking -- it returns immediately with a `runId` and
`childSessionKey`.

Key options:

- `runtime: "subagent"` (default) or `"acp"` for external harness agents.
- `model` and `thinking` overrides for the child session.
- `thread: true` to bind the spawn to a chat thread (Discord, Slack, etc.).
- `sandbox: "require"` to enforce sandboxing on the child.
- `context: "fork"` for native sub-agents when the child needs the current
  requester transcript; omit it or use `context: "isolated"` for a clean child.

Default leaf sub-agents do not get session tools. When
`maxSpawnDepth >= 2`, depth-1 orchestrator sub-agents additionally receive
`sessions_spawn`, `subagents`, `sessions_list`, and `sessions_history` so they
can manage their own children. Leaf runs still do not get recursive
orchestration tools.

After completion, an announce step posts the result to the requester's channel.
Completion delivery preserves bound thread/topic routing when available, and if
the completion origin only identifies a channel OpenClaw can still reuse the
requester session's stored route (`lastChannel` / `lastTo`) for direct
delivery.

For ACP-specific behavior, see [ACP Agents](/tools/acp-agents).

## Protected delegation workflows

Operators can enable `agents.delegationGuard` when session tools must enforce a
planner-owned evidence workflow instead of relying on prompt instructions. The
guard is optional; installations that do not enable it keep the session-tool
behavior described above.

When enabled, the Gateway becomes the authority for slice scope, assignments,
candidate and wave identity, exact model and thinking policy, route ownership,
receipts, correction budgets, remediation revisions, and rollback epochs. A
guarded controller receives `delegation_guard`, while a guarded worker receives
`delegation_report`. Workers cannot create authority records or approve their
own report.

Guarded `sessions_spawn`, `sessions_send`, and `subagents` steer operations need
an opaque, one-use delegation token. The Gateway binds each token to the exact
controller session, worker, assignment, route kind, target session when
applicable, candidate, wave, route family, and epoch. Worker-to-worker routes,
cross-controller routes, stale assignments, model or thinking changes, and
generic session-tool bypasses fail closed in enforcement mode. Audit mode
records protected route decisions while preserving legacy delivery.

The Gateway authorizes guarded child requests before consulting its generic
idempotency cache and permits only one non-overlapping dispatch per assignment.
Terminal routes, submitted reports, and prior dispatches invalidate every
unused token or capability for that assignment. Durable task evidence remains
held past normal retention until the protected ledger closes successful work.
Failures before accepted execution create immutable `route_rejected` evidence.
Failures after accepted execution create `validation_rejected` evidence, and
uncertain post-crash execution blocks recovery instead of risking duplicate
side effects. New reports persist their receipt and validator result
atomically, and restart reconciliation closes any older incomplete
validation/finalization record.
Rollback or validator-stack installation cannot advance the epoch while an
assignment in the current epoch remains active.

`delegation_report` rejects invalid scope bindings, report structure,
`newlyDiscovered` scope, writable-scope drift, and candidate drift before it
uses the assignment's report slot. The Gateway records that rejection and its
assignment mapping in one append-only transaction without creating a receipt,
validation, or terminal route event. The worker can correct and resubmit during
the same run. If the worker exits first, its controller can retrieve bounded
rejection metadata with `delegation_guard` `validate_completion`.

Late dependencies belong in `scope.newlyDiscovered`. Use the same canonical
repository-relative path for both `scopeId` and `path`, cite existing unique
evidence IDs, and normally use the `follow-up` disposition. Assigned scope IDs
remain for `inspected`, `omitted`, or `failed` coverage. A `covered` late path
requires successful, nontruncated command evidence or matching path-bound
artifact evidence.

Format correction is available only after a rejected or blocked receipt and
must preserve that receipt's semantic digest. A pre-receipt rejection has no
receipt to correct. `validation_rejected` remains fail-closed and cannot
authorize a recovery child; after any report failure, the controller creates a
corrected new slice in the same epoch. OpenClaw does not automatically continue
or replay the worker.

The accepted protected report and ledger receipt are authoritative even when a
worker's final prose is incomplete. OpenClaw classifies raw model stop reasons,
marks `length` and `max_tokens` output as truncated, and appends a visible
incomplete-handoff notice before freezing and hashing the result. Runtime
capping at 100KB is recorded separately. A truncated prose handoff can still
complete when its protected report was accepted, but the parent is explicitly
shown that the prose is incomplete.

The protected workflow is ordered:

1. Create a finite file scope and record its baseline.
2. Complete one helper discovery assignment and one implementation assignment.
3. Freeze the stopped implementation as a candidate.
4. Start tester and reviewer on the same candidate before either can complete.
5. Run conditional QA only after both reports are accepted and the candidate is
   unchanged.
   Tester, reviewer, and conditional QA must each finish their finite scope,
   continue after every finding, perform a second distinct-failure sweep, and
   return one consolidated report before remediation begins.
6. Aggregate all validated findings into one immutable remediation revision.
7. Run one consolidated remediation assignment, then freeze a new candidate for
   targeted confirmation.

The Gateway binds every guarded child to the slice's canonical worktree even
when the worker's configured default workspace points elsewhere. It stores a
protected dirty-path inventory with each candidate and rejects writable reports
or wave freezes that changed paths outside the finite slice. A controller's
bounded wait expiring is audit evidence only and leaves the worker pending; only
the worker run's actual deadline creates a terminal timeout, and a timeout never
counts as review or QA approval.

Repository-wide scope cannot be represented by `.`, an empty path, a directory,
or a glob. It uses an explicit operator-authorized repository scope. Slice scope
uses canonical `openclaw-scope-v1` file entries with `existing` or `may-create`
expectations. The Gateway stores the append-only ledger separately from agent
workspaces and executes a digest-pinned, read-only validator bundle from
protected state.

### Ledger integrity and narrow repair

Normal guarded operation never skips ledger validation. Completed format
corrections require one exact `validation_rejected` event, bound to the original
receipt and validation and causally located between the original and corrected
receipt append records. Missing, duplicate, earlier, later, corrected-receipt,
or unrelated rejection evidence remains fail-closed.

Two exact historical contradictions have a forward-only maintenance path. The
first is a completed format correction whose otherwise exact ledger is missing
only its superseded rejection event. The second is one observed legacy sequence:
an accepted route, rejected receipt, receipt-bound rejection, same-run
`missing-accepted-report` observation at the terminal-result timestamp, corrected
receipt, and completion, in that exact append order. The second case also requires
one unique terminal-run binding and binds its child-session identity. A later,
reordered, differently identified, differently shaped, or additional rejection is
not repairable by this path.

The repair never recreates an event, deletes or updates prior rows, or introduces
a generic ignore flag. It appends one repair event and one receipt. Ordinary
ledger open accepts the correction only when both records bind the assignment,
full corruption fingerprint, pre-repair ledger head, exact correction and
terminal state, the complete case-specific event/count evidence, active validator
identity and digest, operator identity, reason/ticket, and one-shot idempotency
key.

This is stopped-gateway maintenance, not a controller tool or normal recovery
route. Stop the Gateway and every other ledger writer, preserve a backup, and
use a source checkout containing the maintenance code. Never inspect or repair
the SQLite database or its WAL while a Gateway owns it.

First create an exclusive inspection record:

```bash
pnpm delegation:ledger:repair inspect --state-dir /absolute/openclaw-state --assignment assignment_example --output /absolute/secure/inspection.json
```

After independent operator review, create a new authorization file. The command
refuses to overwrite an existing file:

```bash
pnpm delegation:ledger:repair authorize --inspection /absolute/secure/inspection.json --operator-id operator@example.com --reason "Approved exact historical correction repair" --ticket OPS-4242 --idempotency-key repair-assignment-example-1 --output /absolute/secure/authorization.json
```

Apply exactly that authorization while the Gateway remains stopped:

```bash
pnpm delegation:ledger:repair apply --state-dir /absolute/openclaw-state --authorization /absolute/secure/authorization.json
```

The event and receipt commit together under an exclusive, synchronous
transaction. An interrupted write rolls both back. Repeating the byte-equivalent
authorization returns the original receipt without another append; a changed,
stale, replayed, conflicting, or concurrent request fails. Afterward, restart
through the normal service path and confirm strict ledger open before beginning
runtime QA. Source implementation of the repair does not mean any installed
ledger was repaired or any deployed Gateway was validated.

Every guarded controller and worker must use a per-session Docker sandbox.
Controller and verification workspaces are read-only; only the implementer is
read-write. Guarded sandboxes reject inherited extra bind mounts, injected
Docker environment values, browser binds, and dangerous bind or namespace
overrides. Do not expose Gateway state, credentials, validator internals,
receipt storage, lane tokens, or the Docker socket to child sandboxes.

## Visibility

Session tools are scoped to limit what the agent can see:

| Level   | Scope                                    |
| ------- | ---------------------------------------- |
| `self`  | Only the current session                 |
| `tree`  | Current session + spawned sub-agents     |
| `agent` | All sessions for this agent              |
| `all`   | All sessions (cross-agent if configured) |

Default is `tree`. Sandboxed sessions are clamped to `tree` regardless of
config.

## Further reading

- [Session Management](/concepts/session) -- routing, lifecycle, maintenance
- [ACP Agents](/tools/acp-agents) -- external harness spawning
- [Multi-agent](/concepts/multi-agent) -- multi-agent architecture
- [Gateway Configuration](/gateway/configuration) -- session tool config knobs

## Related

- [Session management](/concepts/session)
- [Session pruning](/concepts/session-pruning)
