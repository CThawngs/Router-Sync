# C45 Stage 2 Evidence Report (`evidence/d2`) — WP4, WP5, WP6 (`Phục vụ: S3, S4, S5, S9`)

- **Repository:** `https://github.com/CThawngs/Router-Sync`
- **Base `origin/main` SHA:** `58188dd746436ca5c3530e4cde156c1f03b705d7` (`58188dd`)
- **Stage 1 Evidence Anchor:** `origin/evidence/d1` @ `6e4ff69` (branched from `main` `cf88423`)
- **Evidence Branch:** `evidence/d2` (direct push with `[skip ci]`, no Pull Request, never merged to `main`)
- **Stage 2 Scope:** `WP4` (`Phục vụ: S3, S4, S9`), `WP5 + WP6` (`Phục vụ: S4, S5`)
- **Main 5-OS CI Gate:** Run `45500443928` — `status=completed`, `conclusion=success`, `18/18` jobs green, `attempt=1`

---

## 1. Báo cáo kiểm định Stage 2 / Stage 2 Work Package Audit Summary (4 RACI Proofs)

| WP | Phục vụ | PR # & Head SHA | Squash-Merge `main` SHA | PR 5-OS CI (`attempt=1`) | QA Audit Sign-Off & Mutations Killed | `main` Push 5-OS CI (`attempt=1`) | Status |
|---|---|---|---|---|---|---|---|
| **WP4** | `S3, S4, S9` | PR #74 (`a146d8d`) | `25574a9049cfe832ca300ab657c887b971c238a9` (`25574a9`) | Run `45488487062` (`18/18`) | QA `SIGNED OFF` (`#issuecomment-7144908861`: `11/11` QA + `7/7` Engineer mutations `100%` KILLED) | Run `45491493082` (`18/18`) | **XONG (DONE)** |
| **WP5 + WP6** | `S4, S5` | PR #75 (`90cd38a`) | `58188dd746436ca5c3530e4cde156c1f03b705d7` (`58188dd`) | Run `45494432631` (`18/18`) | QA `SIGNED OFF` (`#issuecomment-7146033150`: `7/7` QA + `7/7` Engineer mutations `100%` KILLED) | Run `45500443928` (`18/18`) | **XONG (DONE)** |

---

## 2. Tóm tắt kiến trúc Stage 2 / Stage 2 Capability Summary

### 2.1 Controlled Automation, 3-Tier Consent & Emergency Freeze (`WP4` — `S3, S4, S9`)
- **3-Tier Per-Target Policy (`off` / `propose` / `auto-safe`):** Standing consent stored in `<stateDir>/consent.json` with HMAC integrity (`packages/core/src/consent/standing-consent.ts`, `signing.ts`), default 30-day TTL, explicit per-target scopes (default empty, replacing the legacy test-only regex), and enforced promotion gate (`auto-safe` requires `>= 1` verified zero-rollback `propose` apply with matching read-back recorded in `apply-history.json`).
- **Controlled MCP Write (`apply_plan`) & Safety Invariants:** Requires valid unexpired standing consent or daemon approval token (`packages/core/src/consent/approval-token-store.ts`), exact `planHash` match, sandbox guard (`sandbox-guard.ts`), atomic backup + read-back + automatic rollback on drift, and post-apply inbox/webhook notifications while enforcing `I1..I8`.
- **Emergency Circuit-Breaker & Observability:** `routersync freeze` immediately halts all write paths (`packages/core/src/consent/freeze.ts`, `packages/cli/src/commands/freeze.ts`), `routersync unfreeze` restores interactively, and `routersync status` displays per-target tier and freeze posture.

### 2.2 Reliability Combo Selector, Lossless LiteLLM YAML CST & `<= 12`-Question Bootstrap (`WP5 + WP6` — `S4, S5`)
- **Strategy Discovery & Reliability Combo Selector (`WP5`):** `packages/cli/src/rank/combo-selector.ts`, `filters.ts`, and `interleave.ts` select router strategies from user profile + router capabilities, preserve provider-level account rotation with combo-level `fallback`, cap generated combos at `12–15` steps, exclude `HANG`/`DEAD` and non-chat specialized models using `combos reliability` evidence, and interleave providers.
- **Lossless LiteLLM YAML CST Adapter (`WP5`):** `packages/cli/src/litellm/yaml-cst.ts`, `adapter.ts`, and `commands/litellm.ts` implement inspect, plan, atomic write, backup, read-back, and rollback over `config.yaml` while preserving comments, formatting, and untouched sections byte-for-byte.
- **Adaptive `<= 12`-Question Interview & 9 Harness Skill Guides (`WP6`):** `packages/core/src/profile/adaptive-interview.ts` and `packages/mcp-server/src/strategy-interview.ts` deliver a capped `<= 12`-question adaptive interview that uses plain-language examples for non-technical users, records explicit defaults/assumptions in `profile.yaml` without fabricating profile data, and ships dedicated onboarding/skill guides for all 9 harnesses under `docs/ai/harnesses/*.md` (verified by `test/docs/wp6-harness-skills.test.ts`).

