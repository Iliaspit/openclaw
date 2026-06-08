# Upstream Cherry-Pick Plan

This plan tracks selective fixes to port from upstream `openclaw/openclaw` after the fork point
`f49d9bcae968b9ee295fdcab05d1dbd4cda294ce`.

## Constraints

- Do not merge or rebase the upstream branch.
- Keep each patch small and commit after its focused validation passes.
- Avoid broad SQLite migrations, large channel rewrites, mobile-only churn, release machinery, and
  architecture changes that could import known newer-version performance risk.
- Stage only files touched for the active fix; the worktree contains unrelated local changes.
- Treat `src/security/**` and security-owned gateway/docs paths as restricted. Do not edit those
  paths unless the change is explicitly accepted as part of this plan.

## Selected Fixes

| Status   | Upstream commit | Scope                                                                  | Validation target                                                                                                                                                               |
| -------- | --------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Done     | `e498d39bed`    | Prevent ReDoS in background session-name derivation.                   | `pnpm test src/agents/bash-tools.shared.test.ts --run`                                                                                                                          |
| Done     | `7bc4a333aa`    | Escape HTML export entry IDs to prevent attribute XSS.                 | `pnpm test src/auto-reply/reply/export-html/template.security.test.ts --run`                                                                                                    |
| Deferred | `fe8d99d421`    | Escape field names in transcript regex extraction.                     | Not directly applicable to this checkout                                                                                                                                        |
| Done     | `503b748a8e`    | Escape control characters in exec approval display sanitizers.         | `pnpm test src/infra/exec-approval-command-display.test.ts src/infra/exec-approval-forwarder.test.ts --run`; Swift blocked by unrelated `GatewayConnection.swift` compile error |
| Done     | `743051d400`    | Refuse uninstall cleanup when target is the current working directory. | `pnpm test src/commands/cleanup-utils.test.ts --run`                                                                                                                           |
| Done     | `e74931778c`    | Preserve workspaces during state-only uninstall.                       | `pnpm test src/commands/cleanup-utils.test.ts src/commands/uninstall.test.ts --run`                                                                                             |
| Done     | `2d00bedc1e`    | Prevent bootstrap pairing scope changes.                               | `pnpm test src/infra/device-bootstrap.test.ts src/infra/device-pairing.test.ts --run`                                                                                           |
| Done     | `8b76392e3e`    | Enforce owner-only tool policy on MCP loopback.                        | `pnpm test src/gateway/mcp-http.test.ts --run`                                                                                                                                 |
| Done     | `3cb1a56bfc`    | Derive loopback owner context from token.                              | `pnpm test src/gateway/mcp-http.test.ts src/agents/cli-runner/bundle-mcp.test.ts src/agents/cli-runner.bundle-mcp.e2e.test.ts --run`                                           |
| Done     | `0e702f1063`    | Clamp unbound websocket auth scopes.                                   | `pnpm test src/gateway/server/ws-shared-generation.test.ts src/gateway/server-methods/config.shared-auth.test.ts --run`; `pnpm test src/gateway/server.auth.control-ui.test.ts src/gateway/server.auth.browser-hardening.test.ts --run`; `pnpm test src/gateway/server/ws-connection.test.ts --run` |
| Done     | `1c1f42a74a`    | Clamp provider timeout values.                                         | `pnpm test src/secrets/resolve.test.ts --run`                                                                                                                                  |
| Done     | `7979639cd8`    | Cap non-finite preauth limits.                                         | `pnpm test src/gateway/server/preauth-connection-budget.test.ts --run`; `pnpm test src/gateway/server.preauth-hardening.test.ts --run`                                        |
| Done     | `c070509b7f`    | Bound archive and MIME parser work.                                    | `pnpm test src/infra/archive.test.ts src/media/mime.test.ts src/plugins/clawhub.test.ts --run`                                                                                  |
| Done     | `51dbc2c60f`    | Remove drained reply-queue items by reference.                         | `pnpm test src/utils/queue-helpers.test.ts src/auto-reply/reply/queue.drain-restart.test.ts --run`                                                                              |
| Done     | `75c1790b50`    | Preserve retries for budget-deferred outbound deliveries.              | `pnpm test src/infra/outbound/delivery-queue.recovery.test.ts --run`                                                                                                            |
| Done     | `46e12e7aff`    | Cap MCP loopback tool cache.                                           | `pnpm test src/gateway/mcp-http.test.ts --run`                                                                                                                                 |
| Done     | `157da3621a`    | Close slow direct response consumers.                                  | `pnpm test src/gateway/server/ws-connection.test.ts --run`                                                                                                                      |
| Done     | `172c3f6064`    | Classify MCP JSON-RPC failures.                                        | `pnpm test src/gateway/mcp-http.test.ts --run`                                                                                                                                 |
| Done     | `801df108f0`    | Bound exec approvals stdin.                                            | `pnpm test src/cli/exec-approvals-cli.test.ts --run`                                                                                                                           |
| Done     | `23e0be355a`    | Bound async session-list transcript reads; already satisfied locally.   | `pnpm test src/gateway/session-utils.fs.test.ts --run`                                                                                                                         |
| Done     | `aec83af23d`    | Bound chat-history transcript reads.                                   | `pnpm test src/gateway/session-utils.fs.test.ts --run`; `pnpm test src/gateway/server.chat.gateway-server-chat.test.ts -t "chat.history" --run`; `pnpm test src/gateway/server.chat.gateway-server-chat-b.test.ts -t "chat.history" --run` |
| Done     | `d1cb6cd0b5`    | Preserve native vision skip with imageModel fallback.                  | `pnpm test src/media-understanding/runner.vision-skip.test.ts --run`                                                                                                            |
| Done     | `53357e8e7f`    | Neutralize browser media directives.                                   | `pnpm test extensions/browser/src/browser-tool.test.ts --run`                                                                                                                   |
| Done     | `f658abae50` + `e7f1b24d9d` | Suppress internal protocol artifacts from user-facing replies.          | `pnpm test src/auto-reply/tokens.test.ts src/auto-reply/reply/reply-utils.test.ts extensions/telegram/src/bot-message-dispatch.test.ts --run`                                  |
| Done     | `22bda60cbe`    | Rebind QMD collections after collection-root changes.                  | `pnpm test extensions/memory-core/src/memory/qmd-manager.test.ts -t "rebinds sessions collection|avoids destructive rebind|rebinds collection when qmd text output|migrates unscoped legacy collections before adding scoped names|rebinds conflicting collection name|warns instead of silently succeeding|falls back to --mask|rebinds a managed collection when its root path changed|rebinds a stale in-container collection root|parseShownCollection extracts path" --run`; full-file target currently fails on unrelated dirty `src/memory-host-sdk/host/backend-config.ts` limit drift (4 vs expected 6). |
| Deferred | `57633c42b6`    | Preserve CLI silent empty-reply policy for message-tool-only turns.    | Not a clean cherry-pick in this checkout: local CLI/queued-run types do not have the upstream delivery-mode/empty-reply policy fields.                                           |

