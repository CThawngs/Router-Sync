# xAI Grok Bot & Companion Grok Build CLI — RouterSync Integration & Skill Guide

**Harness ID:** `grok-bot`
**Display Name:** xAI Grok Bot (Cloud) [companion local CLI: `grok-build` / `grok` CLI]
**Direction A Mode:** `report-only`
**MCP Support:** Cloud `grok-bot` has `format: unsupported` for local stdio (**no local stdio** MCP config file on disk; cloud connectors only accept public HTTPS endpoints). For local host MCP or CLI workflows, use the companion **`grok-build` (`grok` CLI)** (`~/.grok/config.toml`) or direct `routersync` CLI commands.
**Scheduler Support:** `cloud-llm-routines` (`zeroTokenScriptCapable: false` — use local `os-scheduler-and-tick-if-due`)

---

## 1. CLI & Companion Workflow (No Local Stdio MCP on Grok Bot Cloud)

Grok Bot runs on a persistent xAI cloud workspace and rejects `localhost` / private-IP MCP endpoints unless explicitly exposed through an authenticated HTTPS tunnel. Never invent a fake local MCP config path for `grok-bot`:

1. **Direct `routersync` CLI workflow (recommended on host):**
   ```bash
   routersync status --json
   routersync profile interview --adaptive --json
   routersync litellm inspect --config <path-to-litellm-config.yaml> --json
   ```
2. **Companion local `grok-build` (`grok` CLI) MCP registration (`~/.grok/config.toml`):**
   If the user installs xAI's local `grok` CLI (`GROK_HOME`), register RouterSync via:
   ```bash
   grok mcp add routersync -- routersync-mcp
   ```

---

## 2. Direction A Model Sync (`report-only`)

`grok-bot` uses `directionAMode: report-only`:
- Grok Bot Cloud selects backend models automatically per task and has no local model catalog file on disk.
- Companion `grok-build` stores `[models]` in `~/.grok/config.toml` (Tier B); RouterSync keeps `grok-bot` strictly `report-only`.

---

## 3. Adaptive User Interview Protocol (`<= 12` Questions)

When running the RouterSync setup interview via CLI or companion `grok` CLI:
1. Run `routersync profile interview --adaptive --json` (or `profile_interview` on companion `grok` CLI MCP) to fetch the core questions.
2. Ask **`<= 12` plain everyday questions** (`7..8` core questions; up to `4` optional power-user questions).
3. Never ask the user to paste API keys or secrets into chat.
4. **Explicit `assumptions[]` & Zero Fabrication:**
   - Vague preference answers (`"idk"`, `"not sure"`) default conservatively (`budget: "free-only"`, `automationLevel: "propose"`, `scanCycle: "daily"`) and record each assumption in `assumptions[]`.
   - Never fabricate factual inventory (`harnesses`, `routers`, `keyedProviders`, `favorites`, `allowList`); unstated lists remain `[]`.
5. Preview without writing (`routersync profile interview --adaptive --answers <json> --json`) and persist only when confirmed (`--write`).

---

## 4. Router Strategy & Combo Selection Workflow

1. Inspect routing strategies across **9Router** (`fallback`, `round-robin`), **OmniRoute** (`priority`, `weighted`, `round-robin`), and **LiteLLM** (`fallbacks`, `simple-shuffle`, `least-busy`).
2. Enforce `2..12` chat steps (`2..15` for `free-only`), `0%` `DEAD`/`HANG` models (even if in `favorites`), `0` non-chat specialists (`embedding`, `audio`, `moderation`, `image-gen`, `rerank`), and cross-provider round-robin interleaving.
3. Manage LiteLLM configs losslessly via `routersync litellm inspect|plan|apply|rollback`.

---

## 5. Standing Consent & Emergency Freeze Safety

- Default automation level is **`propose`**.
- **`auto-safe`** is gated behind **at least 1 completed `propose` apply with verified post-write read-back** (`C45 §3.2`).
- Run `routersync freeze` at any time to block all controlled writes immediately.