---

## 3. Isolated Evidence Captures (`evidence/d2/records.jsonl`)

Captured in an isolated temporary clone branched directly from `origin/main` (`58188dd746436ca5c3530e4cde156c1f03b705d7`) with zero writes to user router databases, live localhost ports, or user home configurations.

| # | Record ID | Command (`SAFE_VERBS`) | Exit | Duration | Key Verified Result | `stdout` SHA-256 (12) | `stderr` SHA-256 (12) |
|---:|---|---|---:|---:|---|---|---|
| 1 | `full-test-and-e2e` | `pnpm verify:release` | `0` | `235855 ms` | `typecheck` + `lint` + `build` + `test` (`189/189` files, `1488 passed \| 1 skipped`) + `e2e` (`1/1` file, `13/13` passed; MCP stdio `25` read-only + `1` ledger-append + `1` controlled-write tools) | `5178bfc42692` | `cba4d6a67e84` |
| 2 | `stage2-consent-and-bootstrap` | `pnpm vitest run packages/core/test packages/cli/test packages/mcp-server/test` | `0` | `134655 ms` | `115/115` test files passed, `1071 passed \| 1 skipped` (`1072` total) covering `standing-consent`, `wp4-controlled-automation`, `apply-plan`, `wp5-combo-selector`, `wp5-litellm-adapter`, `adaptive-interview`, `strategy-interview` | `dd515845d7ff` | `1c5f09192c25` |
| 3 | `security-and-pack-audit` | `node tools/agent/security-audit.mjs` | `0` | `29003 ms` | `repo-files` (`706`), `evidence-refs` (`25` refs / `1070` blobs), `tarballs` (`8` pkgs), `write-gates`: `ok=true high=0 medium=0 low=0` | `994f5446e39a` | `e3b0c44298fc` |

- All 3 records loaded `privateNamesLoaded=12` automatically via `tools/agent/capture-evidence.mjs`.

---

## 4. Bảng trạng thái 9 Harness — Stage 2 Capability & Skill Matrix

| Harness | MCP Format & Install Strategy | Native Scheduler & Fallback | Direction A Mode (Model List) | Evidence Tier | Stage 2 WP6 Skill Guide |
|---|---|---|---|---|---|
| **Hermes** (`hermes`) | `yaml` (`yaml-comment-preserving-merge`) | Native 0-token script (`os-scheduler` fallback) | Yes (`write-adapter`) | **A** | `docs/ai/harnesses/hermes.md` |
| **Claude Code** (`claude-code`) | `json` (`prefer-native-cli-else-atomic-json-merge`) | Native LLM-only (`os-scheduler-and-tick-if-due`) | Yes (`report-only`) | **A** | `docs/ai/harnesses/claude-code.md` |
| **Codex** (`codex`) | `toml` (`prefer-native-cli-else-toml-append-table`) | Native LLM-only (`os-scheduler-and-tick-if-due`) | Yes (`report-only`) | **A** | `docs/ai/harnesses/codex.md` |
| **Antigravity** (`antigravity`) | `json` (`atomic-json-merge`) | Native 0-token script (`os-scheduler` fallback) | No (`report-only`) | **A** | `docs/ai/harnesses/antigravity.md` |
| **OpenCode** (`opencode`) | `jsonc` (`jsonc-comment-preserving-merge`) | None (`os-scheduler-and-tick-if-due`) | Yes (`write-adapter`) | **A** | `docs/ai/harnesses/opencode.md` |
| **Cursor** (`cursor`) | `json` (`atomic-json-merge`) | Native LLM-only (`os-scheduler-and-tick-if-due`) | No (`report-only`) | **A** | `docs/ai/harnesses/cursor.md` |
| **Grok-Bot** (`grok-bot`) | Unsupported local stdio (guide HTTPS tunnel / CLI) | Native LLM-only (`os-scheduler-and-tick-if-due`) | No (`report-only`) | **B** | `docs/ai/harnesses/grok-bot.md` |
| **OpenMausBot** (`openmausbot`) | `json` (`atomic-json-merge`) | Native LLM-only (`os-scheduler-and-tick-if-due`) | Yes (`write-adapter`) | **A** | `docs/ai/harnesses/openmausbot.md` |
| **DeepSeek Harness** (`dsh`) | `yaml` (`yaml-cordis-insert-merge`) | Native LLM-only (`os-scheduler-and-tick-if-due`) | Yes (`write-adapter`) | **A** | `docs/ai/harnesses/dsh.md` |

---

## 5. Packaging & Hygiene Compliance

- Package file budget: **9 files (`<= 10`)** inside `evidence/d2/` (`6` capture `.out.txt`/`.err.txt` + `records.jsonl` + `REPORT.md` + `NOTE.md`).
- Verified prior to push via `verify-records.mjs`, `verify-package.mjs`, `scan-private-names.mjs`, and `no-personal-paths.mjs` (all `exit 0`).
- Zero live writes to owner configs or router databases; workspace package versions remain locked at `0.1.0`; no release tags or registry publishes.