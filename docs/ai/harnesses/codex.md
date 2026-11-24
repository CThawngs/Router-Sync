# OpenAI Codex — RouterSync Integration & Skill Guide

**Harness ID:** `codex`
**Display Name:** OpenAI Codex CLI (and Desktop / IDE Extension)
**Direction A Mode:** `report-only`
**MCP Support:** `supported: true` (`toml` — `[mcp_servers.<name>]` in `~/.codex/config.toml` or `<project>/.codex/config.toml`)
**Scheduler Support:** `desktop-cloud-llm-automations` (`zeroTokenScriptCapable: false` — pair with OS scheduler `os-scheduler-and-tick-if-due`)

---

## 1. MCP Server Registration

Codex CLI, Desktop, and IDE Extension share `~/.codex/config.toml` (overridable via `CODEX_HOME`).

- **Native CLI install (recommended):**
  ```bash
  codex mcp add routersync -- routersync-mcp
  ```
- **TOML Ordering Rule:** Top-level keys (`model`, `model_provider`, `openai_base_url`, `model_catalog_json`) MUST remain above the first `[table]` header in `config.toml`. Always append `[mcp_servers.routersync]` at the end of `config.toml` and restart Codex to reload.

---

## 2. Direction A Model Sync (`report-only`)

Codex uses `directionAMode: report-only`:
- `[model_providers.<id>]` in `~/.codex/config.toml` defines provider endpoints (`base_url`, `wire_api`, `env_key`, `model_catalog_url`) rather than an inline per-provider `models[]` array.
- RouterSync keeps `~/.codex/config.toml` strictly `report-only` for Direction A model lists, preserving `model`, `model_provider`, `openai_base_url`, and `model_reasoning_effort` untouched.

---

## 3. Adaptive User Interview Protocol (`<= 12` Questions)

When running the RouterSync setup interview from Codex:
1. Use the `routersync_adaptive_interview` MCP prompt (`{ "harness": "codex" }`) or `profile_interview` (`{}`).
2. Ask **`<= 12` questions** in plain everyday language (`7..8` core questions; optional follow-ups up to `12` only for power-user customization).
3. Never request plaintext API keys or tokens in chat.
4. **Explicit `assumptions[]` & Zero Fabrication:**
   - Vague preference answers populate explicit `assumptions[]` entries with conservative defaults (`budget: "free-only"`, `automationLevel: "propose"`, `scanCycle: "daily"`).
   - Unstated factual inventory (`harnesses`, `routers`, `keyedProviders`, `favorites`, `allowList`) MUST remain `[]` — never guessed or fabricated.
5. Preview in memory via `profile_interview({ "answers": { ... } })` (`0` disk writes) before saving via `routersync profile interview --adaptive --answers <json> --write`.

---

## 4. Router Strategy & Combo Selection Workflow

1. Call `list_strategies` to inspect **9Router** (`fallback`, `round-robin`), **OmniRoute** (`priority`, `weighted`, `round-robin`), and **LiteLLM** (`fallbacks`, `simple-shuffle`, `least-busy`) capabilities.
2. Combo selection enforces `12` steps default (`15` for `free-only`, minimum `2`), hard exclusion of `DEAD`/`HANG` and all 5 non-chat specialist families (`embedding`, `audio`, `moderation`, `image-gen`, `rerank`), and cross-provider round-robin interleaving.
3. For LiteLLM `config.yaml`, use `routersync litellm inspect|plan|apply|rollback` for lossless YAML CST updates with `.routersync.bak` and read-back verification.

---

## 5. Standing Consent & Emergency Freeze Safety

- Default mode is **`propose`**.
- Upgrading to **`auto-safe`** requires **1 prior `propose` apply verified via read-back** (`C45 §3.2`) and an explicit consent expiry.
- Emergency stop is always available via `routersync freeze`.
