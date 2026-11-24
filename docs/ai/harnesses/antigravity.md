# Google Antigravity — RouterSync Integration & Skill Guide

**Harness ID:** `antigravity`
**Display Name:** Google Antigravity (App, IDE, CLI `agy`, SDK)
**Direction A Mode:** `report-only`
**MCP Support:** `supported: true` (`json` — `mcpServers` in `~/.gemini/config/mcp_config.json` or `<workspace>/.agents/mcp_config.json`)
**Scheduler Support:** `sidecar-schedule-builtin` (`zeroTokenScriptCapable: true` via `builtin: "schedule"` sidecar, paired with `os-scheduler`)

---

## 1. MCP Server Registration

Antigravity reads global MCP servers from `~/.gemini/config/mcp_config.json` (`mcpServers`; legacy `~/.gemini/antigravity/mcp_config.json` is obsolete).

- **JSON entry rule:** Do **not** add a `"type"` field on stdio entries in `mcp_config.json`:
  ```json
  {
    "mcpServers": {
      "routersync": {
        "command": "routersync-mcp",
        "args": []
      }
    }
  }
  ```
- **Reload:** Restart the MCP server under *Customizations > Installed > MCP Servers* (or restart Antigravity).

---

## 2. Direction A Model Sync (`report-only`)

Antigravity uses `directionAMode: report-only`:
- Antigravity App/IDE/CLI serves a Google-curated model catalog controlled by account tier/quotas in *Settings > Models*, while `~/.gemini/config/config.json` only stores `userSettings.orchestratorModel` / `userSettings.orchestratorExecutorModel` and is owned by the running app.
- RouterSync never edits Antigravity's internal model config on disk.

---

## 3. Adaptive User Interview Protocol (`<= 12` Questions)

When conducting the RouterSync user interview in Antigravity:
1. Run the `routersync_adaptive_interview` MCP prompt (`{ "harness": "antigravity" }`) or call `profile_interview` (`{}`).
2. Ask **at most `12` questions** (`7..8` core everyday questions; optional follow-ups up to `12` only for power users).
3. Never ask for API keys or secrets.
4. **Explicit `assumptions[]` & Zero Fabrication:**
   - Vague preference answers (`"idk"`, `"default"`) record explicit `assumptions[]` entries with safe defaults (`budget: "free-only"`, `automationLevel: "propose"`, `scanCycle: "daily"`).
   - Never fabricate factual inventory (`harnesses`, `routers`, `keyedProviders`, `favorites`, `allowList`); keep unstated lists `[]`.
5. Validate via `profile_interview({ "answers": { ... } })` (`0` disk writes) and provide the CLI command `routersync profile interview --adaptive --answers <json> --write`.

---

## 4. Router Strategy & Combo Selection Workflow

1. Call `list_strategies` to inspect **9Router** (`fallback`, `round-robin`), **OmniRoute** (`priority`, `weighted`, `round-robin`), and **LiteLLM** (`fallbacks`, `simple-shuffle`, `least-busy`) capabilities.
2. Select `2..12` chat steps (`2..15` for `free-only`), excluding `DEAD`/`HANG` models (`0%`, even if in `favorites`) and all 5 specialist non-chat model families (`embedding`, `audio`, `moderation`, `image-gen`, `rerank`), interleaved round-robin across providers.
3. For zero-token background ticks while Antigravity runs, configure a `builtin: "schedule"` sidecar (not `/automation`, which starts LLM conversations) paired with `os-scheduler`.

---

## 5. Standing Consent & Emergency Freeze Safety

- Default mode is **`propose`**.
- Transitioning to **`auto-safe`** requires **at least 1 prior `propose` apply with verified post-write read-back** (`C45 §3.2`).
- Run `routersync freeze` at any time to immediately block all writes.
