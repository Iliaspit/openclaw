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

| Status  | Upstream commit | Scope                                                                  | Validation target                                      |
| ------- | --------------- | ---------------------------------------------------------------------- | ------------------------------------------------------ |
| Done    | `e498d39bed`    | Prevent ReDoS in background session-name derivation.                   | `pnpm test src/agents/bash-tools.shared.test.ts --run` |
| Planned | `7bc4a333aa`    | Escape HTML export entry IDs to prevent attribute XSS.                 | Export HTML security test                              |
| Planned | `fe8d99d421`    | Escape field names in transcript regex extraction.                     | Session utils filesystem tests                         |
| Planned | `503b748a8e`    | Escape control characters in exec approval display sanitizers.         | Exec approval display tests                            |
| Planned | `743051d400`    | Refuse uninstall cleanup when target is the current working directory. | Cleanup utility tests                                  |
| Planned | `e74931778c`    | Preserve workspaces during state-only uninstall.                       | Cleanup/uninstall tests                                |
| Planned | `2d00bedc1e`    | Prevent bootstrap pairing scope changes.                               | Device bootstrap and pairing tests                     |
| Planned | `8b76392e3e`    | Enforce owner-only tool policy on MCP loopback.                        | MCP HTTP tests                                         |
| Planned | `3cb1a56bfc`    | Derive loopback owner context from token.                              | MCP HTTP tests                                         |
| Planned | `0e702f1063`    | Clamp unbound websocket auth scopes.                                   | Gateway auth tests                                     |
| Planned | `1c1f42a74a`    | Clamp provider timeout values.                                         | Secrets resolve tests                                  |
| Planned | `7979639cd8`    | Cap non-finite preauth limits.                                         | Preauth connection budget tests                        |
| Planned | `c070509b7f`    | Bound archive and MIME parser work.                                    | Archive, MIME, plugin fetch tests                      |
| Planned | `51dbc2c60f`    | Remove drained reply-queue items by reference.                         | Queue/followup drain tests                             |
| Planned | `75c1790b50`    | Preserve retries for budget-deferred outbound deliveries.              | Outbound recovery tests                                |
| Planned | `46e12e7aff`    | Cap MCP loopback tool cache.                                           | MCP HTTP tests                                         |
| Planned | `157da3621a`    | Close slow direct response consumers.                                  | Gateway websocket tests                                |
| Planned | `172c3f6064`    | Classify MCP JSON-RPC failures.                                        | MCP HTTP tests                                         |
| Planned | `801df108f0`    | Bound exec approvals stdin.                                            | Exec approvals CLI tests                               |
| Planned | `23e0be355a`    | Bound async session-list transcript reads.                             | Session utils filesystem tests                         |
| Planned | `aec83af23d`    | Bound chat-history transcript reads.                                   | Chat/session history tests                             |
| Planned | `d1cb6cd0b5`    | Preserve native vision skip with imageModel fallback.                  | Media understanding runner tests                       |
| Planned | `53357e8e7f`    | Neutralize browser media directives.                                   | Browser tool action tests                              |

## Deferred

- Approval-runtime token cluster: local approval-runtime paths are older or missing, so porting it
  would be an architecture change rather than a clean cherry-pick.
- Broad memory SQLite migrations and recent storage moves: high performance and compatibility risk.
- Large iMessage, Telegram, Android, iOS, and macOS rewrites: not part of this selective core fix
  pass.
- Provider fixes whose upstream paths are absent here: keep as future manual ports if the relevant
  provider code is reintroduced or refactored locally.
