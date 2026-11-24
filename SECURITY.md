# Security Policy

## 1. Supported Versions & v0.1 Security Scope

| Version | Supported | Default Posture |
|---|---|---|
| `0.1.0` | Yes | Read-only by default (`scan`, `plan`, `status`, `doctor`, `verify`, `tick`, `combos stale`, `apps drift`, loopback daemon, 24 MCP tools). All write paths fail closed without explicit human authorization. |

### Read-Only Default Surface

- **CLI observation & planning:** `routersync scan`, `routersync status`, `routersync doctor`, `routersync plan`, `routersync verify`, `routersync tick`, `routersync combos stale`, and `routersync apps drift` open router SQLite databases in read-only mode and make zero inference calls (`GET /models` and public catalogues only; `routersync combos probe` defaults to dry-run unless `--yes-spend-tokens` is explicitly passed).
- **S1 Loopback Daemon:** `routersync daemon` binds strictly to `127.0.0.1` (never `0.0.0.0`) and enforces an `Origin` allowlist on state-changing HTTP endpoints to block cross-site browser requests (CSRF / DNS-rebinding defense; see `docs/security/`).
- **MCP Server:** `packages/mcp-server` exposes 24 read-only tools and zero router-write tools.

### Trust Boundaries

- **Same-OS-user local process vs external origins:** Local files owned by the current OS user (`config.yaml`, `ranking.yaml`, router SQLite databases) are within the local user boundary, whereas browser pages (`Origin` headers), LAN/remote network peers, upstream provider HTTP responses, model IDs, and deprecation notices are treated as untrusted input.
- **Mandatory human-gated write paths:** RouterSync refuses unattended or piped writes across every write mechanism:
  1. **Interactive TTY + Confirmation Word:** `routersync sync --apply`, `routersync undo --apply`, `routersync rank --apply`, and `routersync rollback --write` require an interactive `TTY` (`process.stdin.isTTY`) plus manual entry of the confirmation word (`chạy`), preceded by a database snapshot and followed by serving-path read-back.
  2. **Scoped Maintain `GrantFile` (`ROUTERSYNC_GRANT_SECRET`):** `routersync maintain authorize` and `routersync maintain apply` (`docs/adr/ADR-MAINTAIN-02-apply-grant-lifecycle.md`) enforce combo allowlists, refuse `--yes` bypasses, derive verification material with `scrypt`, and verify a time-bounded HMAC-SHA256 `GrantFile` (`grant.json`) before touching target combos.
  3. **Daemon Single-Use HMAC `ApprovalToken`:** `POST /api/v1/changes/approve` enforces loopback `Origin` validation, constant-time HMAC-SHA256 signature verification (`<nonceHex>.<sigHex>`), exact `planHash` binding, strict TTL expiry, and single-use nonce consumption (`token_already_consumed` on replay).
  4. **External 9Router Patch Script Gate:** `tools/agent/nine-router-patch.mjs` defaults to read-only dry-run and refuses to modify 9Router files unless both `--yes-write-router` and `RS_OWNER_CONFIRMED=chạy` are explicitly supplied by the human operator.

---

## 2. What RouterSync NEVER Writes to Disk

RouterSync enforces a strict data-minimization contract across state files, plans, snapshots, logs, npm tarballs, and `evidence/*` branches. RouterSync **NEVER writes to disk**:

1. **Raw provider API keys or router client credentials** read from 9Router or OmniRoute SQLite databases (`apiKeys`, `apiKeys.key`, `provider_connections` secrets, or bearer credentials). Keys are read into memory only when needed for read-only `GET /models` or authorized probes and are never serialized into plans, `status.json`, `verify-status.json`, or logs.
2. **Plaintext `ROUTERSYNC_GRANT_SECRET` passphrases:** `grant.json` persists only a random `salt`, `scrypt` digest, scoped combo metadata, timestamps, and HMAC `mac` — never the raw secret.
3. **Daemon HMAC signing keys or raw `ApprovalToken` secrets:** The daemon's ephemeral HMAC signing key (`signingKey`) lives strictly in process memory and is excluded from JSON serialization and disk state.
4. **Unredacted upstream HTTP error bodies or long token-like substrings (`>= 28` characters):** `routersync combos probe`, `inbox.json`, `status.json`, and evidence transcripts truncate error snippets and mask token-shaped strings and local filesystem paths before output.
5. **`.env` files, personal OS home paths, OS usernames, machine hostnames, or private local provider names** in git-tracked repository files, publishable `@routersync/*` tarballs, or `evidence/*` git refs (only `.env.example` with safe loopback placeholder URLs is tracked).

---

## 3. Automated Multi-Surface Security Auditing

Every commit, tarball, and evidence package is guarded by automated checks:

- **Pre-commit & CI static guards:** `tools/guard/no-secrets.mjs` and `tools/guard/no-personal-paths.mjs` run during `pnpm lint` and git hooks (`pnpm hooks:install`).
- **Multi-surface auditor & write-gate checklist:** `tools/agent/security-audit.mjs` (covered by `test/agent/security-audit.node.test.mjs`) audits:
  1. Tracked and non-ignored repository files (`repo-files`), `.env` leakage, and K6.2 git publish rules.
  2. All `evidence/*` git refs without working-tree checkout (`evidence-refs`).
  3. All 8 publishable `@routersync/*` npm tarballs (`tarballs`).
  4. Recent public GitHub Actions workflow logs when invoked with `--with-ci-logs` (`ci-logs`).
  5. Programmatic fail-closed router write gates (`grant`, `approval-token`, and `--yes-write-router`) in isolated `os.tmpdir()` fixtures (`write-gates`), reporting sanitized findings without ever echoing matched secret or personal substrings.

---

## 4. Reporting a Vulnerability

We take security and secret protection seriously. If you discover a potential vulnerability (especially regarding secret leakage, API key handling, or unintended write operations), please report it responsibly:

1. **Do not** create a public GitHub issue, pull request, or discussion.
2. Use GitHub's private vulnerability reporting: open this repository's **Security** tab and choose **Report a vulnerability**. That form is private between you and the maintainers.
3. If private reporting is not available for this repository, open a regular issue that contains only a short, non-technical description of the class of problem (no proof-of-concept, no credentials, no personal data), and ask the maintainer for a private channel.
4. Include detailed steps to reproduce the issue, environment information, and relevant sanitized logs (ensure all API keys, bearer tokens, and credentials are completely redacted).
5. You will receive an acknowledgment within 48 hours, followed by updates as the issue is investigated and resolved.

Thank you for helping keep RouterSync and its community secure!
