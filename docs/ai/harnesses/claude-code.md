# Anthropic Claude Code — RouterSync Integration & Skill Guide

**Harness ID:** `claude-code`
**Display Name:** Anthropic Claude Code
**Direction A Mode:** `report-only`
**MCP Support:** `supported: true` (`json` — `mcpServers` in `~/.claude.json` or project `<project>/.mcp.json`)
**Scheduler Support:** `llm-prompt-schedulers` (`zeroTokenScriptCapable: false` — pair with OS scheduler `os-scheduler-and-tick-if-due`)

---

## 1. MCP Server Registration

Claude Code reads user-scoped MCP servers from `~/.claude.json` (`mcpServers`) and project-scoped servers from `<project>/.mcp.json` (note: `~/.claude/mcp.json` and `%APPDATA%/Claude/mcp.json` are not read by Claude Code).

- **Native CLI install (recommended):**
  ```bash
  claude mcp add --scope user routersync -- routersync-mcp
  ```
- **Reload:** Restart the Claude Code session after modifying `~/.claude.json`.

---

## 2. Direction A Model Sync (`report-only`)

Claude Code uses `directionAMode: report-only`:
- `~/.claude/settings.json` only pins single Anthropic model aliases or custom picker entries (`model`, `fallbackModel`, `availableModels`, `env.ANTHROPIC_DEFAULT_*`) rather than a multi-provider model catalog per keyed provider.
- RouterSync **never** mutates `~/.claude/settings.json` automatically; instead, `routersync apps inspect` / `apps plan --app claude-code` emits read-only drift and recommendation reports while preserving all user model slots.

---

## 3. Adaptive User Interview Protocol (`<= 12` Questions)

When assisting a user with RouterSync setup inside Claude Code:
1. Invoke the MCP prompt `routersync_adaptive_interview` (`{ "harness": "claude-code" }`) or call `profile_interview` (`{}`).
2. Keep the interview strictly **`<= 12` questions** (`7..8` friendly everyday questions by default; up to `4` optional follow-ups only for power users).
3. Never ask for raw API keys or secrets.
4. **Explicit `assumptions[]` & Zero Fabrication:**
   - On vague preference answers (`"not sure"`, `"idk"`), choose conservative defaults (`budget: "free-only"`, `automationLevel: "propose"`, `scanCycle: "daily"`) and record each assumption in `assumptions[]`.
   - **Never fabricate** `harnesses`, `routers`, `keyedProviders`, `favorites`, or `allowList` — keep unstated factual lists `[]` until confirmed by user input or read-only local inspection.
5. Call `profile_interview({ "answers": { ... } })` to validate in memory (`0` disk writes), then present `routersync profile interview --adaptive --answers <json> --write` for user confirmation.

---

## 4. Router Strategy & Combo Selection Workflow

1. Call `list_strategies` to inspect routing capabilities for **9Router** (`fallback`, `round-robin`), **OmniRoute** (`priority`, `weighted`, `round-robin`), and **LiteLLM** (`fallbacks`, `simple-shuffle`, `least-busy`).
2. Enforce combo hygiene: `12` steps max (`15` for `free-only`, floor `2`), `0` `DEAD`/`HANG` models (even if in `favorites`), `0` specialist non-chat models (`embedding`, `audio`, `moderation`, `image-gen`, `rerank`), and cross-provider round-robin interleaving.
3. Because Claude Code's `/loop` and `/schedule` consume LLM tokens, schedule zero-token RouterSync ticks via OS scheduler (`routersync schedule install --harness claude-code --dry-run`).

---

## 5. Standing Consent & Emergency Freeze Safety

- Default automation level is **`propose`**.
- **`auto-safe`** cannot activate on any target until **at least 1 `propose` apply has succeeded with verified read-back** (`C45 §3.2`).
- Run `routersync freeze` at any time to block all controlled writes immediately.