## Deferred

- Approval-runtime token cluster: local approval-runtime paths are older or missing, so porting it
  would be an architecture change rather than a clean cherry-pick.
- Broad memory SQLite migrations and recent storage moves: high performance and compatibility risk.
- Large iMessage, Telegram, Android, iOS, and macOS rewrites: not part of this selective core fix
  pass.
- Provider fixes whose upstream paths are absent here: keep as future manual ports if the relevant
  provider code is reintroduced or refactored locally.
- `fe8d99d421`: the vulnerable oversized-line metadata extraction helpers are not present in this
  checkout's `src/gateway/session-utils.fs.ts`, so porting it would require a broader transcript
  reader refactor rather than a narrow cherry-pick.
- `0176429ad7`: diagnostic context-count reporting conflicts locally and adds full active
  transcript reads on the command path, so it is not part of the low-risk cherry-pick set.
- `f4e746bdfc`: useful memory-wiki link behavior but broader generated-output semantics and
  conflicts; defer to a plugin-local pass.
- `2ffbea20d2`: real stale exec-approval followup fix, but it spans gateway protocol, Swift, and
  multiple renamed exec-host surfaces in this checkout.
- `57633c42b6`: the local `RunCliAgentParams` and `FollowupRun["run"]` contracts do not expose
  `sourceReplyDeliveryMode`, `silentReplyPromptMode`, or `allowEmptyAssistantReplyAsSilent`;
  applying it would require a larger delivery-mode contract backport rather than a narrow fix.
- `81234fbf12`: feature/prompt-shape change, prompt-cache-sensitive, and broader than this fix pass.
