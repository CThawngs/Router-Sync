# Cursor IDE & Cursor CLI — RouterSync Integration & Skill Guide

**Harness ID:** `cursor`
**Display Name:** Cursor IDE (and Cursor CLI `agent`)
**Direction A Mode:** `report-only`
**MCP Support:** `supported: true` (`json` — `mcpServers` in `~/.cursor/mcp.json` or `<project>/.cursor/mcp.json`)
**Scheduler Support:** `cloud-automations-and-agent-sdk` (`zeroTokenScriptCapable: false` — use `os-scheduler-and-tick-if-due`)

---

## 1. MCP Server Registration

Cursor IDE and Cursor CLI (`agent`) share `~/.cursor/mcp.json` (`mcpServers`):

- **Native CLI install:**
  ```bash
  agent mcp add routersync -- routersync-mcp
  ```
- **Atomic JSON merge:** `routersync mcp install --harness cursor`
- **Reload:** Refresh MCP servers in *Cursor Settings > MCP* (or reload window).

---

## 2. Direction A Model Sync (`report-only`)

Cursor uses `directionAMode: report-only`:
- Cursor stores BYOK/model toggles inside its internal SQLite database (`state.vscdb`) owned by the running Electron app rather than a user-editable JSON/YAML catalog file.
- RouterSync never mutates `state.vscdb`; `routersync apps inspect` / `apps plan --app cursor` stays strictly read-only.

---

## 3. Adaptive User Interview Protocol (`<= 12` Questions)

When assisting a user with RouterSync inside Cursor:
1. Invoke the `routersync_adaptive_interview` MCP prompt (`{ "harness": "cursor" }`) or call `profile_interview` (`{}`).
2. Ask **`<= 12` questions** in plain everyday language (`7..8` core questions; up to `4` optional power-user questions).
3. Never ask for plaintext API keys or tokens.
4. **Explicit `assumptions[]` & Zero Fabrication:**
   - Vague preference answers (`"idk"`, `"whatever"`) apply conservative defaults (`budget: "free-only"`, `automationLevel: "propose"`, `scanCycle: "daily"`) and record each assumption in `assumptions[]`.
   - Never fabricate factual inventory (`harnesses`, `routers`, `keyedProviders`, `favorites`, `allowList`); leave unstated lists `[]`.
5. Validate in memory with `profile_interview({ "answers": { ... } })` (`0` disk writes) and present `routersync profile interview --adaptive --answers <json> --write`.

---

## 4. Router Strategy & Combo Selection Workflow

1. Call `list_strategies` to inspect **9Router** (`fallback`, `round-robin`), **OmniRoute** (`priority`, `weighted`, `round-robin`), and **LiteLLM** (`fallbacks`, `simple-shuffle`, `least-busy`) capabilities.
2. Select `2..12` chat steps (`2..15` for `free-only`), excluding `DEAD`/`HANG` models (`0%`, including `favorites`) and all 5 specialist non-chat model families (`embedding`, `audio`, `moderation`, `image-gen`, `rerank`), with cross-provider round-robin interleaving.
3. Because Cursor Cloud Automations consume LLM turns in the cloud, install local zero-token ticks via OS scheduler (`routersync schedule install --harness cursor --dry-run`).

---

## 5. Standing Consent & Emergency Freeze Safety

- Default mode is **`propose`**.
- Activating **`auto-safe`** requires **at least 1 completed `propose` apply with verified read-back** (`C45 §3.2`).
- Run `routersync freeze` at any time to immediately halt all controlled writes.
